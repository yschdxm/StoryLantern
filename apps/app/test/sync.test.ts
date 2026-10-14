import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalOpPorts } from '../src/data/op-ports.ts';
import { createOpLogRepository, type OpLogRepository } from '../src/data/op-repository.ts';
import { createMemoryKeyValue } from '../src/data/local-repository.ts';
import { createSyncService, syncAvailable, type SyncStorePort } from '../src/data/sync/service.ts';
import { deviceSyncStore } from '../src/data/sync/app-sync.ts';
import { emptyState } from '../../../packages/sync-core/src/state.ts';
import type { SyncBackend, BackendEntry, ListResult, PutResult } from '../../../packages/sync-core/src/backend.ts';
import type { LocalSyncState } from '../../../packages/sync-core/src/state.ts';

/**
 * 两个"设备"通过一个哑存储同步：**并发编辑必须收敛到同一结果**。
 *
 * 这里用的是真实链路：op 仓储（日志即事实源）+ 同步引擎 + WebCrypto 加密端口，
 * 只把"远端存储"换成内存实现。所以它验证的是产品代码，不是模型。
 */

/** 内存哑存储：只有列目录/读/写/删，没有锁、没有事务——和网盘目录一个样。 */
function createMemoryBackend(): SyncBackend {
  const files = new Map<string, Uint8Array>();

  return {
    id: 'memory',
    capabilities: { conditionalPut: true, rangeRead: true, delete: true, listPagination: false, watch: false },
    async list(prefix: string): Promise<ListResult> {
      const entries: BackendEntry[] = [];
      for (const [path, bytes] of files) {
        if (path.startsWith(prefix)) entries.push({ path, size: bytes.length });
      }
      entries.sort((a, b) => a.path.localeCompare(b.path));
      return { entries };
    },
    async get(path: string): Promise<Uint8Array> {
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`404 ${path}`);
      return bytes;
    },
    async put(path: string, bytes: Uint8Array, options?: { ifNoneMatch?: boolean }): Promise<PutResult> {
      if (options?.ifNoneMatch === true && files.has(path)) return { ok: true, exists: true };
      files.set(path, bytes);
      return { ok: true };
    },
    async delete(path: string): Promise<void> {
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
  store: SyncStorePort;
  sync: () => Promise<{ uploaded: number; downloaded: number; appliedOps: number }>;
}

async function createDevice(name: string, backend: SyncBackend, secret: string): Promise<Device> {
  const ports = createLocalOpPorts(createMemoryKeyValue());
  const repository = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: name });
  await repository.ready;
  const store = createMemorySyncStore();
  const service = await createSyncService({ repository, backend, deviceId: name, secret, store, device: ports.device });
  return {
    name,
    repository,
    store,
    sync: async () => {
      const summary = await service.sync();
      return { uploaded: summary.uploaded, downloaded: summary.downloaded, appliedOps: summary.appliedOps };
    },
  };
}

/** 两个设备"最终一致"的判据：角色/会话/消息逐字段相同。 */
async function fingerprint(repository: OpLogRepository): Promise<string> {
  const characters = await repository.characters.list();
  const sessions = await repository.sessions.list();
  const messages = sessions.flatMap((session) => [session.id, session.title]);
  const rows = await Promise.all(
    sessions.map(async (session) => (await repository.messages.list(session.id)).map((message) => `${message.role}:${message.content}`)),
  );
  return JSON.stringify({
    characters: characters.map((character) => [character.name, character.description, character.personality, character.scenario]),
    sessions: messages,
    messages: rows,
  });
}

test('同步：WebCrypto 在这个环境可用（真机若不可用会明确报错，而不是静默不加密）', () => {
  assert.equal(syncAvailable(), true, 'Node 24 有 WebCrypto；Android WebView 需要安全上下文');
});

