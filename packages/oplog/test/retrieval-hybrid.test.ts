import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrieve, type RetrievalDoc } from '../src/retrieval.ts';
import {
  cosineSimilarity,
  createHashEmbeddingStub,
  reciprocalRankFusion,
  rerankByEmbedding,
  retrieveHybrid,
  vectorSearch,
  type EmbeddingPort,
} from '../src/retrieval-hybrid.ts';

/**
 * 混合检索的**结构**测试（不是效果测试）。
 *
 * 这里钉住的是"管线对不对、回退稳不稳"：RRF 合并、向量那一路能进人、没 embedder 就纯词法、
 * embedder 挂了要降级并告警而不是崩。**本环境没有真实 embedding**，所以：
 *  - 所有用到向量的用例都用 \`stub-hash-embedding\` 桩（它**不是**语义检索，id 里就写着 stub）；
 *  - 想证明"召回变好"必须用真 embedding —— 那件事今天做不了，也不假装做了。
 */

function docs(...texts: string[]): RetrievalDoc[] {
  return texts.map((text, index) => ({ id: `D${index + 1}`, text, kind: 'message' }));
}

const CORPUS = docs('她的真名是阿霜，从没跟人说过。', '铜铃是父亲留下来的遗物。', '茶水还热，先喝一口。', '风从北面灌进来。');

test('余弦：同向为 1、正交为 0、零向量为 0（不能是 NaN）', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  assert.equal(Number.isNaN(cosineSimilarity([0, 0], [1, 1])), false, 'NaN 会让排序变成随机');
  // 维度不一致时按短的算：与截断后的向量一致（打印实际值，便于出问题时一眼看到）
  const truncated = cosineSimilarity([1, 1], [1, 1]);
  const mismatched = cosineSimilarity([1, 1], [1, 1, 9]);
  console.log(`  余弦：截断 ${truncated} vs 维度不一致 ${mismatched}`);
  assert.equal(mismatched, truncated, '维度不一致时按短的算，不抛错');
});

test('RRF：两个列表都靠前的文档，融合分高于只在一边靠前的', () => {
  const fused = reciprocalRankFusion([
    ['A', 'B', 'C'],
    ['B', 'A', 'D'],
  ]);
  // A: 1/61 + 1/62；B: 1/62 + 1/61（同分，靠 id 兜底）；C/D 只有一边
  assert.ok((fused.get('A') ?? 0) > (fused.get('C') ?? 0));
  assert.ok((fused.get('B') ?? 0) > (fused.get('D') ?? 0));
  assert.equal((fused.get('A') ?? 0).toFixed(6), (fused.get('B') ?? 0).toFixed(6), '名次对调的两个文档应当同分');
});

test('没有 embedder：模式是 lexical，结果与纯 BM25 完全一致', async () => {
  const lexical = retrieve('铜铃', CORPUS);
  const hybrid = await retrieveHybrid('铜铃', CORPUS);
  assert.equal(hybrid.mode, 'lexical');
  assert.deepEqual(hybrid.sources, ['bm25']);
  assert.deepEqual(
    hybrid.docs.map((item) => item.id),
    lexical.map((item) => item.id),
    '没有向量时不该改变词法结果',
  );
  assert.deepEqual(hybrid.notes, []);
});

test('有 embedder：RRF 合并，向量那一路能找到的新文档会进结果', async () => {
  const embedder = createHashEmbeddingStub({ dimensions: 8 });
  const result = await retrieveHybrid('铜铃', CORPUS, { embedder, limit: 4 });
  assert.equal(result.mode, 'hybrid');
  assert.deepEqual(result.sources, ['bm25', 'stub-hash-embedding'], '来源要能被看见（含 stub 字样）');
  assert.ok(result.docs.length > 0);
  assert.ok(result.docs.every((item) => item.score > 0));
  // 融合分应当与"名次"有关，而不是原始分数
  const top = result.docs[0];
  // 两个列表都排第一时是 2/(k+1)，单边第一是 1/(k+1)
  assert.ok((top?.score ?? 0) <= 2 / 61 + 1e-9, 'RRF 单条上限是 列表数/(k+1)');
});

test('向量来源报错：降级为 lexical-fallback 并告警，结果照给', async () => {
  const broken: EmbeddingPort = {
    id: 'broken-embedder',
    async embed() {
      throw new Error('没有可用的 embedding 服务');
    },
  };
  const result = await retrieveHybrid('铜铃', CORPUS, { embedder: broken });
  assert.equal(result.mode, 'lexical-fallback', '挂掉要降级，不能没有结果');
  assert.equal(result.docs.length, retrieve('铜铃', CORPUS).length);
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0] ?? '', /向量检索不可用/);
  assert.match(result.notes[0] ?? '', /broken-embedder/);
});

