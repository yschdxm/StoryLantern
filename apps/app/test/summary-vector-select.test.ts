import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EmbeddingPort } from '../../../packages/oplog/src/index.ts';
import { selectSummariesByVector } from '../src/data/summary-vector-select.ts';
import type { PromptSummary } from '../src/data/prompt-blocks.ts';

/**
 * 向量挑摘要的测试（离线，用一个**确定性**的假向量源 —— 不用真实 API，也不假装那是语义检索）。
 *
 * 假向量源的规则写死在这里：把文本按"含关键词"映射到二维方向。这样排序是可预期的，
 * 测的是**这个函数的排序与截断对不对**，不是 embedding 的质量（质量由真实测量负责）。
 */

const KEYWORD = '铜铃';

const fakeEmbedder: EmbeddingPort = {
  id: 'fake-direction',
  async embed(texts) {
    return texts.map((text) => (text.includes(KEYWORD) ? [1, 0] : [0, 1]));
  },
};

const SUMMARY = (id: string, text: string): PromptSummary => ({ id, text, level: 'scene', covers: [] });

const SUMMARIES = [
  SUMMARY('s1', '她数到一百，你就该回来了。'),
  SUMMARY('s2', `铜铃是父亲留下来的遗物。`),
  SUMMARY('s3', '风从北面灌进走廊。'),
];

test('按向量挑：与查询同方向的排前面，其余按 id 稳定排序，截断到 limit', async () => {
  const picked = await selectSummariesByVector({ embedder: fakeEmbedder, question: `铜铃那件事是什么？`, summaries: SUMMARIES, limit: 2 });
  assert.deepEqual(
    picked.map((summary) => summary.id),
    ['s2', 's1'],
    '同方向的 s2 必须第一；其余两条同分，按 id 升序取 s1',
  );
});

test('查询与摘要同向时不会漏掉：limit=3 时三条都在，顺序稳定', async () => {
  const picked = await selectSummariesByVector({ embedder: fakeEmbedder, question: '铜铃', summaries: SUMMARIES, limit: 3 });
  assert.equal(picked.length, 3);
  assert.equal(picked[0]?.id, 's2');
});

test('边界：没有摘要或查询为空时直接返回空（不去打网络）', async () => {
  let calls = 0;
  const counting: EmbeddingPort = {
    id: 'counting',
    async embed(texts) {
      calls += 1;
      return texts.map(() => [1, 0]);
    },
  };
  assert.deepEqual(await selectSummariesByVector({ embedder: counting, question: '铜铃', summaries: [] }), []);
  assert.deepEqual(await selectSummariesByVector({ embedder: counting, question: '   ', summaries: SUMMARIES }), []);
  assert.equal(calls, 0, '空输入不该发起嵌入请求');
});