test('同步：A 的数据能同步到空的 B，B 的写入能回到 A', async () => {
  const backend = createMemoryBackend();
  const secret = 'correct horse battery staple';
  const a = await createDevice('device-a', backend, secret);
  const b = await createDevice('device-b', backend, secret);

  // A：一个角色 + 一个会话 + 两句对话
  const character = await a.repository.characters.save({ name: '星野', description: '夜巡的守望者', firstMessage: '「进来吧。」' });
  const session = await a.repository.sessions.create(character.id, '隘口之夜');
  await a.repository.messages.append(session.id, 'user', '风大吗');

  const first = await a.sync();
  assert.ok(first.uploaded > 0, 'A 应当把段推上去');
  assert.equal(first.appliedOps, 0);

  // B：全新设备，同步后应当看到全部内容
  const second = await b.sync();
  assert.ok(second.downloaded > 0, 'B 应当拉到段');
  const characters = await b.repository.characters.list();
  assert.deepEqual(characters.map((item) => item.name), ['星野']);
  assert.equal(characters[0]?.description, '夜巡的守望者');
  const sessions = await b.repository.sessions.list();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.characterName, '星野');
  const messages = await b.repository.messages.list(sessions[0]?.id ?? '');
  assert.deepEqual(messages.map((message) => message.content), ['「进来吧。」', '风大吗']);

  // B 回一句 → 同步 → A 应当看到
  await b.repository.messages.append(sessions[0]?.id ?? '', 'assistant', '风从北面来。');
  await b.sync();
  await a.sync();
  const afterMessages = await a.repository.messages.list(session.id);
  assert.deepEqual(afterMessages.map((message) => message.content), ['「进来吧。」', '风大吗', '风从北面来。']);
});

test('同步：两台设备并发改同一个角色 → 双方收敛到同一个结果（后写的赢，且不丢数据）', async () => {
  const backend = createMemoryBackend();
  const secret = 'shared secret';
  const a = await createDevice('device-a', backend, secret);
  const b = await createDevice('device-b', backend, secret);

  const created = await a.repository.characters.save({ name: '星野', description: '原设定' });
  await a.sync();
  await b.sync();

  // 两边都改（谁都不知道对方改了）：更新要带上名字（仓储的校验要求）
  await a.repository.characters.save({ id: created.id, name: '星野', description: 'A 改的' });
  await b.repository.characters.save({ id: created.id, name: '星野', description: 'B 改的' });

  await a.sync();
  await b.sync();
  await a.sync(); // 再同步一轮，让两边都拿到对方的段

  const fromA = (await a.repository.characters.list())[0]?.description;
  const fromB = (await b.repository.characters.list())[0]?.description;
  assert.equal(fromA, fromB, '两台设备的最终状态必须一致');
  assert.ok(fromA === 'A 改的' || fromA === 'B 改的', `赢家必须是两边之一（实际 ${String(fromA)}）`);

  assert.equal(await fingerprint(a.repository), await fingerprint(b.repository), '整套状态逐字段一致');
});

test('同步：并发新建同一个会话里的消息 → 两边都保留（不覆盖，按时间排序一致）', async () => {
  const backend = createMemoryBackend();
  const secret = 'shared secret';
  const a = await createDevice('device-a', backend, secret);
  const b = await createDevice('device-b', backend, secret);

  const character = await a.repository.characters.save({ name: '星野' });
  const session = await a.repository.sessions.create(character.id, '并行');
  await a.sync();
  await b.sync();

  const sessionOnB = (await b.repository.sessions.list())[0];
  assert.ok(sessionOnB !== undefined);

  // 两台设备各自往同一个会话追加一条（真正并发）
  await a.repository.messages.append(session.id, 'user', 'A 说的');
  await b.repository.messages.append(sessionOnB.id, 'user', 'B 说的');

  await a.sync();
  await b.sync();
  await a.sync();

  const messagesA = (await a.repository.messages.list(session.id)).map((message) => message.content);
  const messagesB = (await b.repository.messages.list(sessionOnB.id)).map((message) => message.content);
  assert.deepEqual(messagesA, messagesB, '两边消息顺序与内容必须一致');
  assert.ok(messagesA.includes('A 说的') && messagesA.includes('B 说的'), '两条都不能丢');
});

test('同步：口令不同的设备读不出也改不了（AEAD 拒绝）', async () => {
  const backend = createMemoryBackend();
  const a = await createDevice('device-a', backend, 'the right secret');
  const intruder = await createDevice('device-c', backend, 'the wrong secret');

  const character = await a.repository.characters.save({ name: '秘密角色' });
  await a.repository.sessions.create(character.id, '私密会话');
  await a.sync();

  await intruder.sync();
  assert.deepEqual(await intruder.repository.characters.list(), [], '错误口令不该读出任何内容');
  const problems = await intruder.repository.logStats();
  assert.equal(problems.count, 0, '解不开的段不该被写进本地日志');
});

