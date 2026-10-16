import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotError, mergeSnapshotChain, validateSessionSnapshot, type SessionSnapshot } from '../src/index.ts';

/**
 * 增量快照的**纯逻辑**测试（不碰网络与存储）。
 *
 * 为什么这块必须先有纯函数测试：字节级增量的风险全在"合并"上 —— 少一条消息、水位被旧值盖回去、
 * 删除没生效，都会让读取方**静默**拿到错的状态。引擎那边（下载基准、断链回退）只是把它接起来。
 *
 * 夹具说明：合并逻辑只用到消息的 `id`，所以这里只造 `{ id }` 再断言成 MessageRecord
 * （避免为了测试把 HLC、revisions 那一整串字段都摆一遍；`as unknown as` 而不是 `any`，门禁也接受）。
 */

type Message = SessionSnapshot['messages'][number];

const msg = (id: string, note: string): Message => ({ id, note }) as unknown as Message;
const noteOf = (message: Message): string => (message as unknown as { note?: string }).note ?? '';

const FULL: SessionSnapshot = {
  v: 1,
  deviceId: 'dev-a',
  blindSessionId: 'blind-1',
  createdAt: 1_000,
  watermarks: { 'dev-a': 1 },
  appliedOpIds: ['op-1'],
  messages: [msg('m1', 'base')],
};

const delta = (over: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  v: 2,
  base: 'hash-of-base',
  deviceId: 'dev-a',
  blindSessionId: 'blind-1',
  createdAt: 2_000,
  watermarks: { 'dev-a': 2 },
  appliedOpIds: ['op-2'],
  messages: [msg('m2', 'delta')],
  ...over,
});

test('整份 + 一份增量：消息并集、opId 并集、水位取最大，结果是 v1', () => {
  const merged = mergeSnapshotChain([FULL, delta()]);
  assert.equal(merged.v, 1, '合并结果必须是一份完整的 v1 快照（读取方按整份处理）');
  assert.deepEqual(merged.messages.map((m) => m.id).sort(), ['m1', 'm2']);
  assert.deepEqual([...merged.appliedOpIds].sort(), ['op-1', 'op-2']);
  assert.deepEqual(merged.watermarks, { 'dev-a': 2 });
  assert.equal(merged.blindSessionId, 'blind-1');
  assert.equal(merged.createdAt, 2_000, '合并后的时间取最新那份');
});

test('链上多份增量：按顺序叠加', () => {
  const second = delta({ createdAt: 3_000, watermarks: { 'dev-a': 3 }, appliedOpIds: ['op-3'], messages: [msg('m3', 'third')] });
  const merged = mergeSnapshotChain([FULL, delta(), second]);
  assert.deepEqual(merged.messages.map((m) => m.id).sort(), ['m1', 'm2', 'm3']);
  assert.deepEqual([...merged.appliedOpIds].sort(), ['op-1', 'op-2', 'op-3']);
  assert.equal(merged.watermarks['dev-a'], 3);
});

test('删除生效：增量里 removedMessageIds 指定的消息必须消失', () => {
  const withRemoval = delta({ removedMessageIds: ['m1'], messages: [] });
  const merged = mergeSnapshotChain([FULL, withRemoval]);
  assert.deepEqual(merged.messages.map((m) => m.id), [], '被删的消息不能留在合并结果里');
});

test('同 id 覆盖：后出现的版本赢（先删后加的顺序也要正确）', () => {
  const overwrite = delta({ messages: [msg('m1', 'updated')] });
  const merged = mergeSnapshotChain([FULL, overwrite]);
  assert.equal(merged.messages.length, 1);
  assert.equal(noteOf(merged.messages[0] as Message), 'updated');
});

test('水位单调：后面某份带更小的水位也不能把已并入的位置退回去', () => {
  const stale = delta({ watermarks: { 'dev-a': 1 }, messages: [] });
  const merged = mergeSnapshotChain([FULL, stale]);
  assert.equal(merged.watermarks['dev-a'], 1);
  const forward = mergeSnapshotChain([FULL, delta({ watermarks: { 'dev-a': 5 }, messages: [] })]);
  assert.equal(forward.watermarks['dev-a'], 5);
});

test('链序错误必须显式失败（不许"看起来能合"）', () => {
  assert.throws(() => mergeSnapshotChain([delta()]), SnapshotError, '第一份必须是整份');
  assert.throws(() => mergeSnapshotChain([FULL, FULL]), SnapshotError, '中间夹整份说明链断了');
  assert.throws(
    () => mergeSnapshotChain([FULL, delta({ blindSessionId: 'blind-2' })]),
    SnapshotError,
    '不同会话的快照不能合',
  );
  assert.throws(() => mergeSnapshotChain([]), SnapshotError, '空链');
});

test('校验：v2 必须带 base；v1 不许带 base；非 1/2 一律拒绝', () => {
  assert.doesNotThrow(() => validateSessionSnapshot(delta()));
  assert.throws(() => validateSessionSnapshot({ ...delta(), base: undefined }), SnapshotError, 'v2 缺 base');
  assert.throws(() => validateSessionSnapshot({ ...FULL, base: 'x' }), SnapshotError, 'v1 带 base');
  assert.throws(() => validateSessionSnapshot({ ...FULL, v: 3 }), SnapshotError, '未知版本必须拒绝');
  assert.throws(
    () => validateSessionSnapshot({ ...delta(), removedMessageIds: 'nope' }),
    SnapshotError,
    'removedMessageIds 类型不对要拒绝',
  );
});
