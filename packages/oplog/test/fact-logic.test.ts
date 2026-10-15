import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HlcClock } from '../src/hlc.ts';
import { Materializer } from '../src/materialize.ts';
import { factDelete, factUpsert, type FactState } from '../src/fact-ops.ts';
import { listFacts } from '../src/fact-projection.ts';
import { conflictsOf, factsToLoreEntries, parseFactProposals, provenanceLine } from '../src/fact-logic.ts';
import type { FactRecord } from '../src/state-types.ts';

/**
 * 设定库（事实抽取）的测试。四条要钉住的性质：
 * 1. **没有 provenance 的断言进不来**（op 构造器直接抛错）—— 否则它会变成无法核对的"事实"；
 * 2. 解析**宽容但有据**：坏条目丢掉并计数，整体不是 JSON 才报错，绝不猜字段名；
 * 3. 冲突是**派生**的：同主语同谓词不同宾语才算，已拒绝的不参与；
 * 4. 导出世界书时 **provenance 一起带走**（注释里能回溯到源消息 id）。
 */

const CLOCK = new HlcClock({ now: () => 1_700_000_000_000 });

function fact(over: Partial<FactRecord> & { id: string }): FactRecord {
  return {
    subject: '铜铃',
    predicate: '来历',
    object: '父亲的遗物',
    text: '铜铃是父亲留下来的遗物。',
    sourceMessageIds: ['M1'],
    state: 'accepted' as FactState,
    createdBy: 'model',
    createdHlc: { t: 1, c: 0 },
    updatedHlc: { t: 1, c: 0 },
    opId: 'op1',
    ...over,
  };
}

test('解析：能剥代码块、坏条目丢掉并计数、整体不是 JSON 才报错', () => {
  const good = parseFactProposals(
    '```json\n[{"subject":"铜铃","predicate":"来历","object":"父亲的遗物","sourceMessageIds":["M1"],"confidence":80}]\n```',
  );
  assert.equal(good.error, undefined);
  assert.equal(good.proposals.length, 1);
  assert.equal(good.dropped, 0);
  assert.equal(good.proposals[0]?.subject, '铜铃');

  // 前后还有话 + 代码块
  const chatty = parseFactProposals('我整理了一下：\n```json\n[{"subject":"a","predicate":"b","object":"c","sourceMessageIds":["M2"]}]\n```\n以上。');
  assert.equal(chatty.proposals.length, 1);

  // {facts: []} 也认
  const wrapped = parseFactProposals('{"facts":[{"subject":"a","predicate":"b","object":"c","sourceMessageIds":["M3"]}]}');
  assert.equal(wrapped.proposals.length, 1);

  // 坏条目（缺宾语、没有 provenance）各自丢掉并计数
  const mixed = parseFactProposals(
    JSON.stringify([
      { subject: 'a', predicate: 'b', object: 'c', sourceMessageIds: ['M1'] },
      { subject: 'a', predicate: 'b', object: '', sourceMessageIds: ['M1'] },
      { subject: 'a', predicate: 'b', object: 'c', sourceMessageIds: [] },
      'not an object',
    ]),
  );
  assert.equal(mixed.proposals.length, 1);
  assert.equal(mixed.dropped, 3, '坏条目要计数，不能假装模型没给');

  assert.match(parseFactProposals('这不是 JSON').error ?? '', /不是合法 JSON/);
  assert.match(parseFactProposals('').error ?? '', /没有返回内容/);
  assert.match(parseFactProposals('{"a":1}').error ?? '', /顶层应当是数组/);
});

test('守卫：没有 provenance 的事实，op 构造器直接拒绝', () => {
  assert.throws(
    () =>
      factUpsert({ deviceId: 'device-a', clock: CLOCK }, {
        factId: 'f1',
        subject: '铜铃',
        predicate: '来历',
        object: '父亲的遗物',
        sourceMessageIds: [],
        state: 'proposed',
        createdBy: 'model',
      }),
    /provenance/,
  );
});