test('暴力向量近邻：只返回有向量的文档，且按余弦降序', () => {
  const vectors = new Map<string, readonly number[]>([
    ['D1', [1, 0]],
    ['D2', [0, 1]],
    ['D3', [0.9, 0.1]],
  ]);
  const hits = vectorSearch([1, 0], CORPUS, vectors, 2);
  assert.deepEqual(
    hits.map((item) => item.id),
    ['D1', 'D3'],
    'D2 与查询正交（余弦 0）不该进结果',
  );
  assert.ok((hits[0]?.score ?? 0) >= (hits[1]?.score ?? 0));
});

test('空查询：即便有 embedder 也不折腾，直接词法空结果', async () => {
  const result = await retrieveHybrid('   ', CORPUS, { embedder: createHashEmbeddingStub() });
  assert.equal(result.mode, 'lexical');
  assert.deepEqual(result.docs, []);
});
test('给了向量缓存就只用它：不会为了查询再把整个语料嵌一遍（曾经会，实测把一次查询拖到 100 秒以上）', async () => {
  const seen: number[] = [];
  const spy: EmbeddingPort = {
    id: 'spy-embedder',
    async embed(texts) {
      seen.push(texts.length);
      return texts.map(() => [1, 0]);
    },
  };
  const vectors = new Map<string, readonly number[]>([
    ['D1', [1, 0]],
    ['D2', [0, 1]],
    ['D3', [1, 0]],
    ['D4', [0, 1]],
  ]);
  const result = await retrieveHybrid('铜铃', CORPUS, { embedder: spy, vectors, limit: 3 });
  assert.equal(result.mode, 'hybrid');
  assert.deepEqual(seen, [1], '有缓存时只应当嵌入查询这一条，而不是查询 + 全部文档');
});

test('rerank：词项覆盖率 + 完整短语命中能够重排，且没有任何"黑箱分数"', async () => {
  const docs = [
    { id: 'a', kind: 'message' as const, text: '铜铃响的时候别回头' },
    { id: 'b', kind: 'message' as const, text: '铜铃是父亲留下来的遗物，响过很多次' },
    { id: 'c', kind: 'message' as const, text: '雪线以上的风' },
  ];
  const candidates = [
    { id: 'a', kind: 'message' as const, score: 0.02 },
    { id: 'b', kind: 'message' as const, score: 0.02 },
  ];
  const { rerankDocs } = await import('../src/retrieval-hybrid.ts');
  const reranked = rerankDocs('铜铃', candidates, docs);
  // b 覆盖了查询词（虽然 a 也覆盖）——这里两边覆盖率相同，靠 id 兜底排序保持确定性
  assert.deepEqual(reranked.map((doc) => doc.id), ['a', 'b']);

  // 完整短语命中会额外加分：查询"父亲留下来"只在 b 里原样出现
  const phrase = rerankDocs('父亲留下来', candidates, docs);
  assert.equal(phrase[0]?.id, 'b', '"父亲留下来"只在 b 里出现，应当排第一');
  // 空查询不改变顺序
  assert.deepEqual(rerankDocs('   ', candidates, docs).map((doc) => doc.id), ['a', 'b']);
});

test('rerank 默认关闭：retrieveHybrid 不开 rerank 时不重排、也不编造 note', async () => {
  const docs = [
    { id: 'a', kind: 'message' as const, text: '铜铃响的时候别回头' },
    { id: 'b', kind: 'message' as const, text: '铜铃是父亲留下来的遗物' },
  ];
  const stub = createHashEmbeddingStub({ dimensions: 8 });
  const off = await retrieveHybrid('铜铃', docs, { embedder: stub, limit: 2 });
  assert.equal(off.notes.some((note) => note.includes('词法重排')), false);
  const on = await retrieveHybrid('铜铃', docs, { embedder: stub, limit: 2, rerank: 'lexical' });
  assert.equal(on.notes.some((note) => note.includes('词法重排')), true, '开了 rerank 必须如实写一条 note');
});
test('向量重排（模型打分）：余弦高的候选压过 RRF 高但语义不相关的候选', () => {
  // 查询向量 [1,0]；a 与查询同向（cos=1），b 正交（cos=0）
  const query = [1, 0];
  const vectors = new Map<string, number[]>([
    ['a', [1, 0]],
    ['b', [0, 1]],
  ]);
  const candidates = [
    { id: 'b', kind: 'message' as const, score: 0.05 }, // RRF 更高
    { id: 'a', kind: 'message' as const, score: 0.02 },
  ];
  const result = rerankByEmbedding(query, candidates, vectors);
  assert.equal(result.docs[0]?.id, 'a', '向量重排应当让语义更接近的那条排第一');
  assert.equal(result.missingVectors, 0);
  // 权重 0 → 退回 RRF 原序
  const pureRrf = rerankByEmbedding(query, candidates, vectors, { weight: 0 });
  assert.equal(pureRrf.docs[0]?.id, 'b');
});

