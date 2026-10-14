import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HlcClock } from '../src/hlc.ts';
import { characterDelete, characterUpsert, decodeOps, encodeOps, type Op } from '../src/index.ts';
import { Materializer } from '../src/materialize.ts';

/**
 * 角色 op 的三条不变量：**幂等**、**与到达顺序无关**、**删除可被更新的写入复活**。
 *
 * 这些性质是同步的正确性基础：段可能重复投递、乱序到达，收敛结果必须一致。
 */

function base(deviceId: string, t = 1_700_000_000_000) {
  // deviceId 只进 op，不进时钟：时钟只关心"现在几点"
  return { deviceId, clock: new HlcClock({ now: () => t }) };
}

function card(name: string, overrides: Record<string, unknown> = {}) {
  return {
    characterId: 'c1',
    name,
    description: '',
    personality: '',
    scenario: '',
    firstMessage: '',
    exampleDialogue: '',
    ...overrides,
  };
}

test('角色 op：创建后可查到，字段完整', () => {
  const m = new Materializer();
  m.apply(characterUpsert(base('A'), card('星野', { description: '夜巡' })));

  const list = m.characters();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, 'c1');
  assert.equal(list[0]?.name, '星野');
  assert.equal(list[0]?.description, '夜巡');
});

test('角色 op：同一个 opId 重复应用结果不变（at-least-once 投递）', () => {
  const op = characterUpsert(base('A'), card('星野'));
  const m = new Materializer();
  assert.equal(m.apply(op), 'applied');
  assert.equal(m.apply(op), 'duplicate');
  assert.equal(m.characters().length, 1);
  assert.equal(m.appliedCount, 1);
});

test('角色 op：乱序到达收敛到同一次结果（晚的 HLC 赢）', () => {
  const early = characterUpsert(base('A', 1_700_000_000_000), card('旧名字'));
  const late = characterUpsert(base('B', 1_700_000_100_000), card('新名字', { personality: '克制' }));

  const forward = new Materializer();
  forward.applyAll([early, late]);
  const backward = new Materializer();
  backward.applyAll([late, early]);

  assert.equal(forward.characters()[0]?.name, '新名字');
  assert.equal(backward.characters()[0]?.name, '新名字', '反序到达也必须收敛到新名字');
  assert.equal(backward.characters()[0]?.personality, '克制');
});

test('角色 op：删除是墓碑，更新的写入可以复活', () => {
  const created = characterUpsert(base('A', 1_700_000_000_000), card('星野'));
  const removed = characterDelete(base('A', 1_700_000_100_000), { characterId: 'c1' });
  const revived = characterUpsert(base('B', 1_700_000_200_000), card('星野·改'));

  const m = new Materializer();
  m.applyAll([created, removed]);
  assert.deepEqual(m.characters(), [], '删除后不出现在列表里');

  m.applyAll([revived]);
  assert.equal(m.characters().length, 1);
  assert.equal(m.characters()[0]?.name, '星野·改', '更新的写入应当复活墓碑');

  // 逐个 apply（不排序）才能验"到达顺序"：更新的写入先到，更旧的删除后到 → 删除必须被忽略
  const arrival = new Materializer();
  arrival.apply(revived);
  arrival.apply(removed);
  arrival.apply(created);
  assert.equal(arrival.characters().length, 1, '更旧的删除不得盖掉更新的写入');
  assert.equal(arrival.characters()[0]?.name, '星野·改');

  // 反过来：更旧的写入后到，也不能盖掉已经生效的删除
  const arrival2 = new Materializer();
  arrival2.apply(removed);
  arrival2.apply(revived);
  arrival2.apply(created);
  assert.equal(arrival2.characters().length, 1, '更新的写入仍应复活');
});

test('角色 op：删除一台设备上不存在的角色 → 记录成墓碑，两台设备都收敛到删除', () => {
  const onA = characterUpsert(base('A', 1_700_000_000_000), card('星野'));
  const deleteOnB = characterDelete(base('B', 1_700_000_100_000), { characterId: 'c1' });

  const deviceB = new Materializer();
  deviceB.apply(deleteOnB); // B 从没见过这个角色
  assert.deepEqual(deviceB.characters(), []);

  // B 收到 A 的创建（更早）后仍然是删除状态
  deviceB.applyAll([onA]);
  assert.deepEqual(deviceB.characters(), [], '墓碑比创建更新，角色不该复活');
});

test('角色 op：编码/解码往返不丢字段（日志是唯一事实源）', () => {
  const ops: Op[] = [
    characterUpsert(base('A'), card('星野', { description: '夜巡', firstMessage: '「进来吧。」' })),
    characterDelete(base('A'), { characterId: 'c2' }),
  ];
  const decoded = decodeOps(new TextDecoder().decode(encodeOps(ops)));
  assert.equal(decoded.length, 2);

  const m = new Materializer();
  m.applyAll(decoded);
  assert.equal(m.characters()[0]?.firstMessage, '「进来吧。」');
});

test('未知 op 类型被安全忽略（向前兼容：新客户端写的 op 不该让旧客户端崩）', () => {
  const m = new Materializer();
  const future: Op = {
    opId: 'x1',
    deviceId: 'A',
    hlc: { t: 1, c: 0 },
    entity: { type: 'future', id: 'l1' },
    type: 'future.thing' as never,
    payload: { anything: true },
    schema: 1,
  };
  assert.equal(m.apply(future), 'applied');
  assert.equal(m.characters().length, 0);
});
