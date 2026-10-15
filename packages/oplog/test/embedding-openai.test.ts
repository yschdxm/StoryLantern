import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOpenAiEmbeddingPort,
  normalizeVector,
  parseEmbeddingResponse,
  type EmbeddingFetch,
  type EmbeddingFetchResponse,
} from '../src/embedding-openai.ts';

/**
 * OpenAI 兼容 embeddings 适配器的测试（**全部离线**，用一个假 fetch）。
 *
 * 要钉住的是四件容易错的事：
 *  1. 响应按 \`index\` 排序 —— 乱序的返回绝不能和请求的顺序错配（错了就是把 A 的向量当成 B 的）；
 *  2. 批量切分与**条数不匹配要抛** —— 少一条就整批失败的语义必须明确，不能悄悄少算；
 *  3. 重试策略：5xx/429 值得重试，**4xx 不必**（密钥或参数错了，重试只是浪费时间）；
 *  4. 归一化：有的模型返回归一化过的、有的没有，这边统一 L2 归一化；零向量原样返回。
 */

function response(status: number, body: unknown): EmbeddingFetchResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : (JSON.stringify(body) ?? '')) };
}

function openAiBody(vectors: number[][], promptTokens = 7): unknown {
  return { data: vectors.map((embedding, index) => ({ index, embedding })), usage: { prompt_tokens: promptTokens } };
}

interface Recorded {
  url: string;
  inputs: string[];
  authorization: string;
}

function fakeFetch(handler: (call: number, inputs: string[]) => EmbeddingFetchResponse): { fetch: EmbeddingFetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl: EmbeddingFetch = async (url, init) => {
    const body = JSON.parse(init.body) as { input: string[] };
    calls.push({ url, inputs: body.input, authorization: init.headers.authorization ?? '' });
    return handler(calls.length, body.input);
  };
  return { fetch: fetchImpl, calls };
}

test('解析响应：按 index 排序、带出 prompt_tokens；坏数据一律抛（不把噪声当语义）', () => {
  const parsed = parseEmbeddingResponse(
    JSON.stringify({ data: [{ index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] }], usage: { prompt_tokens: 12 } }),
  );
  assert.deepEqual(parsed.vectors, [[1, 2], [3, 4]], '必须按 index 还原顺序');
  assert.equal(parsed.promptTokens, 12);

  assert.throws(() => parseEmbeddingResponse('这不是 JSON'), /不是合法 JSON/);
  assert.throws(() => parseEmbeddingResponse(JSON.stringify({ data: 'nope' })), /缺少 data/);
  assert.throws(() => parseEmbeddingResponse(JSON.stringify({ data: [{ index: 0 }] })), /缺少 embedding/);
  assert.throws(() => parseEmbeddingResponse(JSON.stringify({ data: [{ index: 0, embedding: [1, 'x'] }] })), /非数值/);
});

test('归一化：[3,4] → [0.6,0.8]；零向量原样返回（不能让余弦变成 NaN）', () => {
  assert.deepEqual(normalizeVector([3, 4]), [0.6, 0.8]);
  assert.deepEqual(normalizeVector([0, 0]), [0, 0]);
  const normalized = normalizeVector([0.6, 0.8]);
  assert.ok(Math.abs((normalized[0] ?? 0) - 0.6) < 1e-12);
});

test('批量切分：5 条、batchSize 2 → 3 次请求，顺序不乱，用量按次回调', async () => {
  const { fetch, calls } = fakeFetch((_call, inputs) => response(200, openAiBody(inputs.map((text) => [text.length, 1]))));
  const usages: Array<{ requests: number; promptTokens: number }> = [];
  const port = createOpenAiEmbeddingPort({
    model: 'Qwen3-Embedding-8B',
    apiKey: 'secret-should-not-appear-anywhere',
    baseUrl: 'https://api.moark.com/v1',
    batchSize: 2,
    fetchImpl: fetch,
    onUsage: (usage) => usages.push(usage),
  });

  const vectors = await port.embed(['a', 'bb', 'ccc', 'dddd', 'eeeee']);
  assert.equal(calls.length, 3, '5 条按 2 条一批应当切 3 次');
  assert.deepEqual(calls.map((call) => call.inputs.length), [2, 2, 1]);
  assert.deepEqual(calls.map((call) => call.inputs.join('')), ['abb', 'cccdddd', 'eeeee'], '顺序不能串');
  assert.equal(vectors.length, 5);
  // 归一化之后 [len,1] 的长度是 1
  assert.ok(Math.abs(Math.hypot(...(vectors[0] ?? [])) - 1) < 1e-12);
  assert.equal(calls[0]?.url, 'https://api.moark.com/v1/embeddings');
  assert.equal(calls[0]?.authorization, 'Bearer secret-should-not-appear-anywhere');
  assert.equal(port.id, 'Qwen3-Embedding-8B@api.moark.com');
  assert.deepEqual(usages, [{ requests: 1, promptTokens: 7 }, { requests: 1, promptTokens: 7 }, { requests: 1, promptTokens: 7 }]);
});

test('重试：5xx 再试（最多 retries 次），4xx 立刻失败（密钥/参数错了重试没意义）', async () => {
  let call = 0;
  const flaky = fakeFetch(() => {
    call += 1;
    return call === 1 ? response(503, 'busy') : response(200, openAiBody([[1, 0]]));
  });
  const port = createOpenAiEmbeddingPort({ model: 'm', apiKey: 'k', fetchImpl: flaky.fetch, retries: 2 });
  assert.deepEqual(await port.embed(['x']), [[1, 0]]);
  assert.equal(flaky.calls.length, 2, '503 应当重试一次就成功');

  const denied = fakeFetch(() => response(401, { error: 'unauthorized' }));
  const deniedPort = createOpenAiEmbeddingPort({ model: 'm', apiKey: 'bad', fetchImpl: denied.fetch, retries: 2 });
  await assert.rejects(() => deniedPort.embed(['x']), /HTTP 401/);
  assert.equal(denied.calls.length, 1, '4xx 不该重试');
});

test('条数不匹配就抛：少一条意味着整批不可信，不能悄悄少算', async () => {
  const { fetch } = fakeFetch(() => response(200, openAiBody([[1, 0]])));
  const port = createOpenAiEmbeddingPort({ model: 'm', apiKey: 'k', batchSize: 4, fetchImpl: fetch });
  await assert.rejects(() => port.embed(['a', 'b']), /条数不匹配/);
});
