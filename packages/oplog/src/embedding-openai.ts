import type { EmbeddingPort } from './retrieval-hybrid.ts';

/**
 * OpenAI 兼容的 embeddings 适配器（真实向量来源）。
 *
 * 实测（moark，2026-10-15）：\`POST {base}/embeddings {model, input:[...]}\` →
 * \`{data:[{index, embedding:[...]}], usage:{prompt_tokens}}\`；Qwen3-Embedding-8B / 0.6B /
 * bge-m3 / bge-large-zh-v1.5 都是 **1024 维**，jina-embeddings-v4 是 2048 维 —— 所以**维度不写死**。
 *
 * 三条设计：
 *  1. **批量**：input 直接给数组，按 batchSize 切（40 条一批实测 1–2.5 s）；
 *  2. **归一化**：拿回来自己 L2 归一化（有的模型返回归一化过的、有的没有；我不去猜）；
 *  3. **失败要能被回退规则接住**：非 2xx / 解析失败一律抛错 —— 混合检索那边会降级成纯词法并告警，
 *     所以这里不需要"尽力而为地返回零向量"（那只会把噪声当语义）。
 *
 * 它不知道密钥从哪来：调用方给 \`apiKey\`。**应用里那条链是宿主持有密钥**，所以要由宿主命令来调它。
 */

export interface EmbeddingFetchResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}

export type EmbeddingFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<EmbeddingFetchResponse>;

export interface OpenAiEmbeddingOptions {
  model: string;
  apiKey: string;
  fetchImpl: EmbeddingFetch;
  /** 默认 https://api.openai.com/v1（moark 是 https://api.moark.com/v1）。 */
  baseUrl?: string;
  /** 一次请求里最多几条（默认 64）。 */
  batchSize?: number;
  timeoutMs?: number;
  /** 失败重试次数（网络抖动/429；默认 2，也就是最多试 3 次）。 */
  retries?: number;
  /** 端口标识：会显示在检索结果的 sources 里，默认 `model@host`。 */
  id?: string;
  /** 用量回调（记账用）：每次 HTTP 请求报一次。 */
  onUsage?: (usage: { requests: number; promptTokens: number }) => void;
}

export interface ParsedEmbeddingResponse {
  vectors: number[][];
  promptTokens: number;
}

/** 纯函数：解析 OpenAI 兼容响应。字段不对就抛，别把坏数据当向量用。 */
export function parseEmbeddingResponse(body: string): ParsedEmbeddingResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('embeddings 响应不是合法 JSON');
  }
  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error('embeddings 响应缺少 data 数组');
  const vectors = data
    .slice()
    .sort((left, right) => ((left as { index?: number }).index ?? 0) - ((right as { index?: number }).index ?? 0))
    .map((item) => {
      const embedding = (item as { embedding?: unknown }).embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) throw new Error('embeddings 条目缺少 embedding');
      return embedding.map((value) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('embeddings 里有非数值');
        return value;
      });
    });
  const usage = (parsed as { usage?: { prompt_tokens?: unknown } }).usage;
  const promptTokens = typeof usage?.prompt_tokens === 'number' && Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0;
  return { vectors, promptTokens };
}

/** L2 归一化（零向量原样返回：余弦那边会算成 0，而不是 NaN）。 */
export function normalizeVector(vector: readonly number[]): number[] {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  return norm === 0 ? [...vector] : vector.map((value) => value / norm);
}

function hostOf(url: string): string {
  const match = /^https?:\/\/([^/]+)/.exec(url);
  return match?.[1] ?? url;
}

export function createOpenAiEmbeddingPort(options: OpenAiEmbeddingOptions): EmbeddingPort {
  const endpoint = `${(options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/embeddings`;
  const batchSize = options.batchSize ?? 64;
  const retries = options.retries ?? 2;
  const timeoutMs = options.timeoutMs ?? 60_000;

  async function embedBatch(texts: readonly string[]): Promise<number[][]> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await options.fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify({ model: options.model, input: texts }),
          signal: controller.signal,
        });
        const body = await response.text();
        if (!response.ok) {
          const message = `embeddings 请求失败：HTTP ${response.status} ${response.statusText ?? ''} ${body.slice(0, 200)}`;
          // 4xx 不必重试（密钥/参数问题），5xx 与 429 值得再试。
          // 注意必须标成 fatal：直接 throw 会被下面自己的 catch 抓住、当成"可重试" —— 测试抓到过这个 bug。
          if (response.status < 500 && response.status !== 429) throw Object.assign(new Error(message), { fatal: true });
          if (attempt === retries) throw Object.assign(new Error(message), { fatal: true });
          lastError = new Error(`HTTP ${response.status}`);
        } else {
          const parsed = parseEmbeddingResponse(body);
          options.onUsage?.({ requests: 1, promptTokens: parsed.promptTokens });
          return parsed.vectors;
        }
      } catch (error) {
        // fatal 的（比如 4xx）立刻冒泡，绝不重试
        if ((error as { fatal?: boolean } | undefined)?.fatal === true) throw error;
        lastError = error;
        if (attempt === retries) throw error;
      } finally {
        clearTimeout(timer);
      }
      // 退避：给服务端一点时间（不打印任何密钥）
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  return {
    id: options.id ?? `${options.model}@${hostOf(endpoint)}`,
    async embed(texts) {
      const out: number[][] = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        const slice = texts.slice(start, start + batchSize);
        if (slice.length === 0) continue;
        const vectors = await embedBatch(slice);
        if (vectors.length !== slice.length) {
          throw new Error(`embeddings 条数不匹配：请求 ${slice.length} 条，返回 ${vectors.length} 条`);
        }
        for (const vector of vectors) out.push(normalizeVector(vector));
      }
      return out;
    },
  };
}
