import { compareOpOrder } from './hlc.ts';
import { cloneHlc, laterThan, type ApplyResult } from './materialize-support.ts';
import type { Op } from './op.ts';
import type {
  AgentEventRecord,
  AgentProposalRecord,
  AgentRunRecord,
  MaterializedState,
} from './state-types.ts';
import type {
  AgentEventAppendPayload,
  AgentProposalCreatePayload,
  AgentProposalDecidePayload,
  AgentRunFinishPayload,
  AgentRunStartPayload,
} from './agent-ops.ts';

/**
 * Agent 层投影（纯函数）。
 *
 * 语义与其它实体一致：
 *  - `run.start` / `proposal.create` / `decision` / `run.finish` 是 **LWW**（比 HLC，同 HLC 比 opId）；
 *  - `event.append` 是**只追加**：同 eventId 幂等（at-least-once 投递），落进按 runId 分桶的数组并按 HLC 排序
 *    （于是"两台设备谁先收到"不影响最终顺序）；
 *  - 事件先于 run.start 到达也接受（同步是乱序投递；不把事件当 orphan 丢）。
 */

const AGENT_OP_TYPES = new Set<string>([
  'agent.run.start',
  'agent.event.append',
  'agent.proposal.create',
  'agent.proposal.decide',
  'agent.run.finish',
]);

export function isAgentOp(type: string): boolean {
  return AGENT_OP_TYPES.has(type);
}

function applyRunStart(state: MaterializedState, op: Op): ApplyResult {
  const payload = op.payload as AgentRunStartPayload;
  const existing = state.agent.runs[payload.runId];
  if (existing !== undefined && !laterThan(op.hlc, existing.updatedHlc, op.opId, existing.updatedOpId)) {
    return 'applied';
  }
  const record: AgentRunRecord = {
    runId: payload.runId,
    ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
    goal: payload.goal,
    ...(payload.modelProfileId === undefined ? {} : { modelProfileId: payload.modelProfileId }),
    budget: payload.budget,
    createdAt: payload.createdAt,
    status: 'running',
    startedHlc: cloneHlc(op.hlc),
    startedOpId: op.opId,
    updatedHlc: cloneHlc(op.hlc),
    updatedOpId: op.opId,
  };
  state.agent.runs[payload.runId] = record;
  return 'applied';
}

function applyEventAppend(state: MaterializedState, op: Op): ApplyResult {
  const payload = op.payload as AgentEventAppendPayload;
  const bucket = state.agent.events[payload.runId] ?? [];
  if (bucket.some((event) => event.eventId === payload.eventId)) return 'applied';
  const record: AgentEventRecord = {
    eventId: payload.eventId,
    runId: payload.runId,
    kind: payload.kind,
    data: payload.data,
    at: payload.at,
    hlc: cloneHlc(op.hlc),
    opId: op.opId,
  };
  bucket.push(record);
  bucket.sort((left, right) => compareOpOrder({ hlc: left.hlc, opId: left.opId }, { hlc: right.hlc, opId: right.opId }));
  state.agent.events[payload.runId] = bucket;
  return 'applied';
}

function applyProposalCreate(state: MaterializedState, op: Op): ApplyResult {
  const payload = op.payload as AgentProposalCreatePayload;
  const existing = state.agent.proposals[payload.proposalId];
  if (existing !== undefined && !laterThan(op.hlc, existing.createdHlc, op.opId, existing.createdOpId)) {
    return 'applied';
  }
  // 更新的 create 覆盖旧的（包括旧的决定）：一条提案重新创建后回到 pending。
  state.agent.proposals[payload.proposalId] = {
    proposalId: payload.proposalId,
    runId: payload.runId,
    kind: payload.kind,
    summary: payload.summary,
    payload: payload.payload,
    status: 'pending',
    createdAt: op.hlc.t,
    createdHlc: cloneHlc(op.hlc),
    createdOpId: op.opId,
  };
  return 'applied';
}

function applyProposalDecide(state: MaterializedState, op: Op): ApplyResult {
  const payload = op.payload as AgentProposalDecidePayload;
  const proposal = state.agent.proposals[payload.proposalId];
  if (proposal === undefined) return 'orphan';
  if (proposal.decisionHlc !== undefined && !laterThan(op.hlc, proposal.decisionHlc, op.opId, proposal.decisionOpId)) {
    return 'applied';
  }
  proposal.status = payload.decision;
  proposal.decidedAt = payload.at;
  proposal.decisionHlc = cloneHlc(op.hlc);
  proposal.decisionOpId = op.opId;
  return 'applied';
}

function applyRunFinish(state: MaterializedState, op: Op): ApplyResult {
  const payload = op.payload as AgentRunFinishPayload;
  const run = state.agent.runs[payload.runId];
  if (run === undefined) return 'orphan';
  if (!laterThan(op.hlc, run.updatedHlc, op.opId, run.updatedOpId)) return 'applied';
  run.status = payload.status;
  run.finishedAt = payload.at;
  run.updatedHlc = cloneHlc(op.hlc);
  run.updatedOpId = op.opId;
  return 'applied';
}

export function applyAgentOp(state: MaterializedState, op: Op): ApplyResult {
  switch (op.type) {
    case 'agent.run.start': return applyRunStart(state, op);
    case 'agent.event.append': return applyEventAppend(state, op);
    case 'agent.proposal.create': return applyProposalCreate(state, op);
    case 'agent.proposal.decide': return applyProposalDecide(state, op);
    case 'agent.run.finish': return applyRunFinish(state, op);
    default: return 'applied';
  }
}

export function listAgentEvents(state: MaterializedState, runId: string): readonly AgentEventRecord[] {
  return state.agent.events[runId] ?? [];
}

export function agentRunOf(state: MaterializedState, runId: string): AgentRunRecord | undefined {
  return state.agent.runs[runId];
}

export function agentProposalOf(state: MaterializedState, proposalId: string): AgentProposalRecord | undefined {
  return state.agent.proposals[proposalId];
}

/** 待审提案：按创建时间（同 HLC 按 opId）排序，供 UI/审批使用。 */
export function pendingAgentProposals(state: MaterializedState): readonly AgentProposalRecord[] {
  return Object.values(state.agent.proposals)
    .filter((proposal) => proposal.status === 'pending')
    .sort((left, right) => compareOpOrder({ hlc: left.createdHlc, opId: left.createdOpId }, { hlc: right.createdHlc, opId: right.createdOpId }));
}
