import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createOpenAiEmbeddingPort } from '../../packages/oplog/src/embedding-openai.ts';
import { createOpenAiRerankPort } from '../../packages/oplog/src/rerank-openai.ts';
import { retrieve, type RetrievalDoc } from '../../packages/oplog/src/retrieval.ts';
import { retrieveHybrid } from '../../packages/oplog/src/retrieval-hybrid.ts';
import { buildLongConversation, FACTS } from './harness.ts';

/**
 * **rerank 模型（交叉编码器）到底有没有用**：同一批查询下比 top-5 召回。
 *
 * 三条路的区别（别混为一谈）：
 *  - 纯词法：BM25；
 *  - 混合：BM25 + **embedding 模型**（双塔，出向量算余弦）用 RRF 合并；
 *  - 混合 + **rerank 模型**：先粗排 20 条，再让交叉编码器逐条打分排出前 5 —— 这是额外一次模型调用，
 *    与 embedding 完全是两类模型。
 *
 * 没有 `MOARK_API_KEY` 时**明确 skip**；embedding 向量复用 `embedding-recall.test.ts` 的缓存（省钱），
 * rerank 调用不缓存（每次都要真打分）。
 */

const API_KEY = process.env.MOARK_API_KEY ?? '';
const BASE_URL = process.env.MOARK_BASE_URL ?? 'https://api.moark.com/v1';
const EMBED_MODEL = process.env.EMBEDDING_MODEL ?? 'Qwen3-Embedding-8B';
const RERANK_MODEL = process.env.RERANK_MODEL ?? 'Qwen3-Reranker-8B';

const HISTORY = buildLongConversation();
const DOCS: RetrievalDoc[] = HISTORY.map((message, index) => ({
  id: `M${index + 1}`,
  text: message.content,
  kind: 'message',
}));
const CACHE = path.join(import.meta.dirname, '.cache', `embeddings-${EMBED_MODEL.replace(/[^\w.-]/g, '_')}.json`);

async function docVectors(): Promise<Map<string, number[]>> {
  const fingerprint = `${EMBED_MODEL}|${DOCS.length}|${DOCS[0]?.text ?? ''}|${DOCS[DOCS.length - 1]?.text ?? ''}`;
  try {
    const raw = JSON.parse(await readFile(CACHE, 'utf8')) as { fingerprint: string; vectors: number[][] };
    if (raw.fingerprint === fingerprint && raw.vectors.length === DOCS.length) {
      return new Map(DOCS.map((doc, index) => [doc.id, raw.vectors[index] ?? []]));
    }
  } catch {
    // 没有缓存：让 embedding-recall.test.ts 去算；这里不重复花钱
    throw new Error(`缺少文档向量缓存 ${CACHE}：先跑 eval/long-chat/embedding-recall.test.ts 生成它`);
  }
  throw new Error(`文档向量缓存与当前语料不匹配：${CACHE}`);
}

const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) =>
  fetch(url, { method: init.method, headers: init.headers, body: init.body, ...(init.signal === undefined ? {} : { signal: init.signal }) });

