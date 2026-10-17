import { createOpenAiRerankPort, parseRerankResponse, type RerankPort } from '../../../../packages/oplog/src/index.ts';
import { WireClient, type WireTransport } from '../../../../packages/wire/src/index.ts';

/**
 * 把宿主的 `chat.rerank` 命令包成 **RerankPort**（交叉编码器）。
 *
 * 与 `embedding-host.ts` 的区别（别混）：
 *  - `chat.embed` → embedding 模型（双塔，出向量）；
 *  - `chat.rerank` → **rerank 模型**（交叉编码器，直接给 query+文档 打分）。
 *
 * 密钥同样**不进前端**：这里传空 apiKey，宿主按 profileId 自己注入。
 */
export const DEFAULT_RERANK_MODEL = 'Qwen3-Reranker-8B';

export interface HostRerankOptions {
  transport: WireTransport;
  /** rerank 模型 id（例如 Qwen3-Reranker-8B / bge-reranker-v2-m3）。空串 = 端口不可用（调用方应跳过）。 */
  model: string;
  /** 用哪份模型配置的地址与密钥（不给 = 设置里的默认那组）。 */
  profileId?: string;
  /** 每次 HTTP 请求的回调（记账用）。 */
  onUsage?: (usage: { requests: number }) => void;
}

interface WireRerankResult {
  status: number;
  body: string;
  resolved?: { baseUrl?: string; model?: string; keyConfigured?: boolean; source?: string };
}

export function createHostRerankPort(options: HostRerankOptions): RerankPort {
  const client = new WireClient(options.transport);
  const model = options.model.trim();
  return createOpenAiRerankPort({
    model: model === '' ? 'default' : model,
    apiKey: '', // 密钥由宿主注入，前端拿不到也不需要
    baseUrl: 'host://chat.rerank', // 只用于端口 id；真正请求由宿主发出
    id: `${model === '' ? 'default' : model}@host`,
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(init.body) as { query: string; documents: string[]; top_n?: number };
      const result = await client.call<WireRerankResult>('chat', 'rerank', {
        ...(options.profileId === undefined || options.profileId === '' ? {} : { profileId: options.profileId }),
        ...(model === '' ? {} : { model }),
        query: payload.query,
        documents: payload.documents,
        ...(payload.top_n === undefined ? {} : { topN: payload.top_n }),
      });
      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        statusText: String(result.status),
        text: async () => result.body,
      };
    },
    ...(options.onUsage === undefined ? {} : { onUsage: options.onUsage }),
  });
}

/** 自检：给两条文档打分，返回排序结果与耗时（给设置里的「测试 rerank 模型」按钮用）。 */
export async function probeRerank(options: HostRerankOptions): Promise<
  | { ok: true; order: { index: number; score: number }[]; ms: number; resolved?: WireRerankResult['resolved'] }
  | { ok: false; message: string; resolved?: WireRerankResult['resolved'] }
> {
  const started = Date.now();
  const client = new WireClient(options.transport);
  const model = options.model.trim();
  try {
    const result = await client.call<WireRerankResult>('chat', 'rerank', {
      ...(options.profileId === undefined || options.profileId === '' ? {} : { profileId: options.profileId }),
      ...(model === '' ? {} : { model: model }),
      query: '铜铃是什么',
      documents: ['铜铃是父亲留下来的遗物。', '雪线以上的风很冷。'],
    });
    if (result.status < 200 || result.status >= 300) {
      return { ok: false, message: `HTTP ${result.status}：${result.body.slice(0, 200)}`, ...(result.resolved === undefined ? {} : { resolved: result.resolved }) };
    }
    const order = parseRerankResponse(result.body, 2);
    return { ok: true, order, ms: Date.now() - started, ...(result.resolved === undefined ? {} : { resolved: result.resolved }) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
