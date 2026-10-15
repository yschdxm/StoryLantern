import { candidatesFor, targetLabel } from './model-routing.ts';
import { organizeSummaries } from './summary-organize.ts';
import { describeError } from './error-text.ts';
import { estimateTokens } from './prompt.ts';
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
  /** 每完成一次模型调用就回调一次（用来实时记账 + 判断预算）。 */
  onCall?: (call: { modelId: string; promptTokens: number; completionTokens: number }) => Promise<void> | void;
  /** 每做一个单元前的检查（透传给执行器）。 */
  shouldContinue?: () => boolean;
}

export interface SummaryRecomputeResult {
  planned: number;
  remaining: number;
  units: number;
  /** 本次的**估算**用量（不是供应商账单）：输入 = 送出去的材料，输出 = 模型回的字。 */
  tokens: { prompt: number; completion: number };
  /** 实际中选的模型配置 id（记账要用）。 */
  modelId: string;
  drafts: Awaited<ReturnType<typeof organizeSummaries>>['drafts'];
}

/** 走完候选链；全失败时把每个配置的失败原因拼起来抛出（不猜、不静默降级）。 */
export async function recomputeSummaries(input: SummaryRecomputeInput): Promise<SummaryRecomputeResult> {
  const candidates = candidatesFor(input.settings, 'summary');
  if (candidates.length === 0) throw new Error('no-model');

  const errors: string[] = [];
  const tokens = { prompt: 0, completion: 0 };
  let usedModelId = candidates[0]?.id ?? '';
  for (const candidate of candidates) {
    try {
      const result = await organizeSummaries({
        sessionId: input.sessionId,
        messages: input.history,
        existing: input.existing,
        ...(input.shouldContinue === undefined ? {} : { shouldContinue: input.shouldContinue }),
        summarize: async (request) => {
          const promptTokens = estimateTokens(request.inputs.join('\n'));
          tokens.prompt += promptTokens;
          const text = await input.reply(candidate.id === '' ? undefined : candidate.id, request);
          const completionTokens = estimateTokens(text);
          tokens.completion += completionTokens;
          // 每次调用后立刻回调：界面据此写用量仓，执行器据此判断预算
          await input.onCall?.({ modelId: candidate.id === '' ? 'default' : candidate.id, promptTokens, completionTokens });
          return text;
        },
        ...(candidate.id === '' ? {} : { modelId: candidate.id }),
      });
      usedModelId = candidate.id === '' ? 'default' : candidate.id;
      return { planned: result.planned, remaining: result.remaining, units: result.units, tokens, modelId: usedModelId, drafts: result.drafts };
    } catch (cause) {
      errors.push(`${targetLabel(candidate)}：${describeError(cause)}`);
    }
  }
  throw new Error(errors.join(' / '));
}
