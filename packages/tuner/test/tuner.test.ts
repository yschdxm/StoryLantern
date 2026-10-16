import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HlcClock } from '../../oplog/src/hlc.ts';
import { Materializer } from '../../oplog/src/materialize.ts';
import { memoryUpsert } from '../../oplog/src/memory-ops.ts';
import type { Op } from '../../oplog/src/op.ts';
import {
  applyProposal,
  memoryContentProjection,
  pendingUndo,
  proposeMemoriesMerge,
  similarity,
  undoOps,
} from '../src/index.ts';

/**
 * 调优助手（M5）的三条退出判据，这里钉住最要紧的两条：
 *  - **0 条无审批写入**：提案本身**不含任何 op**；只有拿到 base 的 `applyProposal` 才会造 op；
 *  - **撤销逐字节还原**：按内容投影比较（定义在 `memoryContentProjection`，排除必然前进的时钟字段）。
 * 第三条（不进生成热路径）由 `plugins/tuner-agent/test/architecture.test.ts` 断言。
 */

function world() {
  let wall = 1_700_000_000_000;
  const clock = new HlcClock({ now: () => wall });
  const base = { deviceId: 'dev-a', clock };
  return {
    base,
    advance(ms = 1000) {
      wall += ms;
    },
  };
}

function seed(materializer: Materializer, base: { deviceId: string; clock: HlcClock }, entries: Array<{ id: string; text: string; characterId?: string; createdBy?: 'user' | 'agent' }>): void {
  const ops: Op[] = entries.map((entry) =>
    memoryUpsert(base, {
      memoryId: entry.id,
      ...(entry.characterId === undefined ? {} : { characterId: entry.characterId }),
      text: entry.text,
      keys: [],
      importance: 50,
      sourceMessageIds: [],
      createdBy: entry.createdBy ?? 'user',
    }),
  );
  materializer.applyAll(ops);
}

test('提案阶段零写入：建议里不含任何 op，材料化状态一个字节都没变', () => {
  const { base, advance } = world();
  const materializer = new Materializer();
  seed(materializer, base, [
    { id: 'm1', text: '星野怕黑，睡觉时总要留一盏灯。' },
    { id: 'm2', text: '星野怕黑，睡觉时必须留一盏灯。' },
    { id: 'm3', text: '灯塔的钥匙在门框上方第三块砖后面。' },
  ]);
  const before = memoryContentProjection(materializer.state);
  const opCount = materializer.snapshot().appliedOpIds.length;

  const proposals = proposeMemoriesMerge({ state: materializer.state });
  assert.equal(proposals.length, 1, '两条相近记忆应当给出一条合并建议');
  assert.equal(memoryContentProjection(materializer.state), before, '分析不得改动状态');
  assert.equal(materializer.snapshot().appliedOpIds.length, opCount, '分析不得追加 op');

  // 结构性保证：提案里只有数据，没有任何 op / 时钟
  const serialized = JSON.stringify(proposals);
  assert.equal(serialized.includes('"hlc"'), false, '提案里不该出现时钟字段');
  assert.equal(serialized.includes('"type":"memory.'), false, '提案里不该出现 op');
  assert.deepEqual(Object.keys(proposals[0]?.apply ?? {}).sort(), ['deletes', 'upserts']);
  advance();
});

test('批准后写入：合并成一条 + 删掉成员；撤销后内容投影与原来逐字节相同', () => {
  const { base, advance } = world();
  const materializer = new Materializer();
  seed(materializer, base, [
    { id: 'm1', text: '星野怕黑，睡觉时总要留一盏灯。' },
    { id: 'm2', text: '星野怕黑，睡觉时必须留一盏灯。', createdBy: 'agent' },
  ]);
  const original = memoryContentProjection(materializer.state);

  const proposal = proposeMemoriesMerge({ state: materializer.state })[0];
  assert.ok(proposal !== undefined);
  advance();
  const applied = applyProposal(proposal, base);
  materializer.applyAll(applied.ops);

  const afterApply = memoryContentProjection(materializer.state);
  assert.notEqual(afterApply, original, '合并之后状态必须真的变了');
  const live = Object.values(materializer.state.memories).filter((memory) => memory.deleted === undefined);
  assert.equal(live.length, 1, '两条并成一条');
  assert.equal(live[0]?.createdBy, 'user', '只要有一条是用户写的，合并结果就不能降级成 agent');

  // 撤销：账本在 op 日志里（跨重启还在），按记录的内容写回
  advance();
  const entry = pendingUndo(materializer.state);
  assert.ok(entry !== undefined, '撤销依据应当在设置里');
  assert.equal(entry.proposalId, proposal.id);
  materializer.applyAll(undoOps(entry, base));

  assert.equal(memoryContentProjection(materializer.state), original, '撤销必须还原到与原来逐字节相同');
  assert.equal(pendingUndo(materializer.state), undefined, '撤销之后账本要标成已撤销');
});

test('相似度阈值：近重复被抓到，不相干的不会被误伤', () => {
  const near = similarity('星野怕黑，睡觉时总要留一盏灯。', '星野怕黑，睡觉时必须留一盏灯。');
  const far = similarity('星野怕黑，睡觉时总要留一盏灯。', '灯塔的钥匙在门框上方第三块砖后面。');
  assert.ok(near > 0.6, `近重复的相似度应当很高，实际 ${near.toFixed(3)}`);
  assert.ok(far < 0.2, `不相干的相似度应当很低，实际 ${far.toFixed(3)}`);
});

test('只在同一角色作用域内合并：跨角色不碰', () => {
  const { base, advance } = world();
  const materializer = new Materializer();
  seed(materializer, base, [
    { id: 'a1', text: '她只在雨天出门。', characterId: 'alice' },
    { id: 'b1', text: '她只在雨天出门。', characterId: 'bob' },
  ]);
  assert.deepEqual(proposeMemoriesMerge({ state: materializer.state }), []);
  advance();
});

test('确定性：同一份数据重复分析，得到同一条建议（不会越点越多）', () => {
  const { base, advance } = world();
  const materializer = new Materializer();
  seed(materializer, base, [
    { id: 'm1', text: '北边的塔上有一口钟。' },
    { id: 'm2', text: '北边的塔上有一口钟，铜的。' },
  ]);
  const first = proposeMemoriesMerge({ state: materializer.state });
  const second = proposeMemoriesMerge({ state: materializer.state });
  assert.equal(first[0]?.id, second[0]?.id);
  assert.deepEqual(first, second);
  advance();
});