test('向量重排：没有向量的候选如实计数；missing: drop 时丢掉', () => {
  const query = [1, 0];
  const vectors = new Map<string, number[]>([['a', [1, 0]]]);
  const candidates = [
    { id: 'a', kind: 'message' as const, score: 0.02 },
    { id: 'c', kind: 'message' as const, score: 0.01 },
  ];
  const kept = rerankByEmbedding(query, candidates, vectors);
  assert.equal(kept.missingVectors, 1);
  assert.equal(kept.docs.length, 2);
  const dropped = rerankByEmbedding(query, candidates, vectors, { missing: 'drop' });
  assert.deepEqual(dropped.docs.map((doc) => doc.id), ['a']);
});

test('retrieveHybrid：rerank: embedding 会重排并写明用了什么、缺多少向量', async () => {
  const docs = [
    { id: 'a', kind: 'message' as const, text: '铜铃响的时候别回头' },
    { id: 'b', kind: 'message' as const, text: '雪线以上的风' },
  ];
  const stub = createHashEmbeddingStub({ dimensions: 8 });
  const result = await retrieveHybrid('铜铃', docs, { embedder: stub, limit: 2, rerank: 'embedding' });
  assert.equal(result.mode, 'hybrid');
  assert.ok(result.notes.some((note) => note.includes('余弦重排')), '必须写清楚做了向量重排');
  assert.equal(result.docs.length, 2);
});

test('rerank 模型（交叉编码器）：解析响应、越界抛错、按分降序', async () => {
  const { parseRerankResponse } = await import('../src/rerank-openai.ts');
  const cohere = JSON.stringify({
    results: [
      { index: 0, relevance_score: 0.12 },
      { index: 2, relevance_score: 0.87 },
      { index: 1, relevance_score: 0.5 },
    ],
  });
  const hits = parseRerankResponse(cohere, 3);
  assert.deepEqual(hits.map((hit) => hit.index), [2, 1, 0], '必须按分降序');
  // 也兼容 score 字段名
  assert.deepEqual(
    parseRerankResponse(JSON.stringify({ results: [{ index: 1, score: 0.9 }] }), 2).map((hit) => hit.index),
    [1],
  );
  // 越界/缺分/非 JSON 都必须抛：坏数据不能当分数用
  assert.throws(() => parseRerankResponse(JSON.stringify({ results: [{ index: 3, relevance_score: 0.9 }] }), 3), /下标非法/);
  assert.throws(() => parseRerankResponse(JSON.stringify({ results: [{ index: 0 }] }), 1), /relevance_score/);
  assert.throws(() => parseRerankResponse('not json', 1), /不是合法 JSON/);
  assert.throws(() => parseRerankResponse(JSON.stringify({}), 1), /results/);
});

test('retrieveHybrid：rerank: model 用交叉编码器重排，并在 sources/notes 里写明用的哪个模型', async () => {
  const { createLexicalRerankStub } = await import('../src/rerank-openai.ts');
  const docs = [
    { id: 'a', kind: 'message' as const, text: '雪线以上的风' },
    { id: 'b', kind: 'message' as const, text: '铜铃响的时候别回头' },
    { id: 'c', kind: 'message' as const, text: '铜铃是父亲留下来的遗物' },
  ];
  const stub = createHashEmbeddingStub({ dimensions: 8 });
  const result = await retrieveHybrid('铜铃 遗物', docs, {
    embedder: stub,
    limit: 2,
    rerank: 'model',
    reranker: createLexicalRerankStub(),
  });
  assert.equal(result.mode, 'hybrid');
  assert.ok(result.sources.includes('stub-lexical-rerank'), 'sources 里要出现 rerank 模型');
  assert.ok(result.notes.some((note) => note.includes('rerank 模型重排')), '必须写清楚用了 rerank 模型');
  assert.ok(result.docs.length > 0);
});

test('retrieveHybrid：要求 rerank 模型但没给 reranker → 不静默降级，note 里说明原因', async () => {
  const docs = [{ id: 'a', kind: 'message' as const, text: '铜铃' }];
  const stub = createHashEmbeddingStub({ dimensions: 4 });
  const result = await retrieveHybrid('铜铃', docs, { embedder: stub, limit: 2, rerank: 'model' });
  assert.ok(result.notes.some((note) => note.includes('没有可用的 reranker')));
});