import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrieve, type RetrievalDoc } from '../../packages/oplog/src/retrieval.ts';
import { buildLongConversation, FACTS, TOTAL } from './harness.ts';

/**
 * 检索在**长对话**上的召回测量（M4 第三块）。
 *
 * 为什么在这里测：单元测试证明"排名对不对"，这里量的是"在 500 条同风格填充句里，
 * 埋下去的事实能不能被捞回来"。这两个问题不一样 —— 长对话里全是相似句子，才是真实难度。
 *
 * **说准这个数字**：这是**词法**检索（BM25 + 中文双字切片），不是语义检索。
 * 所以下面刻意放了一条**改写式提问**：它会命中还是会漏，如实打出来，不修不遮。
 * 语义那一半要等 embedding 来源（本地模型或 API）——本环境没有，不假装做了。
 */

const HISTORY = buildLongConversation();
const DOCS: RetrievalDoc[] = HISTORY.map((message, index) => ({
  id: `M${index + 1}`,
  text: message.content,
  kind: 'message',
}));

/** 事实所在消息的 id（at 是 1 起）。 */
const idOfFact = (at: number): string => `M${at}`;

test(`检索召回：${TOTAL} 条同风格对话里，5 条埋点事实的 top-5 召回`, () => {
  let hits = 0;
  const lines: string[] = [];
  for (const fact of FACTS) {
    // 用事实原文提问：这是词法检索最擅长的情况（词面重合）
    const ranked = retrieve(fact.text, DOCS, { limit: 5 });
    const found = ranked.some((item) => item.id === idOfFact(fact.at));
    if (found) hits += 1;
    const top = ranked[0];
    lines.push(`    ${found ? '✓' : '✗'} 第 ${fact.at} 条 → top1=${top?.id ?? '（无）'}(score ${top?.score.toFixed(2) ?? '-'})`);
  }
  console.log(`  [检索] 事实召回 ${hits}/${FACTS.length}（top-5，词面提问）`);
  for (const line of lines) console.log(line);
  assert.equal(hits, FACTS.length, '词面提问下 5 条事实都应当被 top-5 捞回来');
});

test('检索的边界：改写式提问（词面不重合）能不能找到——如实打出来，不修不遮', () => {
  // 目标事实是「她的真名是阿霜，从没跟人说过。」（第 300 条）
  const paraphrases = [
    { query: '她叫什么名字？', note: '问名字（与「真名」词面部分重合）' },
    { query: '有没有人知道她的身份？', note: '问身份（词面几乎不重合）' },
    { query: '阿霜是谁？', note: '直接点名（词面重合）' },
  ];
  console.log('  [检索·改写提问] 目标：第 300 条「她的真名是阿霜，从没跟人说过。」');
  let lexicalHits = 0;
  for (const item of paraphrases) {
    const ranked = retrieve(item.query, DOCS, { limit: 5 });
    const found = ranked.some((entry) => entry.id === 'M300');
    if (found) lexicalHits += 1;
    console.log(`    ${found ? '✓' : '✗'} ${item.query}（${item.note}）→ ${ranked.map((entry) => entry.id).slice(0, 3).join(', ') || '（无结果）'}`);
  }
  // 只断言"确实量到了"，不断言改写提问必须成功——那是语义检索的活，今天做不到
  console.log(`  [检索·改写提问] 词法命中 ${lexicalHits}/${paraphrases.length}（这是词法检索的真实边界，不是回归指标）`);
  assert.ok(true);
});

test('检索不会把无关文档塞进来：查询只命中一条时，其余分数为 0 不进结果', () => {
  const ranked = retrieve('阿霜', DOCS, { limit: 5 });
  assert.ok(ranked.length >= 1);
  assert.ok(ranked.every((item) => item.score > 0), '结果里不该有 0 分的文档');
  assert.equal(ranked.every((item) => item.kind === 'message'), true);
});
