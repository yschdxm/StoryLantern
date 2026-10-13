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
