import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalOpPorts } from '../src/data/op-ports.ts';
import { createOpLogRepository, type OpLogRepository } from '../src/data/op-repository.ts';
import { createMemoryKeyValue } from '../src/data/local-repository.ts';
import { createFolderBackend, type FilePort } from '../src/data/sync/folder-backend.ts';
import { createSyncService, type SyncStorePort } from '../src/data/sync/service.ts';
import type { LocalSyncState } from '../../../packages/sync-core/src/state.ts';

/**
 * "同步到本地文件夹"的端到端验证。
 *
 * 远端的角色由内存文件系统扮演（`FilePort` 的内存实现），链路是真实的：
 * op 仓储 → 同步引擎 → WebCrypto 加密 → 文件夹后端。
 * 宿主那一侧的边界（路径不许逃出根目录等）在 Rust 里，另有注释说明。
 */

/** 内存文件系统：`devices/a.json` 这种路径 → 字节。 */
function createMemoryFiles(): FilePort {
  const files = new Map<string, Uint8Array>();

  return {
    async list(prefix) {
      const normalized = prefix.replace(/\/+$/, '');
      const out: Array<{ path: string; size: number }> = [];
      for (const [path, bytes] of files) {
        if (normalized === '' || path.startsWith(normalized)) out.push({ path, size: bytes.length });
      }
      out.sort((left, right) => left.path.localeCompare(right.path));
      return out;
    },
    async read(path) {
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`not-found ${path}`);
      return bytes;
    },
    async write(path, bytes, options) {
      const exists = files.has(path);
      if (exists && options?.ifNoneMatch === true) return { ok: true, exists: true };
      files.set(path, bytes);
      return { ok: true, exists };
    },
    async delete(path) {
      files.delete(path);
    },
  };
}

function createMemorySyncStore(): SyncStorePort {
  let saved: { state?: LocalSyncState; enqueuedSeq: number } = { enqueuedSeq: 0 };
  return {
    async load() {
      return saved;
    },
    async save(input) {
      saved = input;
    },
  };
}

interface Device {
  name: string;
  repository: OpLogRepository;
  sync: () => Promise<{ uploaded: number; downloaded: number; appliedOps: number }>;
}

/**
 * 同一个文件夹（= 同一个共享目录）里的设备登记表。
 *
 * 按设计，新设备写 join 请求后需要一台**已授权设备**同步一轮来接纳它（把数据钥匙包给它）。
 * 夹具自动补这一轮，让测试关注"数据是否真的同步过去"。
 */
const JOIN_PEERS = new WeakMap<FilePort, Device[]>();

async function createDevice(name: string, files: FilePort, secret: string): Promise<Device> {
  const ports = createLocalOpPorts(createMemoryKeyValue());
  const repository = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: name });
  await repository.ready;
  const service = await createSyncService({
    repository,
    backend: createFolderBackend(files),
    deviceId: name,
    secret,
    store: createMemorySyncStore(),
    device: ports.device,
  });
  const device: Device = {
    name,
    repository,
    sync: async () => {
      let summary = await service.sync();
      if (summary.warnings.some((warning) => warning.includes('加入请求'))) {
        for (const peer of JOIN_PEERS.get(files) ?? []) {
          // 跳过自己：否则会递归（我等待接纳 → 又调我自己）
          if (peer.name !== name) await peer.sync();
        }
        summary = await service.sync();
      }
      return { uploaded: summary.uploaded, downloaded: summary.downloaded, appliedOps: summary.appliedOps };
    },
  };
  const peers = JOIN_PEERS.get(files) ?? [];
  peers.push(device);
  JOIN_PEERS.set(files, peers);
  return device;
}

test('文件夹同步：A 的数据经加密段落到文件夹，B 读得到（含消息与角色）', async () => {
  const files = createMemoryFiles();
  const secret = 'folder-shared-secret';
  const a = await createDevice('folder-a', files, secret);
  const b = await createDevice('folder-b', files, secret);

  const character = await a.repository.characters.save({ name: '星野', firstMessage: '「进来吧。」' });
  const session = await a.repository.sessions.create(character.id, '隘口之夜');
  await a.repository.messages.append(session.id, 'user', '风大吗');

  const first = await a.sync();
  assert.ok(first.uploaded > 0, 'A 应当把段写进文件夹');

  const second = await b.sync();
  assert.ok(second.downloaded > 0, 'B 应当从文件夹读到段');
  assert.equal((await b.repository.characters.list())[0]?.name, '星野');
  const sessionOnB = (await b.repository.sessions.list())[0];
  assert.equal(sessionOnB?.title, '隘口之夜');
  assert.deepEqual(
    (await b.repository.messages.list(sessionOnB?.id ?? '')).map((message) => message.content),
    ['「进来吧。」', '风大吗'],
  );
});

test('文件夹同步：两台设备各写一半，最终两边一致（含世界书）', async () => {
  const files = createMemoryFiles();
  const secret = 'folder-shared-secret';
  const a = await createDevice('folder-a', files, secret);
  const b = await createDevice('folder-b', files, secret);

  const character = await a.repository.characters.save({ name: '星野' });
  await a.repository.sessions.create(character.id, '隘口之夜');
  await a.sync();
  await b.sync();

  // A 加一条世界书设定，B 加一条消息：两边互不知情
  const book = await a.repository.lorebooks.save({ name: '隘口', characterIds: [character.id] });
  await a.repository.lorebooks.saveEntry({ lorebookId: book.id, keys: ['铃'], content: '铃是报信之物。' });
  const sessionOnB = (await b.repository.sessions.list())[0];
  assert.ok(sessionOnB !== undefined);
  await b.repository.messages.append(sessionOnB.id, 'user', 'B 说的');

  await a.sync();
  await b.sync();
  await a.sync();

  const booksOnA = await a.repository.lorebooks.list();
  const booksOnB = await b.repository.lorebooks.list();
  assert.deepEqual(booksOnA.map((book) => book.name), ['隘口']);
  assert.deepEqual(booksOnB.map((book) => book.name), ['隘口']);
  assert.deepEqual(booksOnB[0]?.entries.map((entry) => entry.content), ['铃是报信之物。']);

  const messagesOnA = (await a.repository.messages.list((await a.repository.sessions.list())[0]?.id ?? '')).map((m) => m.content);
  const messagesOnB = (await b.repository.messages.list(sessionOnB.id)).map((m) => m.content);
  assert.deepEqual(messagesOnA, messagesOnB);
  assert.ok(messagesOnA.includes('B 说的'));
});

test('文件夹同步：文件布局就是"每台设备写自己的命名空间"（哑存储不参与协商）', async () => {
  const files = createMemoryFiles();
  const a = await createDevice('folder-a', files, 'secret');
  await a.repository.characters.save({ name: '星野', firstMessage: '「进来吧。」' });
  await a.sync();

  const entries = await files.list('');
  const paths = entries.map((entry) => entry.path).sort();
  assert.ok(paths.some((path) => path.startsWith('devices/folder-a-')), `应有自己的清单：${paths.join(', ')}`);
  assert.ok(paths.some((path) => path.startsWith('logs/folder-a/')), '段落在自己的命名空间里');
  assert.ok(!paths.some((path) => path.includes('folder-b')), '不该碰别人的命名空间');
});