test('同步：重复同步是幂等的（第二次不产生新的本地 op）', async () => {
  const backend = createMemoryBackend();
  const a = await createDevice('device-a', backend, 'secret');
  const b = await createDevice('device-b', backend, 'secret');

  await a.repository.characters.save({ name: '星野', firstMessage: '「进来吧。」' });
  await a.sync();
  await b.sync();
  const afterFirst = (await b.repository.logStats()).count;
  assert.ok(afterFirst > 0);

  await b.sync();
  await b.sync();
  assert.equal((await b.repository.logStats()).count, afterFirst, '重复拉取不会重复写日志（按 opId 幂等）');
});

test('同步：换远端时进度按远端分桶，且清单序号继续递增（真机上踩过）', async () => {
  const ports = createLocalOpPorts(createMemoryKeyValue());
  const store = deviceSyncStore(ports.device, 'webdav:https://nas/a');

  // 先在远端 A 上同步过：有段清单与游标
  const hosted = { B1: { lastSeq: 3, segments: { 1: 'aa', 2: 'bb', 3: 'cc' }, bytes: 100, epoch: 0, segmentsSinceSnapshot: 0 } };
  await store.save({
    state: { ...emptyState(), manifestSeq: 7, hosted, cursors: { 'me|B1': 3 }, outbox: [] },
    enqueuedSeq: 42,
  });
  const same = await store.load();
  assert.equal(same.enqueuedSeq, 42);
  assert.equal(same.state?.manifestSeq, 7);

  // 换到远端 B（例如从 WebDAV 换成文件夹）：内容进度必须从零开始，
  // 否则会发一份"引用了 A 上段"的清单出去，对端每次都报"缺少第 N 号段"。
  const other = deviceSyncStore(ports.device, 'folder:/tmp/storylantern');
  const fresh = await other.load();
  assert.equal(fresh.enqueuedSeq, 0, '换远端要重新推送本地内容');
  assert.deepEqual(fresh.state?.hosted, {}, '不能沿用旧远端的段清单');
  assert.equal(fresh.state?.manifestSeq, 7, '清单序号是设备级的，必须继续递增（对端据此判断是否被还原）');

  // 换回远端 A：原来的进度还在
  const back = await store.load();
  assert.equal(back.enqueuedSeq, 42);
  assert.deepEqual(back.state?.hosted, hosted);
});

test('同步：世界书与条目也会跟着过去（两设备读到的书完全一致）', async () => {
  const backend = createMemoryBackend();
  const a = await createDevice('device-a', backend, 'secret');
  const b = await createDevice('device-b', backend, 'secret');

  const character = await a.repository.characters.save({ name: '星野' });
  const book = await a.repository.lorebooks.save({ name: '隘口的设定', characterIds: [character.id] });
  await a.repository.lorebooks.saveEntry({
    lorebookId: book.id,
    keys: ['铜铃'],
    content: '铜铃是隘口的报信之物。',
    order: 5,
  });
  await a.sync();

  await b.sync();
  const onB = await b.repository.lorebooks.list();
  assert.equal(onB.length, 1);
  assert.equal(onB[0]?.name, '隘口的设定');
  assert.equal(onB[0]?.entries.length, 1);
  assert.deepEqual(onB[0]?.entries[0]?.keys, ['铜铃']);
  assert.equal(onB[0]?.entries[0]?.order, 5);
  assert.deepEqual(onB[0]?.characterIds, [character.id], '角色绑定关系也要一致');

  // B 改条目 → A 收得到（条目级 LWW，不整本覆盖）
  const entryId = onB[0]?.entries[0]?.id ?? '';
  await b.repository.lorebooks.saveEntry({ lorebookId: book.id, id: entryId, content: '改过的正文' });
  await b.sync();
  await a.sync();
  const onA = await a.repository.lorebooks.get(book.id);
  assert.equal(onA?.entries[0]?.content, '改过的正文');
  assert.deepEqual(
    await b.repository.lorebooks.forCharacter(character.id).then((books) => books.map((item) => item.name)),
    await a.repository.lorebooks.forCharacter(character.id).then((books) => books.map((item) => item.name)),
    '两台设备按角色筛出来的书必须一样',
  );
});
