import { cosineSimilarity, type EmbeddingPort, type RerankPort } from '../../../../packages/oplog/src/index.ts';
import { createHostRerankPort } from './rerank-host.ts';
import type { PromptSummary } from './prompt-blocks-v2.ts';
import { DEFAULT_EMBEDDING_MODEL, createHostEmbeddingPort } from './embedding-host.ts';
import type { WireTransport } from '../../../../packages/wire/src/index.ts';

/**
 * 用**向量**挑要注入的分层摘要（M4）。
 *
 * 为什么要有这个纯函数：聊天路径的块渲染是**同步**的，而 embedding 必然异步 ——
 * 所以检索必须在 `buildChatRequestV2` **之前**算好（见 ChatScreen 的 runReply），
 * 再把结果作为 `preselectedSummaries` 交给块。这里只做"算"，不做 IO 决策。
 *
 * 失败一律**抛给调用方**：调用方退回块内的词法检索（原有的回退规则），不让一次对话因为向量挂了而失败。
 */

export interface VectorSelectInput {
  embedder: EmbeddingPort;
  /** 查询 = 最后一条用户消息（与词法路径同一条规则，避免两条路挑出不同的东西而难以解释）。 */
  question: string;
  summaries: readonly PromptSummary[];
  /** 默认 3（与 SUMMARY_INJECT_LIMIT 一致）。 */
  limit?: number;
  /** 可选的 **rerank 模型**（交叉编码器）：给了就先按余弦粗排 10 条再精排。 */
  reranker?: RerankPort | undefined;
}

export async function selectSummariesByVector(input: VectorSelectInput): Promise<PromptSummary[]> {
  const limit = input.limit ?? 3;
  if (input.summaries.length === 0 || input.question.trim() === '') return [];
  const texts = [input.question, ...input.summaries.map((summary) => summary.text)];
  const vectors = await input.embedder.embed(texts);
  const queryVector = vectors[0];
  if (queryVector === undefined) return [];
  const scored = input.summaries.map((summary, index) => ({
    summary,
    // 余弦：查询与每条摘要
    score: cosineSimilarity(queryVector, vectors[index + 1] ?? []),
  }));
  const byCosine = scored.sort((left, right) => right.score - left.score || left.summary.id.localeCompare(right.summary.id));
  const reranker = input.reranker;
  if (reranker === undefined) return byCosine.slice(0, limit).map((item) => item.summary);
  // 粗排 10 条交给 **rerank 模型**（交叉编码器）精排；失败就退回余弦顺序，不让一次对话失败
  const wide = byCosine.slice(0, Math.max(limit, 10));
  try {
    const hits = await reranker.rerank(input.question, wide.map((item) => item.summary.text), { topN: limit });
    const picked: PromptSummary[] = [];
    for (const hit of hits) {
      const item = wide[hit.index];
      if (item !== undefined) picked.push(item.summary);
    }
    return picked.length === 0 ? wide.slice(0, limit).map((item) => item.summary) : picked;
  } catch (error) {
    console.warn('rerank 模型失败，退回余弦顺序：', error);
    return wide.slice(0, limit).map((item) => item.summary);
  }
}

export interface ChatSummarySelectionInput {
  /** 宿主通道；没有就没法用向量（同步块渲染塞不进网络调用）。 */
  transport: WireTransport | undefined;
  /** 向量模型 id；缺省用默认。 */
  model?: string | undefined;
  messages: readonly { role: string; content: string }[];
  /** 用哪份模型配置的地址与密钥（不给就用设置里的默认那组）。 */
  profileId?: string | undefined;
  /** rerank 模型 id；空串 = 不精排（默认空：多一次网络调用，要让用户主动开）。 */
  rerankModel?: string | undefined;
  /** 每完成一次嵌入请求回调一次（调用方据此记账，与摘要那条同一条路）。 */
  recordUsage?: ((call: { modelId: string; promptTokens: number }) => Promise<void>) | undefined;
  /**
   * 结果回调：成功挑了 count 条，或**退回词法**并给出原因。
   *
   * 为什么要有：这条链路失败是**静默**的（刻意不抛错），于是向量到底跑没跑在真机上无从判断 ——
   * 实测就卡在这里（用量只 +1，分不清是向量没跑还是记账没落）。把结果落到一处可显示的地方，
   * 这条链路才可观测。
   */
  onOutcome?: ((outcome: { ok: boolean; count: number; reason?: string }) => void) | undefined;
  summaries: readonly PromptSummary[];
}

/**
 * 聊天路径专用：**能上向量就上，不行就返回 undefined**（调用方退回块内的词法检索）。
 *
 * 刻意**不抛错**：向量来源挂了不该让一次对话失败 —— 这正是混合检索那三条回退规则里的第二条。
 * 查询取**最后一条用户消息**，与词法路径同一条规则（两条路挑出不同的东西会很难解释）。
 */
export async function selectSummariesForChat(input: ChatSummarySelectionInput): Promise<PromptSummary[] | undefined> {
  // 早退也要回报：否则"这条路根本没走"和"走了但失败"在外面看起来一模一样 —— 这正是可观测性要解决的问题。
  if (input.transport === undefined) {
    input.onOutcome?.({ ok: false, count: 0, reason: '没有宿主通道（浏览器里跑不了向量）' });
    return undefined;
  }
  if (input.summaries.length === 0) {
    input.onOutcome?.({ ok: false, count: 0, reason: '这个会话还没有分层摘要，只能走词法' });
    return undefined;
  }
  let question = '';
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const item = input.messages[index];
    if (item?.role === 'user' && item.content.trim() !== '') {
      question = item.content;
      break;
    }
  }
  if (question === '') {
    input.onOutcome?.({ ok: false, count: 0, reason: '没有用户消息，没有可用的查询' });
    return undefined;
  }
  try {
    const rerankModel = input.rerankModel?.trim() ?? '';
    const picked = await selectSummariesByVector({
      ...(rerankModel === ''
        ? {}
        : {
            reranker: createHostRerankPort({
              transport: input.transport,
              model: rerankModel,
              ...(input.profileId === undefined || input.profileId === '' ? {} : { profileId: input.profileId }),
            }),
          }),
      embedder: createHostEmbeddingPort({
        transport: input.transport,
        ...(input.profileId === undefined || input.profileId === '' ? {} : { profileId: input.profileId }),
        model: input.model ?? DEFAULT_EMBEDDING_MODEL,
        // 用量按 task: 'embed' 记（UsageTask 里本来就有这一项）
        onUsage: (usage) => {
          void input.recordUsage?.({ modelId: input.model ?? DEFAULT_EMBEDDING_MODEL, promptTokens: usage.promptTokens });
        },
      }),
      question,
      summaries: input.summaries,
    });
    input.onOutcome?.({ ok: true, count: picked.length });
    return picked.length === 0 ? undefined : picked;
  } catch (cause) {
    console.warn('向量挑选摘要失败，退回词法检索：', cause);
    input.onOutcome?.({ ok: false, count: 0, reason: cause instanceof Error ? cause.message : String(cause) });
    return undefined;
  }
}
