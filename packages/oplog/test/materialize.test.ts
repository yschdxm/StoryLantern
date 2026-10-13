import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HlcClock } from '../src/hlc.ts';
import {
  candidateAppend,
  candidateSelect,
  messageAppend,
  messageDelete,
  messageEdit,
  revisionSelect,
  sessionCreate,
  settingSet,
  type Op,
} from '../src/op.ts';
import { Materializer } from '../src/materialize.ts';

/** 用固定墙上时钟 + 手推 tick，得到可预测的 HLC，便于写确定性断言。 */
function makeClock(start = 1_700_000_000_000): HlcClock {
  let now = start;
  const clock = new HlcClock({ now: () => now });
  return Object.assign(clock, {
    advanceTo(value: number) {
      now = value;
    },
  });
}

function device(id: string, start?: number): { deviceId: string; clock: HlcClock } {
  return { deviceId: id, clock: makeClock(start) };
}

function append(dev: { deviceId: string; clock: HlcClock }, messageId: string, content: string): Op {
  return messageAppend(dev, { sessionId: 'S1', messageId, author: 'user', content });
}

test('幂等：同一批 op 应用两次，结果与计数都不变', () => {
  const a = device('A');
  const ops = [append(a, 'M1', '第一句'), append(a, 'M2', '第二句')];

  const materializer = new Materializer();
  const first = materializer.applyAll(ops);
  const afterFirst = Materializer.freeze(materializer.snapshot());
  const second = materializer.applyAll(ops);

  assert.equal(first.applied, 2);
  assert.equal(second.applied, 0);
  assert.equal(second.duplicates, 2);
  assert.equal(Materializer.freeze(materializer.snapshot()), afterFirst);
});

test('收敛：同一批 op 以任意顺序送达，最终状态逐字节一致', () => {
  const a = device('A', 1_700_000_000_000);
  const b = device('B', 1_700_000_000_500);
  const ops: Op[] = [
    sessionCreate(a, { sessionId: 'S1', title: '夜航' }),
    append(a, 'M1', 'A 说的话'),
    append(b, 'M2', 'B 说的话'),
    messageEdit(b, { messageId: 'M1', revisionId: 'M1:r1', baseRevisionId: 'M1:r0', content: 'B 改的 M1' }),
    settingSet(a, { key: 'theme', value: 'dark' }),
    settingSet(b, { key: 'theme', value: 'light' }),
  ];

  const forward = new Materializer();
  forward.applyAll(ops);

  const shuffled = new Materializer();
  shuffled.applyAll([...ops].reverse());

  const interleaved = new Materializer();
  interleaved.applyAll([ops[3] as Op, ops[1] as Op, ops[5] as Op, ops[0] as Op, ops[4] as Op, ops[2] as Op]);

  const expected = Materializer.freeze(forward.snapshot());
  assert.equal(Materializer.freeze(shuffled.snapshot()), expected);
  assert.equal(Materializer.freeze(interleaved.snapshot()), expected);
});

test('会话内顺序由 HLC 派生，与到达顺序无关', () => {
  const a = device('A', 1_700_000_000_000);
  const b = device('B', 1_700_000_001_000);
  const m1 = append(a, 'M1', '早');
  const m2 = append(b, 'M2', '晚');

  const one = new Materializer();
  one.applyAll([m2, m1]);
  assert.deepEqual(one.orderOf('S1').map((message) => message.id), ['M1', 'M2']);

  const two = new Materializer();
  two.applyAll([m1, m2]);
  assert.deepEqual(two.orderOf('S1').map((message) => message.id), ['M1', 'M2']);
});

test('分叉：两台设备基于同一版本各改一次，两版都保留并可被识别', () => {
  const a = device('A', 1_700_000_000_000);
  const b = device('B', 1_700_000_000_500);
  const materializer = new Materializer();
  materializer.applyAll([
    append(a, 'M1', '原始内容'),
    messageEdit(a, { messageId: 'M1', revisionId: 'M1:r1', baseRevisionId: 'M1:r0', content: 'A 的改法' }),
    messageEdit(b, { messageId: 'M1', revisionId: 'M1:r2', baseRevisionId: 'M1:r0', content: 'B 的改法' }),
  ]);

  const message = materializer.state.messages.M1;
  assert.equal(message?.revisions.length, 3);
  assert.equal(materializer.textOf('M1'), 'B 的改法', '更新的版本成为当前正文');

  const forks = materializer.forksOf('M1');
  assert.equal(forks.length, 1);
  assert.equal(forks[0]?.baseRevisionId, 'M1:r0');
  assert.deepEqual(forks[0]?.revisionIds, ['M1:r1', 'M1:r2']);
});

