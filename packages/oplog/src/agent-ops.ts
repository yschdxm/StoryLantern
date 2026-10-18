import { createOp, type Op, type StampOptions } from './op.ts';
import type { HlcClock } from './hlc.ts';
import type {
  AgentBudgetRecord,
  AgentEventKind,
  AgentProposalDecision,
  AgentProposalKind,
} from './state-types.ts';

/**
 * Agent 层（PLAN §7）的可同步 op。
 *
 * 为什么走 op 日志而不是本地缓存：Agent 的运行、事件、提案是**内容**（跨设备该一致、可审计、
 * 可撤销），所以与消息/摘要同一套语义：只追加的事件 + LWW 的终态 + 墓碑不适用（Agent 不删）。
 *
 * 五个 op：
 *  - `agent.run.start`     一次运行的开始（goal/budget/绑定会话）
 *  - `agent.event.append`  运行中的事件（assistant/tool/tool_result/status/error/checkpoint），只追加
 *  - `agent.proposal.create` 待审提案（**只创建**，应用是下一批）
 *  - `agent.proposal.decide` 用户批准/拒绝（LWW）
 *  - `agent.run.finish`    运行终态（done/cancelled/failed/blocked，LWW）
 */

export interface AgentRunStartPayload {
  runId: string;
  sessionId?: string;
  goal: string;
  modelProfileId?: string;
  budget: AgentBudgetRecord;
  createdAt: number;
}

export interface AgentEventAppendPayload {
  runId: string;
  eventId: string;
  kind: AgentEventKind;
  data: unknown;
  at: number;
}

export interface AgentProposalCreatePayload {
  proposalId: string;
  runId: string;
  kind: AgentProposalKind;
  summary: string;
  payload: unknown;
  /** 创建时恒为 pending；应用/拒绝走 decide。 */
  status: 'pending';
}

export interface AgentProposalDecidePayload {
  proposalId: string;
  decision: AgentProposalDecision;
  at: number;
}

/** 终态：`running` 不是可写入的终态（它是投影初始值）。 */
export type AgentRunFinishStatus = 'done' | 'cancelled' | 'failed' | 'blocked';

export interface AgentRunFinishPayload {
  runId: string;
  status: AgentRunFinishStatus;
  at: number;
}

export interface AgentOpBase {
  deviceId: string;
  clock: HlcClock;
}

export function agentRunStart(
  base: AgentOpBase,
  payload: AgentRunStartPayload,
  stamp: StampOptions = {},
): Op<AgentRunStartPayload> {
  return createOp({
    ...base,
    ...stamp,
    type: 'agent.run.start',
    entity: { type: 'agent.run', id: payload.runId },
    payload,
  });
}

export function agentEventAppend(
  base: AgentOpBase,
  payload: AgentEventAppendPayload,
  stamp: StampOptions = {},
): Op<AgentEventAppendPayload> {
  return createOp({
    ...base,
    ...stamp,
    type: 'agent.event.append',
    entity: { type: 'agent.event', id: payload.eventId },
    payload,
  });
}

export function agentProposalCreate(
  base: AgentOpBase,
  payload: AgentProposalCreatePayload,
  stamp: StampOptions = {},
): Op<AgentProposalCreatePayload> {
  return createOp({
    ...base,
    ...stamp,
    type: 'agent.proposal.create',
    entity: { type: 'agent.proposal', id: payload.proposalId },
    payload,
  });
}

export function agentProposalDecide(
  base: AgentOpBase,
  payload: AgentProposalDecidePayload,
  stamp: StampOptions = {},
): Op<AgentProposalDecidePayload> {
  return createOp({
    ...base,
    ...stamp,
    type: 'agent.proposal.decide',
    entity: { type: 'agent.proposal', id: payload.proposalId },
    payload,
  });
}

export function agentRunFinish(
  base: AgentOpBase,
  payload: AgentRunFinishPayload,
  stamp: StampOptions = {},
): Op<AgentRunFinishPayload> {
  return createOp({
    ...base,
    ...stamp,
    type: 'agent.run.finish',
    entity: { type: 'agent.run', id: payload.runId },
    payload,
  });
}

/** 便捷构造：调用方按类型取，无需记住五个函数名。 */
export const agentOps = {
  runStart: agentRunStart,
  eventAppend: agentEventAppend,
  proposalCreate: agentProposalCreate,
  proposalDecide: agentProposalDecide,
  runFinish: agentRunFinish,
} as const;
