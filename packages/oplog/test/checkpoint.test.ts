import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Materializer,
  SnapshotBlobError,
  canonicalJson,
  checkpointOp,
  stateDigest,
  validateStateSnapshot,
} from '../src/index.ts';
import { HlcClock } from '../src/hlc.ts';
import { emptyState } from '../src/materialize-support.ts';

/**
 * 检查点与快照摘要的协议层：
 *  - 摘要必须是**规范**的（同一个状态在任何设备/任何键序下都得同一个值）；
 *  - 检查点是日志里的记号，不能改变物化状态，也不能被当成孤儿；
 *  - 坏快照必须整体拒绝（摘要自校验）。
 */

const clock = new HlcClock({ now: () => 1_000 });

test('规范化序列化：键序不影响摘要，内容变化会改变摘要', () => {
  const a = emptyState();
  a.characters['c1'] = { id: 'c1' } as never;
  a.settings['theme'] = { value: 'dark', hlc: { t: 1, c: 0 }, opId: 'op1' };

  // 同样的内容、不同的插入顺序 → 同一个摘要
  const b = emptyState();
  b.settings['theme'] = { value: 'dark', hlc: { t: 1, c: 0 }, opId: 'op1' };
  b.characters['c1'] = { id: 'c1' } as never;
  assert.equal(stateDigest(a), stateDigest(b));
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));

  // 内容变了 → 摘要变了
  const c = emptyState();
  c.characters['c1'] = { id: 'c1' } as never;
  c.settings['theme'] = { value: 'light', hlc: { t: 1, c: 0 }, opId: 'op1' };
  assert.notEqual(stateDigest(a), stateDigest(c));

  // 数组顺序是内容的一部分
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  assert.match(stateDigest(a), /^[0-9a-f]{8}-\d+$/);
});

test('检查点：不改变状态、不算孤儿、重复投递是 duplicate', () => {
  const materializer = new Materializer();
  const op = checkpointOp(
    { deviceId: 'device-a', clock },
    {
      upToHlc: { t: 1_000, c: 0 },
      lastSeq: 7,
      lastOpId: 'op-7',
      opCount: 7,
      digest: stateDigest(emptyState()),
      createdAt: 1_000,
    },
  );

  const before = stateDigest(materializer.state);
  assert.equal(materializer.apply(op), 'applied');
  assert.equal(materializer.orphanCount, 0, '检查点不该进孤儿队列');
  assert.equal(stateDigest(materializer.state), before, '检查点不改变状态');
  assert.equal(materializer.apply(op), 'duplicate', '重复投递按 opId 幂等');
});

test('快照校验：版本、字段、摘要任何一项不对就整体拒绝', () => {
  const good = {
    v: 1,
    deviceId: 'device-a',
    createdAt: 1,
    upToHlc: { t: 1, c: 0 },
    lastSeq: 3,
    lastOpId: 'op-3',
    opCount: 3,
    digest: stateDigest(emptyState()),
    state: emptyState(),
  };
  assert.equal(validateStateSnapshot(good).lastSeq, 3);

  const cases: Array<[string, unknown]> = [
    ['不是对象', 42],
    ['版本不对', { ...good, v: 2 }],
    ['缺 deviceId', { ...good, deviceId: '' }],
    ['缺 digest', { ...good, digest: '' }],
    ['缺 lastSeq', { ...good, lastSeq: 'x' }],
    ['缺 upToHlc', { ...good, upToHlc: { t: 1 } }],
    ['状态结构不全', { ...good, state: { characters: {} } }],
    ['摘要不匹配', { ...good, digest: 'deadbeef-0' }],
  ];
  for (const [label, value] of cases) {
    assert.throws(() => validateStateSnapshot(value), SnapshotBlobError, label);
  }
});
