import { createOpenAiEmbeddingPort, type EmbeddingPort } from '../../../../packages/oplog/src/index.ts';
import { WireClient, type WireTransport } from '../../../../packages/wire/src/index.ts';

/**
 * 把宿主的 \`chat.embed\` 命令包成 \`EmbeddingPort\`。
 *
 * **密钥不进前端**：这里传的 \`apiKey\` 是空串 —— 请求头由宿主持有并按 \`profileId\` 自己注入
 * （与 \`chat.reply\` 同一条纪律；\`store.rs\` 里 \`api_key\` 这类键在 wire 上只回掩码）。
 * 前端只负责把它发给谁、发什么文本。
 *
 * 解析（\`index\` 顺序、维度、usage、归一化、批量切分、重试）**全部复用**
 * \`createOpenAiEmbeddingPort\` —— 宿主命令原样回响应体，所以那套已单测的代码直接用得上。
 */
/**
 * 默认向量模型：实测（eval/long-chat/embedding-recall.test.ts）Qwen3-Embedding-8B/4B/0.6B 与
 * bge-large-zh-v1.5 在**本项目的检索任务**上打平，故按"质量优先 + 多语言"取 8B；
 * 想省延迟/成本可在设置里改 embedding.model（0.6B 单条 306ms vs 8B 856ms）。
 */
export const DEFAULT_EMBEDDING_MODEL = 'Qwen3-Embedding-8B';

export interface HostEmbeddingOptions {
  transport: WireTransport;
  /** 用哪份模型配置的地址与密钥（不给 = 设置里的默认那组）。 */
  profileId?: string;
  /** 向量模型 id（例如 Qwen3-Embedding-8B）；不给就用配置里的模型名。 */
  model?: string;
  /** 每次 HTTP 请求的回调（记账用）。 */
  onUsage?: (usage: { requests: number; promptTokens: number }) => void;
}

interface WireEmbedResult {
  status: number;
  body: string;
}

export function createHostEmbeddingPort(options: HostEmbeddingOptions): EmbeddingPort {
  const client = new WireClient(options.transport);
  const model = options.model?.trim() ?? '';
  return createOpenAiEmbeddingPort({
    model: model === '' ? 'default' : model,
    apiKey: '', // 见文件头：密钥由宿主注入，前端拿不到也不需要
    baseUrl: 'host://chat.embed', // 只是用来拼端口 id；真正请求由宿主发出
    id: `${model === '' ? 'default' : model}@host`,
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(init.body) as { model: string; input: string[] };
      const result = await client.call<WireEmbedResult>('chat', 'embed', {
        ...(options.profileId === undefined || options.profileId === '' ? {} : { profileId: options.profileId }),
        ...(model === '' ? {} : { model }),
        input: payload.input,
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

/** 向量自检：只嵌一句，返回维度与耗时（给设置里的「测试向量来源」按钮用）。 */
export async function probeEmbedding(
  options: HostEmbeddingOptions,
): Promise<{ ok: true; dimensions: number; ms: number } | { ok: false; message: string }> {
  const started = Date.now();
  try {
    const port = createHostEmbeddingPort(options);
    const vectors = await port.embed(['铜铃是父亲留下来的遗物。']);
    const first = vectors[0];
    if (first === undefined) return { ok: false, message: '没有返回向量' };
    return { ok: true, dimensions: first.length, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
