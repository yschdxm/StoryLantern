import type { HlcClock, Materializer, Op } from '../../../../packages/oplog/src/index.ts';
import { applyProposal, pendingUndo, proposeMemoriesMerge, undoOps } from '../../../../packages/tuner/src/index.ts';

/**
 * 调优助手在应用侧的仓储：把"看建议 / 应用 / 撤销"接到**既有的 op 写入路径**上。
 *
 * 与记忆仓储同构（同样的四个依赖）：`materializer()` 读状态、`appendAndApply()` 写 op、
 * `base()` 提供 deviceId 与因果时钟、`withReady()` 保证仓储就绪。
 *
 * 两条刻意的设计：
 *  - **应用时按 id 重新推导建议**，而不是把建议里的数据直接写下去：状态可能在用户看建议的那几分钟里变了，
 *    拿旧数据写等于"批准的是 A、写进去的是 B"。找不到或已过期就明确拒绝，让人重新分析。
 *  - **提案本身不含 op**（见 packages/tuner），所以这个文件是应用侧**唯一**能碰到写入的地方，
 *    而它只被"用户点应用/撤销"调用。
 */

export interface TunerStoreDeps {
  withReady<T>(action: () => Promise<T>): Promise<T>;
  materializer(): Materializer;
  appendAndApply(ops: Op[]): Promise<void>;
  base(): { deviceId: string; clock: HlcClock };
}

export interface TunerSuggestion {
  id: string;
  title: string;
  reason: string;
  evidence: string[];
}

export interface TunerStore {
  /** 只看不改：列出建议。 */
  suggest(): Promise<TunerSuggestion[]>;
  /** 用户点了"应用"：按 id 重新推导后写入；找不到就拒绝。 */
  apply(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** 最近一次还能撤销的应用（依据在 op 日志里）。 */
  pendingUndo(): Promise<TunerSuggestion | undefined>;
  /** 用户点了"撤销"：追加还原用的 op。 */
  undo(): Promise<{ ok: true } | { ok: false; error: string }>;
}

function summarize(proposal: { id: string; title: string; reason: string; evidence: string[] }): TunerSuggestion {
  return { id: proposal.id, title: proposal.title, reason: proposal.reason, evidence: proposal.evidence };
}

export function createTunerStore(deps: TunerStoreDeps): TunerStore {
  return {
    suggest: () =>
      deps.withReady(async () => proposeMemoriesMerge({ state: deps.materializer().state }).map(summarize)),

    apply: (id) =>
      deps.withReady(async () => {
        const proposal = proposeMemoriesMerge({ state: deps.materializer().state }).find((item) => item.id === id);
        if (proposal === undefined) {
          return { ok: false as const, error: '这条建议已经不适用了（记忆变过），请重新分析' };
        }
        const { ops } = applyProposal(proposal, deps.base());
        await deps.appendAndApply(ops);
        return { ok: true as const };
      }),

    pendingUndo: () =>
      deps.withReady(async () => {
        const entry = pendingUndo(deps.materializer().state);
        if (entry === undefined) return undefined;
        return {
          id: entry.proposalId,
          title: '撤销上一次调优应用',
          reason: '撤销会按记录把原条目原样写回；时钟字段会前进（它们记录"何时发生"）',
          evidence: [`提案 id：${entry.proposalId}`, `类型：${entry.kind}`],
        };
      }),

    undo: () =>
      deps.withReady(async () => {
        const entry = pendingUndo(deps.materializer().state);
        if (entry === undefined) return { ok: false as const, error: '没有可撤销的应用' };
        await deps.appendAndApply(undoOps(entry, deps.base()));
        return { ok: true as const };
      }),
  };
}
