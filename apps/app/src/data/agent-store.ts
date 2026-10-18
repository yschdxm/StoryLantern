import {
  agentOps,
  ulid,
  type HlcClock,
  type Materializer,
  type MaterializedState,
  type Op,
  type AgentEventRecord,
  type AgentProposalRecord,
  type AgentProposalStatus,
  type AgentRunRecord,
} from '../../../../packages/oplog/src/index.ts';
import type { AgentCheckpoint, AgentRunStore } from './agent-engine.ts';
import { DataError } from './repository.ts';

/**
 * Agent 运行/事件/提案的 op 仓储（PLAN §7）。
 *
 * 为什么单独成文件：`op-repository.ts` 已贴 400 行上限；这里只依赖四个窄入口
 * （withReady / materializer / appendAndApply / base），与卡片五存储同一套模式。
 *
 * 全部状态都是 op 投影（可同步、可审计）：
 *  - run.start / event.append / proposal.create / proposal.decide / run.finish；
 *  - 审批通过时的**业务 op 与 decide op 同批 append**，任一失败就整批不写（不半应用）。
 */

export interface AgentStoreDeps {
  withReady<T>(action: () => Promise<T>): Promise<T>;
  materializer(): Materializer;
  appendAndApply(ops: Op[]): Promise<void>;
  base(): { deviceId: string; clock: HlcClock };
}

export interface AgentStore extends AgentRunStore {
  /** 构造业务 op 用（审批应用与 agent store 共用同一台设备/时钟）。 */
  base(): { deviceId: string; clock: HlcClock };
  /** 当前物化状态（只读）：审批应用要在这里找卡/消息/记忆。 */
  state(): MaterializedState;
  getRun(runId: string): AgentRunRecord | undefined;
  getProposal(proposalId: string): AgentProposalRecord | undefined;
  listRuns(): Promise<AgentRunRecord[]>;
  events(runId: string): Promise<readonly AgentEventRecord[]>;
  proposals(status?: AgentProposalStatus): Promise<AgentProposalRecord[]>;
  createProposal(input: {
    proposalId: string;
    runId: string;
    kind: AgentProposalRecord['kind'];
    summary: string;
    payload: unknown;
  }): Promise<void>;
  /**
   * 决定一条 pending 提案。`businessOps` 与 decide op **同批 append**：
   * 调用方必须先把业务 op 全部构造好（任何失败都不写），再调这里。
   */
  decideProposal(input: {
    proposalId: string;
    decision: 'approved' | 'rejected';
    at: number;
    businessOps?: readonly Op[];
  }): Promise<boolean>;
}

export function createAgentStore(deps: AgentStoreDeps): AgentStore {
  const store: AgentStore = {
    base: deps.base,
    state: () => deps.materializer().state,

    async startRun(input) {
      await deps.withReady(async () => {
        if (deps.materializer().state.agent.runs[input.runId] !== undefined) {
          throw new DataError('conflict', `运行 ${input.runId} 已存在，不能重复开始`);
        }
        await deps.appendAndApply([
          agentOps.runStart(deps.base(), {
            runId: input.runId,
            goal: input.goal,
            budget: input.budget,
            createdAt: input.createdAt,
            ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
            ...(input.modelProfileId === undefined ? {} : { modelProfileId: input.modelProfileId }),
          }),
        ]);
      });
    },

    async appendEvent(input) {
      await deps.withReady(async () => {
        await deps.appendAndApply([
          agentOps.eventAppend(deps.base(), {
            runId: input.runId,
            eventId: input.eventId,
            kind: input.kind,
            data: input.data,
            at: input.at,
          }),
        ]);
      });
    },

    async finishRun(input) {
      await deps.withReady(async () => {
        if (deps.materializer().state.agent.runs[input.runId] === undefined) {
          throw new DataError('not-found', `运行 ${input.runId} 不存在，无法写终态`);
        }
        await deps.appendAndApply([
          agentOps.runFinish(deps.base(), { runId: input.runId, status: input.status, at: input.at }),
        ]);
      });
    },

    async loadCheckpoint(runId) {
      return deps.withReady(async () => {
        const events = deps.materializer().state.agent.events[runId] ?? [];
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index];
          if (event?.kind !== 'checkpoint') continue;
          const data = event.data as Partial<AgentCheckpoint> | undefined;
          if (
            data !== undefined &&
            Array.isArray(data.messages) &&
            typeof data.rounds === 'number' &&
            typeof data.toolCalls === 'number' &&
            typeof data.usd === 'number' &&
            Array.isArray(data.executedTools)
          ) {
            return {
              messages: data.messages,
              rounds: data.rounds,
              toolCalls: data.toolCalls,
              usd: data.usd,
              executedTools: data.executedTools,
            };
          }
        }
        return undefined;
      });
    },

    getRun: (runId) => deps.materializer().state.agent.runs[runId],
    getProposal: (proposalId) => deps.materializer().state.agent.proposals[proposalId],

    async listRuns() {
      return deps.withReady(async () =>
        Object.values(deps.materializer().state.agent.runs).sort(
          (left, right) => right.createdAt - left.createdAt || right.runId.localeCompare(left.runId),
        ),
      );
    },

    async events(runId) {
      return deps.withReady(async () => deps.materializer().state.agent.events[runId] ?? []);
    },

    async proposals(status) {
      return deps.withReady(async () =>
        Object.values(deps.materializer().state.agent.proposals)
          .filter((proposal) => status === undefined || proposal.status === status)
          .sort(
            (left, right) =>
              right.createdHlc.t - left.createdHlc.t || right.proposalId.localeCompare(left.proposalId),
          ),
      );
    },

    async createProposal(input) {
      await deps.withReady(async () => {
        const existing = deps.materializer().state.agent.proposals[input.proposalId];
        if (existing !== undefined) throw new DataError('conflict', `提案 ${input.proposalId} 已存在`);
        if (deps.materializer().state.agent.runs[input.runId] === undefined) {
          throw new DataError('not-found', `运行 ${input.runId} 不存在，不能创建提案`);
        }
        await deps.appendAndApply([
          agentOps.proposalCreate(deps.base(), {
            proposalId: input.proposalId,
            runId: input.runId,
            kind: input.kind,
            summary: input.summary,
            payload: input.payload,
            status: 'pending',
          }),
        ]);
      });
    },

    async decideProposal(input) {
      return deps.withReady(async () => {
        const proposal = deps.materializer().state.agent.proposals[input.proposalId];
        if (proposal === undefined || proposal.status !== 'pending') return false;
        await deps.appendAndApply([
          ...(input.businessOps ?? []),
          agentOps.proposalDecide(deps.base(), {
            proposalId: input.proposalId,
            decision: input.decision,
            at: input.at,
          }),
        ]);
        return true;
      });
    },
  };
  return store;
}

/** 便捷：生成新 id（测试可注入）。 */
export function newAgentId(): string {
  return ulid();
}
