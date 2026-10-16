import type { PluginContext } from '../../../packages/plugin-api/src/index.ts';
import type { Op } from '../../../packages/oplog/src/op.ts';
import type { MaterializedState } from '../../../packages/oplog/src/state-types.ts';
import {
  applyProposal,
  pendingUndo,
  proposeMemoriesMerge,
  undoOps,
  type TunerBase,
  type TunerLedgerEntry,
  type TunerProposal,
} from '../../../packages/tuner/src/index.ts';

/**
 * 调优助手插件（M5 / ADR-0003：**侧信道调优助手，不是创作者**）。
 *
 * 这个文件刻意很薄：分析在 `packages/tuner`，这里只暴露服务，并把住**唯一的写入闸门**。
 *
 * 为什么"未经批准不写入"在这里是结构性的，而不是靠自觉：
 *  - `propose` 只吐数据（`TunerProposal` 里一个 op 都没有）；
 *  - 造 op 需要 `TunerBase`（deviceId + clock），而它**只**出现在 `approve` 的入参里；
 *  - `approve` 要求 `approved === true`，否则直接抛错；
 *  - 插件里**没有**定时器、监听器或任何"自动应用"的路径（架构测试会再加上一条源码断言）。
 */

export const name = 'tuner-agent';

export interface TunerAgent {
  /** 只看不改：产出建议（不含 op）。 */
  propose(state: MaterializedState, options?: { threshold?: number }): TunerProposal[];
  /** 用户批准后才产出 op；`approved !== true` 一律拒绝。 */
  approve(proposal: TunerProposal, base: TunerBase, approved: boolean): { ops: Op[]; ledgerKey: string };
  /** 最近一次还能撤销的应用（依据存在 op 日志里）。 */
  pendingUndo(state: MaterializedState): TunerLedgerEntry | undefined;
  /** 撤销：返回要追加的 op（内容级逐字节还原）。 */
  undo(entry: TunerLedgerEntry, base: TunerBase): Op[];
}

export function apply(ctx: PluginContext): void {
  const agent: TunerAgent = {
    propose(state, options) {
      return proposeMemoriesMerge({ state, ...(options ?? {}) });
    },
    approve(proposal, base, approved) {
      if (approved !== true) throw new Error('调优建议必须经用户批准才能写入');
      return applyProposal(proposal, base);
    },
    pendingUndo(state) {
      return pendingUndo(state);
    },
    undo(entry, base) {
      return undoOps(entry, base);
    },
  };
  ctx.set('tuner.agent', agent);
}