test('冲突是派生的：同主语同谓词不同宾语才算，已拒绝的不参与', () => {
  const facts = [
    fact({ id: 'f1', object: '父亲的遗物' }),
    fact({ id: 'f2', object: '守夜人的信物' }),
    fact({ id: 'f3', object: '父亲的遗物' }),
    fact({ id: 'f4', object: '另一种说法', state: 'rejected' }),
    fact({ id: 'f5', subject: '茶', predicate: '温度', object: '还热' }),
  ];
  const conflicts = conflictsOf(facts);
  // 规则是**成对报告**：f2（守夜人的信物）同时与 f1、f3（父亲的遗物）矛盾 → 两条；
  // f1 与 f3 同宾语不算；f4 已拒绝不算；f5 换了谓词不算。
  assert.equal(conflicts.length, 2, '成对报告：f2 与 f1、f2 与 f3 各一条');
  assert.equal(conflicts.every((item) => item.subject === '铜铃'), true);
  const pairs = conflicts.map((item) => [item.a.factId, item.b.factId].sort().join('-'));
  assert.deepEqual(pairs.sort(), ['f1-f2', 'f2-f3']);
  assert.match(conflicts[0]?.reason ?? '', /两个说法/);
});

test('导出世界书：默认只带已采纳，provenance 与状态写进注释，关键词取主语与宾语', () => {
  const facts = [
    fact({ id: 'f1', sourceMessageIds: ['M1', 'M2'], confidence: 80 }),
    fact({ id: 'f2', state: 'proposed' }),
    fact({ id: 'f3', deleted: { hlc: { t: 9, c: 0 }, opId: 'op9' } }),
  ];
  const accepted = factsToLoreEntries(facts);
  assert.equal(accepted.length, 1, '待定的与墓碑的都不导出');
  assert.deepEqual(accepted[0]?.keys, ['铜铃', '父亲的遗物']);
  assert.match(accepted[0]?.comment ?? '', /来源：M1、M2/);
  assert.match(accepted[0]?.comment ?? '', /状态：accepted/);
  assert.match(accepted[0]?.comment ?? '', /置信：80/);

  const withProposed = factsToLoreEntries(facts, { onlyAccepted: false });
  assert.equal(withProposed.length, 2, '人工过一遍时可以带上待定的');

  const titled = factsToLoreEntries([fact({ id: 'f1', sourceMessageIds: ['M1'] })], {
    titles: new Map([['M1', '第 1 条']]),
  });
  assert.match(titled[0]?.comment ?? '', /第 1 条（M1）/);

  assert.match(provenanceLine({ sourceMessageIds: ['M7'] }), /来源：M7/);
});

test('物化集成：写入后能按角色/状态列出；同一条 op 再来是 duplicate；删除是墓碑', () => {
  const materializer = new Materializer();
  const op = factUpsert({ deviceId: 'device-a', clock: CLOCK }, {
    factId: 'f1',
    characterId: 'char-1',
    subject: '铜铃',
    predicate: '来历',
    object: '父亲的遗物',
    sourceMessageIds: ['M1'],
    confidence: 70,
    state: 'proposed',
    createdBy: 'model',
    modelId: 'mock',
  });
  assert.equal(materializer.apply(op), 'applied');
  assert.equal(materializer.apply(op), 'duplicate');
  assert.equal(listFacts(materializer.state, 'char-1', 'proposed').length, 1);
  assert.equal(listFacts(materializer.state, 'char-1', 'accepted').length, 0);

  // 采纳：同一 factId 再写一条 accepted（HLC 更晚）
  const accepted = factUpsert({ deviceId: 'device-a', clock: CLOCK }, {
    factId: 'f1',
    characterId: 'char-1',
    subject: '铜铃',
    predicate: '来历',
    object: '父亲的遗物',
    sourceMessageIds: ['M1'],
    state: 'accepted',
    createdBy: 'user',
  });
  assert.equal(materializer.apply(accepted), 'applied');
  assert.equal(listFacts(materializer.state, 'char-1', 'accepted').length, 1);
  assert.equal(materializer.state.facts['f1']?.createdBy, 'user', '最后写入的内容生效');

  materializer.apply(factDelete({ deviceId: 'device-a', clock: CLOCK }, { factId: 'f1' }));
  assert.equal(listFacts(materializer.state).length, 0, '墓碑之后不再列出');
  assert.equal(materializer.state.facts['f1']?.deleted !== undefined, true, '证据留在状态里（墓碑），不是真删');
});
