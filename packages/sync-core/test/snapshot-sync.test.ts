import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageAppend } from '../../oplog/src/op.ts';
import { createWorld, emit, freeze, messageIds } from './world.ts';

const A = 'device-a';
const B = 'device-b';

/** 让 A 逐个 sync，从而为同一会话累积出多个段。 */
async function publishSegments(world: ReturnType<typeof createWorld>, count: number): Promise<void> {
  const a = world.peer(A);
  for (let index = 0; index < count; index += 1) {
    emit(
      a,
      messageAppend(a, {
        sessionId: 'S1',
        messageId: `M${String(index).padStart(3, '0')}`,
        author: 'user',
        content: `第 ${index} 条历史消息`,
      }),
    );
    await world.sync(A);
  }
}

test('首次同步：有快照时只下一次快照，而不是逐段重放历史', async () => {
  const world = createWorld({ snapshotThreshold: 0 }); // 先关掉自动快照，手动控制
  const a = world.peer(A);
  await publishSegments(world, 12);

  const segmentsUploaded = a.engine.counters.paths.filter((path) => path.startsWith('logs/'));
  assert.ok(segmentsUploaded.length >= 12, `A 应当发布了至少 12 个段，实际 ${segmentsUploaded.length}`);

  const snapshot = await a.engine.publishSnapshot(a.materializer, 'S1');
  assert.ok(snapshot, '快照应当发布成功');
  assert.ok(snapshot.path.startsWith('snapshots/'));

  const b = world.peer(B);
  b.engine.counters.listPrefixes.length = 0;
  const result = await world.sync(B);

  assert.equal(result.hydratedSessions, 1, '应当用快照补课');
  assert.equal(result.hydratedMessages, 12, '12 条历史消息应来自快照');
  assert.deepEqual(
    result.downloaded.filter((path) => path.startsWith('logs/')),
    [],
    '不应再逐段下载历史',
  );
  assert.equal(result.downloaded.length, 1, '下载内容应当只有那一份快照');
  assert.deepEqual(messageIds(b), a.materializer.orderOf('S1').map((m) => m.id));
  assert.equal(freeze(b), freeze(a));
  assert.deepEqual(result.warnings, []);
});

test('快照损坏时退回逐段重放，不影响正确性', async () => {
  const world = createWorld({ snapshotThreshold: 0 });
  await publishSegments(world, 6);
  const a = world.peer(A);
  const snapshot = await a.engine.publishSnapshot(a.materializer, 'S1');
  assert.ok(snapshot);

  // 模拟存储方把快照写坏
  world.backend.seed(snapshot.path, new Uint8Array([1, 2, 3, 4]));

  const b = world.peer(B);
  const result = await world.sync(B);

  assert.ok(
    result.warnings.some((warning) => warning.includes('快照不可用')),
    `应告警快照不可用，实际：${result.warnings.join(' | ')}`,
  );
  assert.ok(result.downloaded.some((path) => path.startsWith('logs/')), '应退回逐段下载');
  assert.deepEqual(messageIds(b).length, 6);
  assert.equal(freeze(b), freeze(a), '退路也必须收敛到同一状态');
});

test('自动快照：段数达到阈值即自动发布（无需用户操作）', async () => {
  const world = createWorld({ snapshotThreshold: 2 });
  const a = world.peer(A);

  emit(a, messageAppend(a, { sessionId: 'S1', messageId: 'M0', author: 'user', content: '一' }));
  const first = await world.sync(A);
  assert.equal(first.uploaded.some((path) => path.startsWith('snapshots/')), false, '阈值未到不写快照');

  emit(a, messageAppend(a, { sessionId: 'S1', messageId: 'M1', author: 'user', content: '二' }));
  const second = await world.sync(A);
  assert.equal(second.uploaded.some((path) => path.startsWith('snapshots/')), true, '达到阈值应自动写快照');
  assert.ok(a.engine.state.hosted[Object.keys(a.engine.state.hosted)[0] as string]?.snapshot !== undefined);

  // 新设备应当直接用快照
  const b = world.peer(B);
  const pulled = await world.sync(B);
  assert.equal(pulled.hydratedSessions, 1);
  assert.deepEqual(messageIds(b), ['M0', 'M1']);
});

test('懒加载：shouldPull 之外的会话本轮完全不拉（不下载、不补课）', async () => {
  const world = createWorld({ snapshotThreshold: 0, shouldPull: () => false });
  await publishSegments(world, 3);
  const a = world.peer(A);
  await a.engine.publishSnapshot(a.materializer, 'S1');

  const b = world.peer(B);
  const result = await world.sync(B);
  assert.deepEqual(result.downloaded, []);
  assert.equal(result.hydratedSessions, 0);
  assert.deepEqual(messageIds(b), []);
});
test('只留最新一份快照：发布新的之后，旧的那份必须被删掉（否则存储只增不减）', async () => {
  // 阈值 1：每发一个段就触发一次快照，便于观察"旧的有没有被清掉"
  const world = createWorld({ snapshotThreshold: 1 });
  const a = world.peer(A);

  emit(a, messageAppend(a, { sessionId: 'S1', messageId: 'M0', author: 'user', content: '一' }));
  await world.sync(A);
  const blind = Object.keys(a.engine.state.hosted)[0] as string;
  const firstHash = a.engine.state.hosted[blind]?.snapshot?.hash;
  assert.ok(firstHash !== undefined, '第一份快照应当已发布');
  const firstPath = 'snapshots/' + blind + '/' + firstHash + '.json.gz';
  assert.equal(world.backend.files.has(firstPath), true, '第一份快照应当在存储里');

  emit(a, messageAppend(a, { sessionId: 'S1', messageId: 'M1', author: 'user', content: '二' }));
  await world.sync(A);
  const secondHash = a.engine.state.hosted[blind]?.snapshot?.hash;
  assert.ok(secondHash !== undefined && secondHash !== firstHash, '第二份快照应当是另一个内容地址');
  const secondPath = 'snapshots/' + blind + '/' + secondHash + '.json.gz';
  assert.equal(world.backend.files.has(secondPath), true, '新快照在');
  assert.equal(world.backend.files.has(firstPath), false, '旧快照必须被删掉（它是纯优化、可丢弃的文件）');

  // 只剩一份快照文件：将来若有人把清理去掉，这条会红
  const snapshotFiles = [...world.backend.files.keys()].filter((path) => path.startsWith('snapshots/'));
  assert.equal(snapshotFiles.length, 1, '快照文件应当只剩一份，实际 ' + snapshotFiles.length + ' 份');
  console.log('  快照清理：发布第二份后，存储里只剩 1 份快照文件');
});
