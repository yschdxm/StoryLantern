import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalOpPorts } from '../src/data/op-ports.ts';
import { createOpLogRepository } from '../src/data/op-repository.ts';
import { createMemoryKeyValue } from '../src/data/local-repository.ts';
import { createSyncService, type SyncService } from '../src/data/sync/service.ts';
import { KEYRING_FILE, parseKeyring } from '../../../packages/sync-core/src/keyring.ts';
import type { SyncBackend, BackendEntry, ListResult, PutResult } from '../../../packages/sync-core/src/backend.ts';
import type { SyncStorePort } from '../src/data/sync/service.ts';
import type { LocalSyncState } from '../../../packages/sync-core/src/state.ts';

/**
 * `service.ban()` 的**端到端**覆盖。
 *
 * 为什么专门加这一条：真机上点「永久禁用」后 `keyring.json` 仍是 epoch 1（详见 docs/M2-STATUS.md），
 * 需要判定"是点击没中"还是"实现有 bug"。这个测试走的是设备上走的同一段代码
 * （`ban` → 写黑名单 → `rotateKeyring` → 落盘），所以它红就是实现的锅、绿就是点击的锅。
 *
 * 断言三件事：名单里标为已永久禁用 / keyring 换代 / entries 只剩留下的设备。
 */

function memoryBackend(): SyncBackend & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    id: 'memory',
    capabilities: { conditionalPut: true, rangeRead: true, delete: true, listPagination: false, watch: false },
    async list(prefix: string): Promise<ListResult> {
      const entries: BackendEntry[] = [...files.entries()]
        .filter(([path]) => path.startsWith(prefix))
        .map(([path, bytes]) => ({ path, size: bytes.length }));
      return { entries };
    },
    async get(path: string): Promise<Uint8Array> {
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`404 找不到 ${path}`);
      return bytes;
    },
    async put(path: string, bytes: Uint8Array, options?: { ifNoneMatch?: boolean }): Promise<PutResult> {
      if (options?.ifNoneMatch === true && files.has(path)) return { ok: false, exists: true };
      files.set(path, bytes);
      return { ok: true };
    },
  };
}

/** 内存版的同步进度存储（测试用，和 sync.test.ts 里的那份同形）。 */
function createMemorySyncStore(): SyncStorePort {
  let saved: { state?: LocalSyncState; enqueuedSeq: number } = { enqueuedSeq: 0 };
  return {
    async load() {
      return saved;
    },
    async save(input) {
      saved = { state: input.state, enqueuedSeq: input.enqueuedSeq };
    },
  };
}

interface Device {
  name: string;
  service: SyncService;
}

async function createDevice(name: string, backend: SyncBackend, secret: string): Promise<Device> {
  const ports = createLocalOpPorts(createMemoryKeyValue());
  const repository = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: name });
  await repository.ready;
  const service = await createSyncService({
    repository,
    backend,
    deviceId: name,
    secret,
    store: createMemorySyncStore(),
    device: ports.device,
  });
  return { name, service };
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

test('永久禁用：ban() 写黑名单**并且换代**（keyring epoch+1、entries 只剩留下的设备）', async () => {
  const backend = memoryBackend();
  const a = await createDevice('dev-a', backend, 'shared-secret');
  const b = await createDevice('dev-b', backend, 'shared-secret');

  // 让 b 走完"加入"：a 建号 → b 写请求 → a 接纳 → b 拿到钥匙
  await a.service.sync();
  await b.service.sync();
  await a.service.sync();
  await b.service.sync();

  const before = parseKeyring(decode(await backend.get(KEYRING_FILE)));
  assert.equal(before.entries.length, 2, '两轮之后 keyring 应覆盖两台设备');

  const banned = await a.service.ban('dev-b');
  assert.equal(banned, true, 'ban 应当返回成功');

  const after = parseKeyring(decode(await backend.get(KEYRING_FILE)));
  assert.equal(after.epoch, before.epoch + 1, '**必须换代**：新数据钥匙只发给留下的人');
  assert.deepEqual(
    after.entries.map((entry) => entry.deviceId),
    ['dev-a'],
    '被禁用的人不能留在 keyring 里（它解不出新内容）',
  );

  const devices = await a.service.devices();
  assert.equal(devices.find((device) => device.deviceId === 'dev-b')?.banned, true, '名单里要标为已永久禁用');
});

test('永久禁用：被禁用的人后来发加入请求也进不来（黑名单优先）', async () => {
  const backend = memoryBackend();
  const a = await createDevice('dev-a', backend, 'shared-secret');
  const b = await createDevice('dev-b', backend, 'shared-secret');
  await a.service.sync();
  await b.service.sync();
  await a.service.sync();
  await b.service.sync();

  await a.service.ban('dev-b');
  const afterBan = parseKeyring(decode(await backend.get(KEYRING_FILE)));

  // b 再跑两轮：它应该只会写加入请求，而且 a **不接纳**（名单里仍在黑名单）
  await b.service.sync();
  await a.service.sync();
  await b.service.sync();

  const final = parseKeyring(decode(await backend.get(KEYRING_FILE)));
  assert.equal(final.epoch, afterBan.epoch, '不该为被禁用的人换代或加条目');
  assert.deepEqual(
    final.entries.map((entry) => entry.deviceId),
    ['dev-a'],
    '被禁用的人即便知道口令也拿不到新钥匙',
  );
});

test('自愈：keyring 里还留着已被永久禁用的设备时，下一次同步会换代把它剔掉', async () => {
  const backend = memoryBackend();
  const a = await createDevice('dev-a', backend, 'shared-secret');
  const b = await createDevice('dev-b', backend, 'shared-secret');
  await a.service.sync();
  await b.service.sync();
  await a.service.sync();
  await b.service.sync();

  await a.service.ban('dev-b');
  const afterBan = parseKeyring(decode(await backend.get(KEYRING_FILE)));

  // 模拟"拉黑时换代失败（或写完被别的设备回滚）"：把带 dev-b 的旧 keyring 写回去
  const stale = { ...afterBan, entries: [...afterBan.entries, { deviceId: "dev-b", wrapped: "stale" }] };
  await backend.put(KEYRING_FILE, new TextEncoder().encode(JSON.stringify(stale)));

  // 下一次同步应当自愈：换代并把被禁的设备剔掉
  await a.service.sync();
  const healed = parseKeyring(decode(await backend.get(KEYRING_FILE)));
  assert.equal(healed.epoch > afterBan.epoch, true, "应当再换代一次");
  assert.equal(
    healed.entries.some((entry) => entry.deviceId === "dev-b"),
    false,
    "被永久禁用的设备不能留在钥匙包里",
  );
});