test('真实 rerank 模型：纯词法 vs 混合 vs 混合+交叉编码器重排 的 top-5 召回', async (t) => {
  if (API_KEY === '') {
    console.log('  [rerank] 没有 MOARK_API_KEY —— 跳过');
    t.skip('没有 MOARK_API_KEY：真实 rerank 模型对比需要它');
    return;
  }
  const vectors = await docVectors();
  const embedder = createOpenAiEmbeddingPort({ model: EMBED_MODEL, apiKey: API_KEY, baseUrl: BASE_URL, batchSize: 64, fetchImpl });
  const reranker = createOpenAiRerankPort({ model: RERANK_MODEL, apiKey: API_KEY, baseUrl: BASE_URL, fetchImpl });

  const WIDE = 20;
  const TOP = 5;
  let rerankCalls = 0;
  const measure = async (queries: readonly { query: string; target: string }[]) => {
    let lexical = 0;
    let hybrid = 0;
    let reranked = 0;
    // 名次比"top-5 命中"敏感：目标排到第 4 还是第 1，召回都是 1，但用户体验差很多
    let lexicalRank = 0;
    let hybridRank = 0;
    let rerankedRank = 0;
    const misses: string[] = [];
    const rankOf = (items: readonly { id: string }[], target: string): number => {
      const index = items.findIndex((item) => item.id === target);
      return index < 0 ? Infinity : index + 1;
    };
    for (const { query, target } of queries) {
      const l = retrieve(query, DOCS, { limit: TOP });
      const h = await retrieveHybrid(query, DOCS, { embedder, vectors, limit: WIDE });
      const r = await retrieveHybrid(query, DOCS, {
        embedder,
        vectors,
        limit: TOP,
        rerank: 'model',
        reranker,
        rerankCandidates: WIDE,
      });
      rerankCalls += 1;
      const lHit = l.some((item) => item.id === target);
      const hHit = h.docs.slice(0, TOP).some((item) => item.id === target);
      const rHit = r.docs.some((item) => item.id === target);
      if (lHit) lexical += 1;
      if (hHit) hybrid += 1;
      if (rHit) reranked += 1;
      const lRank = rankOf(l.slice(0, TOP), target);
      const hRank = rankOf(h.docs.slice(0, TOP), target);
      const rRank = rankOf(r.docs, target);
      lexicalRank += lRank === Infinity ? 0 : 1 / lRank;
      hybridRank += hRank === Infinity ? 0 : 1 / hRank;
      rerankedRank += rRank === Infinity ? 0 : 1 / rRank;
      if (!rHit) misses.push(`${query}→${target}｜重排 top3=${r.docs.slice(0, 3).map((i) => i.id).join(',') || '无'}`);
    }
    return {
      lexical,
      hybrid,
      reranked,
      total: queries.length,
      misses,
      mrr: [lexicalRank / queries.length, hybridRank / queries.length, rerankedRank / queries.length],
    };
  };

  const factQueries = FACTS.map((fact) => ({ query: fact.text, target: `M${fact.at}` }));
  const paraphraseQueries = [
    { query: '她叫什么名字？', target: 'M300' },
    { query: '有没有人知道她的身份？', target: 'M300' },
    { query: '阿霜是谁？', target: 'M300' },
    { query: '那把刀是怎么来的？', target: 'M60' },
    { query: '哪儿能躲开风雪？', target: 'M465' },
  ];

  const facts = await measure(factQueries);
  const paraphrases = await measure(paraphraseQueries);

  console.log(`  [rerank] embedding 模型 ${EMBED_MODEL}｜rerank 模型 **${RERANK_MODEL}**（交叉编码器）｜粗排 ${WIDE} → 精排 ${TOP}`);
  const fmt = (mrr: readonly number[]): string => mrr.map((value) => value.toFixed(2)).join('｜');
  console.log(
    `  [rerank·词面提问] top-5 召回：纯词法 ${facts.lexical}/${facts.total}｜混合 ${facts.hybrid}/${facts.total}｜混合+rerank ${facts.reranked}/${facts.total}｜MRR 词法/混合/重排 ${fmt(facts.mrr)}`,
  );
  console.log(
    `  [rerank·改写提问] top-5 召回：纯词法 ${paraphrases.lexical}/${paraphrases.total}｜混合 ${paraphrases.hybrid}/${paraphrases.total}｜混合+rerank ${paraphrases.reranked}/${paraphrases.total}｜MRR 词法/混合/重排 ${fmt(paraphrases.mrr)}`,
  );
  for (const line of [...paraphrases.misses, ...facts.misses.slice(0, 5)]) console.log('    ✗ ' + line);

  // 只断言"真的调了 rerank 模型"；效果好坏由上面的数字说话
  assert.ok(rerankCalls > 0);
  const probe = await retrieveHybrid('她叫什么名字？', DOCS, { embedder, vectors, limit: TOP, rerank: 'model', reranker });
  assert.ok(probe.sources.includes(reranker.id), `sources 里必须有 rerank 模型，实际 ${probe.sources.join('+')}`);
  assert.ok(probe.notes.some((note) => note.includes('rerank 模型重排')));
});
