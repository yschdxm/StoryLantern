import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createOpenAiEmbeddingPort } from '../../packages/oplog/src/embedding-openai.ts';
import { retrieve, type RetrievalDoc } from '../../packages/oplog/src/retrieval.ts';
import { retrieveHybrid } from '../../packages/oplog/src/retrieval-hybrid.ts';
import { buildLongConversation, FACTS } from './harness.ts';

/**
 * **真实向量来源**下的召回测量（M4 第三块的那一半）。
 *
 * 与 \`retrieval.test.ts\` 的分工：那边用哈希桩证明"管线通"，这里用**真实 embedding**（moark）
 * 量"语义那一半到底补回了多少"。重点看**改写式提问**——那是词法检索够不着的地方。
 *
 * 没有 \`MOARK_API_KEY\` 时**明确 skip**（不许假跑，也不许悄悄绿着）。文档向量会缓存到
 * \`eval/long-chat/.cache/\`（可重复跑，不重复花钱）；缓存里只有向量，没有密钥。
 */

const API_KEY = process.env.MOARK_API_KEY ?? '';
const BASE_URL = process.env.MOARK_BASE_URL ?? 'https://api.moark.com/v1';
const MODEL = process.env.EMBEDDING_MODEL ?? 'Qwen3-Embedding-8B';

const HISTORY = buildLongConversation();
const DOCS: RetrievalDoc[] = HISTORY.map((message, index) => ({
  id: `M${index + 1}`,
  text: message.content,
  kind: 'message',
}));

const CACHE = path.join(import.meta.dirname, '.cache', `embeddings-${MODEL.replace(/[^\w.-]/g, '_')}.json`);

/** 取（或算一次并缓存）全部文档向量。缓存只存向量与语料指纹，不存密钥。 */
async function docVectors(): Promise<{ vectors: Map<string, number[]>; fromCache: boolean; requests: number; ms: number }> {
  const fingerprint = `${MODEL}|${DOCS.length}|${DOCS[0]?.text ?? ''}|${DOCS[DOCS.length - 1]?.text ?? ''}`;
  try {
    const raw = JSON.parse(await readFile(CACHE, 'utf8')) as { fingerprint: string; vectors: number[][] };
    if (raw.fingerprint === fingerprint && raw.vectors.length === DOCS.length) {
      return {
        vectors: new Map(DOCS.map((doc, index) => [doc.id, raw.vectors[index] ?? []])),
        fromCache: true,
        requests: 0,
        ms: 0,
      };
    }
  } catch {
    // 没有缓存或缓存失效：照常重新算
  }
  let requests = 0;
  let promptTokens = 0;
  const port = createOpenAiEmbeddingPort({
    model: MODEL,
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    batchSize: 64,
    fetchImpl: async (url, init) =>
      fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        ...(init.signal === undefined ? {} : { signal: init.signal }),
      }),
    onUsage: (usage) => {
      requests += usage.requests;
      promptTokens += usage.promptTokens;
    },
  });
  const started = Date.now();
  const vectors = await port.embed(DOCS.map((doc) => doc.text));
  const ms = Date.now() - started;
  await mkdir(path.dirname(CACHE), { recursive: true });
  await writeFile(CACHE, JSON.stringify({ fingerprint, model: MODEL, promptTokens, vectors }), 'utf8');
  console.log(`  [向量] 算了 ${vectors.length} 条（${requests} 次请求、${promptTokens} prompt tokens、${ms} ms），已缓存`);
  return { vectors: new Map(DOCS.map((doc, index) => [doc.id, vectors[index] ?? []])), fromCache: false, requests, ms };
}

test('真实向量：词法 vs 词法+向量的召回对比（词面提问 + 改写式提问），无密钥则 skip', async (t) => {
  if (API_KEY === '') {
    console.log(
      '  [真实向量] 没有 MOARK_API_KEY —— 跳过。要跑：\n' +
        '    $env:MOARK_API_KEY = "..." ; node --test eval/long-chat/embedding-recall.test.ts',
    );
    t.skip('没有 MOARK_API_KEY：真实向量的召回对比需要它');
    return;
  }

  const { vectors, fromCache, ms } = await docVectors();
  assert.equal(vectors.size, DOCS.length);
  const dimension = vectors.get('M1')?.length ?? 0;
  assert.ok(dimension > 0, '向量维度应当大于 0');

  const embedder = {
    id: `${MODEL}@real`,
    async embed(texts: readonly string[]) {
      // 查询向量单独算：只有一两条，不值得缓存
      const port = createOpenAiEmbeddingPort({
        model: MODEL,
        apiKey: API_KEY,
        baseUrl: BASE_URL,
        fetchImpl: async (url, init) =>
          fetch(url, { method: init.method, headers: init.headers, body: init.body, ...(init.signal === undefined ? {} : { signal: init.signal }) }),
      });
      return port.embed(texts);
    },
  };

  console.log(`  [真实向量] 模型 ${MODEL}｜维度 ${dimension}｜文档向量${fromCache ? '来自缓存' : `新算（${ms} ms）`}`);

  // ① 词面提问：五条埋点事实的原文
  let lexicalFacts = 0;
  let hybridFacts = 0;
  for (const fact of FACTS) {
    const lexical = retrieve(fact.text, DOCS, { limit: 5 });
    const hybrid = await retrieveHybrid(fact.text, DOCS, { embedder, vectors, limit: 5 });
    if (lexical.some((item) => item.id === `M${fact.at}`)) lexicalFacts += 1;
    if (hybrid.docs.some((item) => item.id === `M${fact.at}`)) hybridFacts += 1;
  }

  // ② 改写式提问：词法够不着的地方（目标 = 第 300 条）
  const paraphrases = ['她叫什么名字？', '有没有人知道她的身份？', '阿霜是谁？'];
  let lexicalParaphrase = 0;
  let hybridParaphrase = 0;
  const detail: string[] = [];
  for (const query of paraphrases) {
    const lexical = retrieve(query, DOCS, { limit: 5 });
    const hybrid = await retrieveHybrid(query, DOCS, { embedder, vectors, limit: 5 });
    const lexicalHit = lexical.some((item) => item.id === 'M300');
    const hybridHit = hybrid.docs.some((item) => item.id === 'M300');
    if (lexicalHit) lexicalParaphrase += 1;
    if (hybridHit) hybridParaphrase += 1;
    detail.push(`    ${hybridHit ? '✓' : '✗'} ${query}｜词法 top3=${lexical.slice(0, 3).map((i) => i.id).join(',') || '无'}｜混合 top3=${hybrid.docs.slice(0, 3).map((i) => i.id).join(',') || '无'}（模式 ${hybrid.mode}）`);
  }

  console.log(`  [真实向量·词面提问] 事实召回：纯词法 ${lexicalFacts}/${FACTS.length} vs 词法+向量 ${hybridFacts}/${FACTS.length}`);
  console.log(`  [真实向量·改写提问] 目标第 300 条：纯词法 ${lexicalParaphrase}/${paraphrases.length} vs 词法+向量 ${hybridParaphrase}/${paraphrases.length}`);
  for (const line of detail) console.log(line);

  // 只断言"量到了且是混合模式"——质量高低由上面的数字说话，不在这里自夸
  const probe = await retrieveHybrid(paraphrases[0] ?? '', DOCS, { embedder, vectors, limit: 5 });
  assert.equal(probe.mode, 'hybrid');
  assert.deepEqual(probe.sources, ['bm25', embedder.id]);
});
