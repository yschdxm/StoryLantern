import { candidatesFor, targetLabel } from './model-routing.ts';
import { organizeSummaries } from './summary-organize.ts';
import { describeError } from './error-text.ts';
import type { SummarizeRequest } from '../../../../packages/oplog/src/index.ts';
import type { SettingsMap } from './types.ts';

/**
 * 「重算分层摘要」的**候选回退循环**：与记忆整理同一条链路（多模型路由的 summary 任务），
 * 把"挑配置 / 生成 / 报错"这三件事收在一处，界面只负责显示结果。
 *
 * 为什么抽出来：MemoriesScreen 已经贴着门禁的 400 行上限，而这段逻辑与界面无关——
 * 它只依赖设置、会话内容与一个"用某个配置生成一段文本"的回调。
 */
export interface SummaryRecomputeInput {
  sessionId: string;
  settings: SettingsMap;
  history: readonly { id: string; role: string; content: string }[];
  existing: readonly { id: string; contentHash: string; text: string }[];
  /** 用某个模型配置生成一段文本（界面传入：真机上就是聊天客户端）。 */
  reply: (profileId: string | undefined, request: SummarizeRequest) => Promise<string>;
}

export interface SummaryRecomputeResult {
  planned: number;
  remaining: number;
  drafts: Awaited<ReturnType<typeof organizeSummaries>>['drafts'];
}

/** 走完候选链；全失败时把每个配置的失败原因拼起来抛出（不猜、不静默降级）。 */
export async function recomputeSummaries(input: SummaryRecomputeInput): Promise<SummaryRecomputeResult> {
  const candidates = candidatesFor(input.settings, 'summary');
  if (candidates.length === 0) throw new Error('no-model');

  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      const result = await organizeSummaries({
        sessionId: input.sessionId,
        messages: input.history,
        existing: input.existing,
        summarize: (request) => input.reply(candidate.id === '' ? undefined : candidate.id, request),
        ...(candidate.id === '' ? {} : { modelId: candidate.id }),
      });
      return { planned: result.planned, remaining: result.remaining, drafts: result.drafts };
    } catch (cause) {
      errors.push(`${targetLabel(candidate)}：${describeError(cause)}`);
    }
  }
  throw new Error(errors.join(' / '));
}
