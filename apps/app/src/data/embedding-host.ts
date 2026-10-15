import { createOpenAiEmbeddingPort, parseEmbeddingResponse, type EmbeddingPort } from '../../../../packages/oplog/src/index.ts';
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

export interface WireEmbedResolved {
  baseUrl?: string;
  model?: string;
  profilesInStore?: number;
  matchedFields?: string;
  keyConfigured?: boolean;
  fellBackToLegacy?: boolean;
}

/** 把宿主的诊断信息压成一行给人看（只说地址与字段名，**没有密钥内容**）。 */
export function formatResolved(resolved: WireEmbedResolved | undefined): string {
  if (resolved === undefined) return '';
  return (
    `宿主用的地址=${resolved.baseUrl ?? '（空）'}｜模型=${resolved.model ?? '（空）'}` +
    `｜profiles 里 ${resolved.profilesInStore ?? '?'} 条（匹配那条字段名=[${resolved.matchedFields ?? '?'}]）` +
    `｜密钥${resolved.keyConfigured === true ? '已配置' : '未配置'}${resolved.fellBackToLegacy === true ? '｜已回退到旧字段' : ''}`
  );
}

/** 向量自检：只嵌一句，返回维度与耗时（给设置里的「测试向量来源」按钮用）。 */
export async function probeEmbedding(
  options: HostEmbeddingOptions,
): Promise<{ ok: true; dimensions: number; ms: number; resolved: WireEmbedResolved } | { ok: false; message: string; resolved?: WireEmbedResolved }> {
  const started = Date.now();
  const client = new WireClient(options.transport);
  const model = options.model?.trim() ?? '';
  try {
    // 直接调宿主命令（不走端口）：这样才能把 resolved 诊断一起拿到并显示出来
    const result = await client.call<{ status: number; body: string; resolved?: WireEmbedResolved }>('chat', 'embed', {
      ...(options.profileId === undefined || options.profileId === '' ? {} : { profileId: options.profileId }),
      ...(model === '' ? {} : { model }),
      input: ['铜铃是父亲留下来的遗物。'],
    });
    if (result.status < 200 || result.status >= 300) {
      return { ok: false, message: `HTTP ${result.status}：${result.body.slice(0, 200)}`, ...(result.resolved === undefined ? {} : { resolved: result.resolved }) };
    }
    const parsed = parseEmbeddingResponse(result.body);
    const first = parsed.vectors[0];
    if (first === undefined) return { ok: false, message: '没有返回向量' };
    return { ok: true, dimensions: first.length, ms: Date.now() - started, resolved: result.resolved ?? {} };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
