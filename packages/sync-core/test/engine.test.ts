import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageAppend, settingSet } from '../../oplog/src/op.ts';
import { DEVICES_PREFIX } from '../src/paths.ts';
import { createWorld, emit, freeze, messageIds } from './world.ts';

const A = 'device-a';
const B = 'device-b';

test('双向同步：两端收敛，消息不丢、不重、顺序一致', async () => {
  const world = createWorld();
  const a = world.peer(A);
  const b = world.peer(B);

  for (let index = 1; index <= 3; index += 1) {
    emit(a, messageAppend(a, { sessionId: 'S1', messageId: `A${index}`, author: 'user', content: `A 的第 ${index} 句` }));
  }
  await world.sync(A);

  const firstPull = await world.sync(B);
  assert.equal(firstPull.warnings.length, 0);
  assert.deepEqual(messageIds(b), ['A1', 'A2', 'A3']);

  emit(b, messageAppend(b, { sessionId: 'S1', messageId: 'B1', author: 'character', content: 'B 的回应' }));
  await world.sync(B);
  await world.sync(A);

  assert.deepEqual(messageIds(a), ['A1', 'A2', 'A3', 'B1']);
  assert.deepEqual(messageIds(b), ['A1', 'A2', 'A3', 'B1']);
  assert.equal(freeze(a), freeze(b), '两端物化状态必须逐字节一致');
});

test('请求预算：单次同步 list 只调一次、前缀只有 devices/，且从不遍历 logs/', async () => {
  const world = createWorld();
  const a = world.peer(A);

  emit(a, messageAppend(a, { sessionId: 'S1', messageId: 'A1', author: 'user', content: '内容' }));
  const first = await world.sync(A);

  assert.equal(first.listCalls, 1, '一轮同步只列一次目录');
  assert.deepEqual([...new Set(a.engine.counters.listPrefixes)], [DEVICES_PREFIX]);
  assert.equal(
    a.engine.counters.listPrefixes.some((prefix) => prefix.startsWith('logs/')),
    false,
    '绝不遍历 logs/ 目录树',
  );
  assert.equal(
    a.engine.counters.paths.some((path) => path.startsWith('logs/') && !first.uploaded.includes(path)),
    false,
  );
  // 一个小批次：列目录 1 + 发布段 1 + 回读校验 1 + manifest 1 = 4
  assert.ok(first.requests <= 8, `单次同步请求数应 ≤ 8，实际 ${first.requests}`);

  // 没有新改动时的空转同步应当更便宜
  const idle = await world.sync(A);
  assert.ok(idle.requests <= 3, `空转同步应 ≤ 3 次请求，实际 ${idle.requests}`);
});

test('增量：游标生效，重复同步不会重复下载已消费的段', async () => {
  const world = createWorld();
  const a = world.peer(A);
  const b = world.peer(B);

  emit(a, messageAppend(a, { sessionId: 'S1', messageId: 'A1', author: 'user', content: '一' }));
  await world.sync(A);

  const first = await world.sync(B);
  assert.equal(first.downloaded.length, 1);

  const second = await world.sync(B);
  assert.deepEqual(second.downloaded, [], '已消费的段不应再次下载');
  assert.deepEqual(messageIds(b), ['A1']);
});

test('at-least-once 投递：游标丢失后重放同一段，结果不变（opId 去重）', async () => {
  const world = createWorld();
  const a = world.peer(A);
  const b = world.peer(B);

  emit(a, messageAppend(a, { sessionId: 'S1', messageId: 'A1', author: 'user', content: '一' }));
  emit(a, settingSet(a, { key: 'theme', value: 'dark' }));
  await world.sync(A);
  await world.sync(B);
  const before = freeze(b);

  // 模拟"崩溃在持久化游标之前"：水位与已应用集合一起清空，同样的段会被再次拉取
  const state = b.engine.exportState();
  state.cursors = {};
  state.appliedSeqs = {};
  b.engine.importState(state);

  const replay = await world.sync(B);
  assert.equal(replay.downloaded.length, 2, '消息段与设置段都会被重新拉取');
  assert.equal(replay.appliedOps, 0, '重复投递的 op 应全部被去重');
  assert.equal(freeze(b), before, '重放不得改变物化状态');
  assert.equal(messageIds(b).length, 1, '不得产生重复消息');
});

test('名单外设备的 manifest 被忽略并告警', async () => {
  const world = createWorld({ deviceIds: [A, B, 'device-c'] });
  const c = world.peer('device-c');
  world.roster.revoke('device-c', 1_700_000_000_000);

  emit(c, messageAppend(c, { sessionId: 'S1', messageId: 'C1', author: 'user', content: '来自已退役设备' }));
  await world.sync('device-c');

  const result = await world.sync(A);
  assert.ok(result.warnings.some((warning) => warning.includes('名单外设备')));
  assert.deepEqual(messageIds(world.peer(A)), []);
});

test('发布后回读校验：写入被静默吃字节时不会误判为"已发布"', async () => {
  const world = createWorld();
  const a = world.peer(A);

  emit(a, messageAppend(a, { sessionId: 'S1', messageId: 'A1', author: 'user', content: '正文' }));
  world.backend.faults.truncateUploadsAtPercent = 50;

  const failed = await world.sync(A);
  assert.ok(failed.warnings.some((warning) => warning.includes('发布校验失败')));
  assert.equal(a.engine.state.outbox.length, 1, '未确认发布的 op 必须留在 outbox 等待重传');

  world.backend.faults.truncateUploadsAtPercent = null;
  const retry = await world.sync(A);
  assert.equal(retry.warnings.length, 0);
  assert.equal(a.engine.state.outbox.length, 0, '重传成功后 outbox 清空');

  await world.sync(B);
  assert.deepEqual(messageIds(world.peer(B)), ['A1']);
});
