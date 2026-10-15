import { useState } from 'react';
import { recomputeSummaries } from '../data/summary-recompute.ts';
import { createUsageStore } from '../data/usage-store.ts';
import { computeUsage } from '../../../../packages/oplog/src/index.ts';
import type { ChatClient } from '../data/chat-client.ts';
import type { SummaryDraft } from '../data/summary-types.ts';
import type { SummarizeRequest } from '../../../../packages/oplog/src/index.ts';

/**
 * 「重算分层摘要」这个动作的 hook。
 *
 * 为什么要抽出来：MemoriesScreen 已经贴着门禁的 400 行上限（加完处理器与按钮会超），
 * 而这段逻辑与界面无关——它只依赖"某个会话的消息、已有摘要、一个保存回调、一个聊天客户端"。
 *
 * 入参刻意用**回调**而不是整个 store：这样 hook 不依赖应用状态的具体类型，
 * 屏幕那边只传几支箭头函数即可，测试也更容易。
 */

/** 分层摘要的指令：只要它把给定材料浓缩成一段事实性的摘要，不要续写剧情。 */
export const SUMMARY_INSTRUCTION =
  '把给你的材料压缩成一段简短、事实性的摘要：只保留人物、地点、关键事件与已经确立的设定，不要续写、不要评价、不要加戏。';

export interface UseSummariesInput {
  /** 当前会话（没有会话时按钮应当被禁用）。 */
  sessionId: string | undefined;
  settings: Record<string, string>;
  loadHistory: (sessionId: string) => Promise<Array<{ id: string; role: string; content: string }>>;
  loadExisting: (
    sessionId: string,
  ) => Promise<Array<{ id: string; contentHash: string; text: string; deleted?: boolean }>>;
  /** 写一个设置（用量仓用它记 `usage.device.*`）。 */
  setSetting: (key: string, value: string) => Promise<void>;
  /** 保存草稿，返回真正写入的条数。 */
  save: (sessionId: string, drafts: readonly SummaryDraft[]) => Promise<number>;
  chat: ChatClient;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onError: (message: string) => void;
}

export interface UseSummariesResult {
  running: boolean;
  /** 上一次运行的结果提示（写入 N 条 / 内容没变化 / 还有多少没做完）。 */
  note: string | undefined;
  run: () => Promise<void>;
}

export function useSummaries(input: UseSummariesInput): UseSummariesResult {
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | undefined>(undefined);

  const run = async (): Promise<void> => {
    const sessionId = input.sessionId;
    if (sessionId === undefined) return;
    setNote(undefined);
    setRunning(true);
    try {
      // 用量与预算（M4 判据 3）：摘要这条路以前只算 token、不进闸门 —— 于是它能悄悄超支。
      const usage = createUsageStore({ settings: () => input.settings, setSetting: input.setSetting });
      const budget = usage.budget().value;
      const prices = usage.prices().value;
      const deviceId = input.settings['device.id'] ?? 'unknown';
      const before = usage.gate(0);
      if (!before.ok) {
        input.onError(input.t('summary.recompute.overBudget', { spent: before.spentUsd.toFixed(4) }));
        return;
      }
      // 运行中的已花用**本地累计**：设置里的记录要等写完才看得到，靠它拦不住正在跑的这批。
      let spentUsd = before.spentUsd;
      let stoppedByBudget = false;

      const [history, existing] = await Promise.all([input.loadHistory(sessionId), input.loadExisting(sessionId)]);
      let result: Awaited<ReturnType<typeof recomputeSummaries>>;
      try {
        result = await recomputeSummaries({
          sessionId,
          settings: input.settings,
          history,
          existing: existing
            .filter((item) => item.deleted !== true)
            .map((item) => ({ id: item.id, contentHash: item.contentHash, text: item.text })),
          shouldContinue: () => {
            const ok = budget === undefined || spentUsd <= budget;
            if (!ok) stoppedByBudget = true;
            return ok;
          },
          onCall: async (call) => {
            const record = computeUsage({
              at: Date.now(),
              task: 'summary',
              modelId: call.modelId,
              promptTokens: call.promptTokens,
              completionTokens: call.completionTokens,
              prices,
            });
            spentUsd = Math.round((spentUsd + record.costUsd) * 1e6) / 1e6;
            // 用仓的 record()：它负责"读当天已有 → 追加 → 写回"，直接 setSetting 会覆盖掉当天记录
            await usage.record(deviceId, record);
          },
          reply: (profileId, request: SummarizeRequest) =>
            input.chat
              .reply(
                {
                  ...(profileId === undefined ? {} : { profileId }),
                  messages: [{ role: 'user', content: request.inputs.join('\n') }],
                  systemPrompt: SUMMARY_INSTRUCTION,
                },
                {},
              )
              .then((reply) => reply.text),
        });
      } catch (cause) {
        // 没有可用模型是个常见配置问题：给一句能照做的提示，而不是把 internal key 抛给用户
        if (cause instanceof Error && cause.message === 'no-model') {
          setNote(undefined);
          input.onError(input.t('memory.organize.noModel'));
          return;
        }
        throw cause;
      }

      if (result.planned === 0) {
        // 两件不同的事：还没攒够一个完整单元 vs 内容没变化
        setNote(input.t(result.units === 0 ? 'summary.recompute.tooShort' : 'summary.recompute.none'));
        return;
      }
      const written = await input.save(sessionId, result.drafts);
      const done = input.t('summary.recompute.done', { count: written });
      const used = input.t('summary.recompute.tokens', { prompt: result.tokens.prompt, completion: result.tokens.completion });
      const left = remainingNote(input.t, result.remaining);
      const stopped = stoppedByBudget ? input.t('summary.recompute.stoppedByBudget') : '';
      setNote((left === undefined ? done : done + ' · ' + left) + ' · ' + used + (stopped === '' ? '' : ' · ' + stopped));
    } catch (cause) {
      input.onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  };

  return { running, note, run };
}

/**
 * 还没做的单元数（一次运行有上限：1 万条消息的会话按 20 条/scene 就是 620 个单元，
 * 620 次模型调用既不便宜也不快）。计划器顺序稳定且已完成的不会重做，所以"下次继续"是安全的。
 */
export function remainingNote(t: UseSummariesInput['t'], remaining: number): string | undefined {
  return remaining > 0 ? t('summary.recompute.remaining', { count: remaining }) : undefined;
}
