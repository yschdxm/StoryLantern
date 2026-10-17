/**
 * **rerank 模型**适配器（交叉编码器 / cross-encoder）。
 *
 * 和 `embedding-openai.ts` **不是一回事**，别混：
 *  - embedding 模型是**双塔**：查询与文档各自编码成向量，再算余弦 —— 快，但语义比较粗；
 *  - rerank 模型是**交叉编码器**：把 query 与每篇文档拼在一起过一遍模型，直接输出相关性分 —— 慢，
 *    但排序明显更准。工程上的分工是：先用检索（词法 + 向量）取出 20 条，再让 rerank 模型排出前 5。
 *
 * 实测（moark，2026-10-17）：`POST {base}/rerank {model, query, documents:[...], top_n}` →
 * `{results:[{index, document:{text}, relevance_score}]}`（按分降序返回）。
 * 可用模型：`bge-reranker-v2-m3`、`Qwen3-Reranker-8B/4B/0.6B`、`bge-reranker-large`、`bce-reranker-base_v1`。
 *
 * 设计同 embedding 那条：批量、失败抛错（由调用方降级并告警）、不猜响应格式、不把坏数据当分数。
 * 密钥同样**不由这里持有**：生产链路里由宿主调（前端只给 profileId）。
 */

export interface RerankHit {
  /** 文档在输入数组里的下标。 */
  index: number;
  /** 相关性分（越大越相关；不同模型量纲不同，只在同一次调用内可比）。 */
  score: number;
}

export interface RerankPort {
  readonly id: string;
  rerank(query: string, documents: readonly string[], options?: { topN?: number }): Promise<RerankHit[]>;
}

export interface RerankFetchResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}

export type RerankFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<RerankFetchResponse>;

/**
 * 纯函数：解析 `/rerank` 响应。
 *
 * 兼容两种常见形态（都见过）：
 *  - `{results:[{index, relevance_score}]}`（Cohere/Jina 系）；
 *  - `{results:[{index, score}]}`。
 * `documentCount` 用来校验下标范围：越界说明响应与请求对不上，必须抛错而不是悄悄用。
 */
export function parseRerankResponse(body: string, documentCount: number): RerankHit[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('rerank 响应不是合法 JSON');
  }
  const results = (parsed as { results?: unknown }).results;
  if (!Array.isArray(results)) throw new Error('rerank 响应缺少 results 数组');
  const hits: RerankHit[] = results.map((item) => {
    const record = item as { index?: unknown; relevance_score?: unknown; score?: unknown };
    const index = record.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= documentCount) {
      throw new Error(`rerank 返回的下标非法：${String(index)}（文档只有 ${documentCount} 条）`);
    }
    const rawScore = record.relevance_score ?? record.score;
    if (typeof rawScore !== 'number' || !Number.isFinite(rawScore)) {
      throw new Error(`rerank 第 ${index} 条缺少可用的 relevance_score`);
    }
    return { index, score: rawScore };
  });
  return hits.sort((left, right) => right.score - left.score || left.index - right.index);
}

export interface OpenAiRerankOptions {
  model: string;
  apiKey: string;
  fetchImpl: RerankFetch;
  /** 默认 https://api.moark.com/v1。 */
  baseUrl?: string;
  timeoutMs?: number;
  /** 失败重试次数（网络抖动/429；默认 1，也就是最多试 2 次）。 */
  retries?: number;
  /** 端口标识：会显示在检索结果的 sources 里。 */
  id?: string;
  /** 用量回调（记账用）。 */
  onUsage?: (usage: { requests: number }) => void;
}

function hostOf(url: string): string {
  const match = /^https?:\/\/([^/]+)/.exec(url);
  return match?.[1] ?? url;
}

export function createOpenAiRerankPort(options: OpenAiRerankOptions): RerankPort {
  const endpoint = `${(options.baseUrl ?? 'https://api.moark.com/v1').replace(/\/$/, '')}/rerank`;
  const retries = options.retries ?? 1;
  const timeoutMs = options.timeoutMs ?? 60_000;

  return {
    id: options.id ?? `${options.model}@${hostOf(endpoint)}`,
    async rerank(query, documents, rerankOptions = {}) {
      if (documents.length === 0) return [];
      const body = JSON.stringify({
        model: options.model,
        query,
        documents,
        ...(rerankOptions.topN === undefined ? {} : { top_n: rerankOptions.topN }),
      });
      let lastError: unknown;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await options.fetchImpl(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
            body,
            signal: controller.signal,
          });
          const text = await response.text();
          if (!response.ok) {
            const message = `rerank 请求失败：HTTP ${response.status} ${response.statusText ?? ''} ${text.slice(0, 200)}`;
            // 4xx 不重试（密钥/参数问题）；5xx 与 429 值得再试
            if (response.status < 500 && response.status !== 429) throw Object.assign(new Error(message), { fatal: true });
            if (attempt === retries) throw Object.assign(new Error(message), { fatal: true });
            lastError = new Error(`HTTP ${response.status}`);
          } else {
            const hits = parseRerankResponse(text, documents.length);
            options.onUsage?.({ requests: 1 });
            return rerankOptions.topN === undefined ? hits : hits.slice(0, rerankOptions.topN);
          }
        } catch (error) {
          if ((error as { fatal?: boolean } | undefined)?.fatal === true) throw error;
          lastError = error;
          if (attempt === retries) throw error;
        } finally {
          clearTimeout(timer);
        }
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },
  };
}

/**
 * **测试桩**：按"查询词是否出现在文档里"给分 —— 它**不是**语义重排，
 * 只能用来验证"模型重排的管线与回退规则"。id 里带 stub 是故意的。
 */
export function createLexicalRerankStub(): RerankPort {
  return {
    id: 'stub-lexical-rerank',
    async rerank(query, documents) {
      const terms = query.split(/[\s，。、？！,.!?]+/).filter((term) => term !== '');
      return documents
        .map((text, index) => ({ index, score: terms.filter((term) => text.includes(term)).length }))
        .sort((left, right) => right.score - left.score || left.index - right.index);
    },
  };
}