test('显式选择压过更早的编辑，但更新的编辑一定生效', () => {
  const a = device('A', 1_700_000_000_000);
  const materializer = new Materializer();
  materializer.applyAll([
    append(a, 'M1', 'v0'),
    messageEdit(a, { messageId: 'M1', revisionId: 'M1:r1', baseRevisionId: 'M1:r0', content: 'v1' }),
  ]);

  // 用户显式选回 r0
  const select = revisionSelect({ deviceId: 'A', clock: a.clock }, { messageId: 'M1', revisionId: 'M1:r0' });
  materializer.applyAll([select]);
  assert.equal(materializer.textOf('M1'), 'v0');

  // 另一个设备基于 r1 的新编辑（比显式选择更晚）应接管
  const c = device('C', 1_700_000_002_000);
  materializer.applyAll([
    messageEdit(c, { messageId: 'M1', revisionId: 'M1:r3', baseRevisionId: 'M1:r1', content: 'v3（更新）' }),
  ]);
  assert.equal(materializer.textOf('M1'), 'v3（更新）');
  assert.equal(materializer.state.messages.M1?.activeRevision.explicit, false);
});

test('删除是墓碑且 LWW：晚的删除生效，被删消息不出现在顺序与正文里', () => {
  const a = device('A', 1_700_000_000_000);
  const b = device('B', 1_700_000_000_500);
  const materializer = new Materializer();
  materializer.applyAll([append(a, 'M1', '内容')]);

  const earlyDelete = messageDelete({ deviceId: 'A', clock: a.clock }, { messageId: 'M1' });
  const lateDelete = messageDelete({ deviceId: 'B', clock: b.clock }, { messageId: 'M1' });
  materializer.applyAll([lateDelete, earlyDelete]);

  assert.ok(materializer.state.messages.M1?.deleted);
  assert.equal(materializer.textOf('M1'), undefined);
  assert.deepEqual(materializer.orderOf('S1'), []);
});

test('swipe（候选）：追加幂等，选中按 HLC 取最新', () => {
  const a = device('A', 1_700_000_000_000);
  const b = device('B', 1_700_000_000_900);
  const first = candidateAppend({ deviceId: 'A', clock: a.clock }, { messageId: 'M1', candidateId: 'C1', content: '候选一' });
  const second = candidateAppend({ deviceId: 'A', clock: a.clock }, { messageId: 'M1', candidateId: 'C2', content: '候选二' });

  const materializer = new Materializer();
  materializer.applyAll([append(a, 'M1', '正文'), first, second, first]);
  assert.equal(materializer.state.messages.M1?.candidates.length, 2);

  materializer.applyAll([
    candidateSelect({ deviceId: 'A', clock: a.clock }, { messageId: 'M1', candidateId: 'C1' }),
    candidateSelect({ deviceId: 'B', clock: b.clock }, { messageId: 'M1', candidateId: 'C2' }),
  ]);
  assert.equal(materializer.textOf('M1'), '候选二');
});

test('设置项字段级 LWW：较晚的写入生效，平局由 opId 决定', () => {
  const a = device('A', 1_700_000_000_000);
  const b = device('B', 1_700_000_000_500);
  const materializer = new Materializer();
  materializer.applyAll([
    settingSet(a, { key: 'model', value: 'deepseek' }),
    settingSet(b, { key: 'model', value: 'claude' }),
  ]);
  assert.equal(materializer.state.settings.model?.value, 'claude');
});

test('孤儿 op：编辑先于 append 到达时暂存，append 到达后自动落地（不丢数据）', () => {
  const a = device('A', 1_700_000_000_000);
  const materializer = new Materializer();
  const edit = messageEdit(a, { messageId: 'M1', revisionId: 'M1:r1', baseRevisionId: 'M1:r0', content: '改过的' });

  const result = materializer.applyAll([edit]);
  assert.equal(result.applied, 0);
  assert.equal(result.orphans, 1);

  materializer.applyAll([append(a, 'M1', '原始')]);
  assert.equal(materializer.orphanCount, 0);
  assert.equal(materializer.state.messages.M1?.revisions.length, 2);
  assert.equal(materializer.textOf('M1'), '改过的');
});

test('未知 op 类型被忽略而不是崩溃（向前兼容）', () => {
  const a = device('A');
  const unknown: Op = {
    opId: '01UNKNOWN',
    deviceId: 'A',
    hlc: { t: 1, c: 0 },
    entity: { type: 'future', id: 'X' },
    type: 'future.thing' as Op['type'],
    payload: {},
    schema: 1,
  };
  const materializer = new Materializer();
  const result = materializer.applyAll([unknown, append(a, 'M1', '正常')]);
  assert.equal(result.applied, 2);
  assert.equal(materializer.state.messages.M1 !== undefined, true);
});

test('快照往返：恢复后状态与已应用集合一致，重复投递仍是幂等', () => {
  const a = device('A', 1_700_000_000_000);
  const ops = [sessionCreate(a, { sessionId: 'S1', title: 'T' }), append(a, 'M1', '正文')];

  const original = new Materializer();
  original.applyAll(ops);
  const snapshot = JSON.parse(JSON.stringify(original.snapshot())) as ReturnType<Materializer['snapshot']>;

  const restored = new Materializer(snapshot);
  assert.equal(Materializer.freeze(restored.snapshot()), Materializer.freeze(original.snapshot()));

  const again = restored.applyAll(ops);
  assert.equal(again.duplicates, 2);
  assert.equal(Materializer.freeze(restored.snapshot()), Materializer.freeze(original.snapshot()));
});
