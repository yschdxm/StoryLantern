import {
  cardUpsert,
  memoryDelete,
  memoryUpsert,
  messageEdit,
  settingSet,
  ulid,
  type AgentEventRecord,
  type AgentProposalRecord,
  type AgentProposalStatus,
  type AgentRunRecord,
  type Op,
} from '../../../../packages/oplog/src/index.ts';
import type { CardDocument, CharacterCard } from '../../../../packages/cards/src/index.ts';
import type { AppStore } from '../app/state.ts';
import { createAgentTools } from './agent-tools.ts';
import type { AgentToolStore } from './agent-tool-types.ts';
import {
  runAgent,
  resumeAgent,
  type AgentBudget,
  type AgentChatClient,
  type AgentChatMessage,
  type AgentRunResult,
} from './agent-engine.ts';
import { applyAgentProposal, type AgentApplyAction } from './agent-apply.ts';
import type { AgentStore } from './agent-store.ts';
import type { ChatClient } from './chat-client.ts';
import type { RequestLogPort } from './request-log.ts';
import { DataError, validateMemoryDraft, type Repository } from './repository.ts';
import type { MemoryDraft } from './types.ts';

/**
 * 会话级 Agent 控制器（PLAN §7）：引擎 + op 仓储 + 审批应用。
 *
 * 边界：
 *  - **读状态直接走 op 投影**（`AgentStore`），所以两台设备看到同一份运行/提案；
 *  - 审批通过 = `applyAgentProposal`（cards-core 的纯逻辑）→ 这个文件把中立动作翻译成 op →
 *    **业务 op 与 decide op 同批 append**；任一动作非法就在 append 之前失败，提案保持 pending；
 *  - 取消用 AbortSignal；引擎会把终态写成 `cancelled`，不留"假运行"。
 */

export interface AgentControllerOptions {
  store: AppStore;
  chat: ChatClient;
  requestLog?: RequestLogPort | undefined;
  settings: Record<string, string>;
  sessionId: string;
  now?: () => number;
  newId?: () => string;
}

export interface AgentRunOptions {
  budget?: Partial<AgentBudget>;
  modelProfileId?: string;
  /** 提案类工具（guard）默认允许：它们只创建待审提案，真正写入仍要 approve。 */
  allowGuardTools?: boolean;
}

export interface AgentApproveResult {
  summary: string;
  applied: number;
  /** 审批后的审计事件写入失败等非致命问题（批准本身已落库）。 */
  warnings: string[];
}

export interface AgentController {
  run(goal: string, options?: AgentRunOptions): Promise<AgentRunResult>;
  resume(runId: string, options?: AgentRunOptions): Promise<AgentRunResult>;
  cancel(): void;
  approve(proposalId: string): Promise<AgentApproveResult>;
  reject(proposalId: string): Promise<void>;
  proposals(status?: AgentProposalStatus): Promise<AgentProposalRecord[]>;
  timeline(runId?: string): Promise<readonly AgentEventRecord[]>;
  listRuns(): Promise<AgentRunRecord[]>;
}

const DEFAULT_BUDGET: AgentBudget = { maxRounds: 6, maxToolCalls: 12 };

export function createAgentController(options: AgentControllerOptions): AgentController {
  const repository: Repository = options.store.repository;
  const agent: AgentStore | undefined = repository.agent;
  if (agent === undefined) throw new DataError('not-supported', '当前存储不支持 Agent（需要 op-log 仓储）');
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? (() => ulid());
  let controller: AbortController | undefined;

  const storeView: AgentToolStore = options.store;
  const tools = createAgentTools({
    store: storeView,
    ...(options.requestLog === undefined ? {} : { requestLog: options.requestLog }),
    proposals: {
      create: (input) => agent.createProposal(input),
    },
    newId,
    now,
  });

  /** ChatClient → 引擎的 AgentChatClient：toolCalls 只做形状转换，不做语义判断。 */
  const chat: AgentChatClient = {
    async reply(request, handlers) {
      const messages = request.messages.map((message) => ({
        role: message.role === 'tool' ? ('tool' as const) : (message.role as 'user' | 'assistant' | 'system'),
        content: message.content,
        ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
        ...(message.toolCalls === undefined
          ? {}
          : {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function' as const,
                function: {
                  name: call.name,
                  arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
                },
              })),
            }),
      }));
      const result = await options.chat.reply(
        {
          messages,
          ...(request.tools === undefined ? {} : { tools: [...request.tools] }),
          ...(request.profileId === undefined ? {} : { profileId: request.profileId }),
        },
        handlers?.signal === undefined ? {} : { signal: handlers.signal },
      );
      return {
        text: result.text,
        ...(result.toolCalls === undefined
          ? {}
          : {
              toolCalls: result.toolCalls.map((call) => ({
                id: call.id,
                name: call.function.name,
                arguments: call.function.arguments,
              })),
            }),
        ...(result.usage === undefined
          ? {}
          : {
              usage: {
                ...(result.usage.promptTokens === undefined ? {} : { promptTokens: result.usage.promptTokens }),
                ...(result.usage.completionTokens === undefined
                  ? {}
                  : { completionTokens: result.usage.completionTokens }),
              },
            }),
        ...(result.aborted ? { aborted: true } : {}),
      };
    },
  };

  const agentOptions = (input: AgentRunOptions): {
    chat: AgentChatClient;
    tools: ReturnType<typeof createAgentTools>;
    store: AgentStore;
    budget: AgentBudget;
    sessionId: string;
    signal: AbortSignal;
    allowGuardTools: boolean;
    modelProfileId?: string;
  } => ({
    chat,
    tools,
    store: agent,
    budget: { ...DEFAULT_BUDGET, ...(input.budget ?? {}) },
    sessionId: options.sessionId,
    signal: (controller ??= new AbortController()).signal,
    allowGuardTools: input.allowGuardTools ?? true,
    ...(input.modelProfileId === undefined ? {} : { modelProfileId: input.modelProfileId }),
  });

  /** 把 cards-core 的中立动作翻译成 op；任何目标不存在/类型不符都在这里抛（append 前）。 */
  const actionsToOps = (actions: readonly AgentApplyAction[], proposalId: string): Op[] => {
    const state = agent.state();
    const base = agent.base();
    const ops: Op[] = [];
    for (const action of actions) {
      if (action.kind === 'setting.set') {
        ops.push(settingSet(base, { key: action.key, value: action.value }));
        continue;
      }
      if (action.kind === 'card.upsert') {
        ops.push(cardUpsert(base, { card: action.card }));
        continue;
      }
      if (action.kind === 'card.patch') {
        const record = state.cards[action.cardId];
        if (record === undefined || record.deleted !== undefined) {
          throw new DataError('apply-failed', `目标卡片不存在：${action.cardId}`);
        }
        const card = record.card;
        if (action.patch.content !== undefined && card.card_type !== 'lore') {
          throw new DataError('apply-failed', `正文补丁只能用于典籍：${action.cardId}`);
        }
        if (action.patch.prompts !== undefined && card.card_type !== 'character') {
          throw new DataError('apply-failed', `提示词补丁只能用于角色：${action.cardId}`);
        }
        const next = {
          ...card,
          ...(action.patch.content === undefined ? {} : { content: action.patch.content }),
          ...(action.patch.prompts === undefined
            ? {}
            : { prompts: { ...(card as CharacterCard).prompts, ...action.patch.prompts } }),
        } as CardDocument;
        ops.push(cardUpsert(base, { card: next }));
        continue;
      }
      if (action.kind === 'message.edit') {
        const message = state.messages[action.messageId];
        if (message === undefined || message.deleted !== undefined) {
          throw new DataError('apply-failed', `目标消息不存在：${action.messageId}`);
        }
        if (message.author !== 'character') {
          throw new DataError('apply-failed', `只能改写 assistant 消息：${action.messageId}`);
        }
        ops.push(
          messageEdit(base, {
            messageId: action.messageId,
            revisionId: `${action.messageId}:agent-${proposalId}`,
            baseRevisionId: message.activeRevision.revisionId,
            content: action.content,
            status: 'done',
          }),
        );
        continue;
      }
      if (action.kind === 'memory.merge') {
        const draft: MemoryDraft = {
          text: action.text,
          keys: [],
          importance: 50,
          sourceMessageIds: action.sourceMessageIds,
          createdBy: 'agent',
          characterId: action.characterId,
        };
        const clean = validateMemoryDraft(draft);
        ops.push(memoryUpsert(base, { memoryId: `agent-merge-${proposalId}`, ...clean }));
        for (const memoryId of action.memoryIds) ops.push(memoryDelete(base, { memoryId }));
        continue;
      }
      const draft: MemoryDraft = { ...action.memory, createdBy: action.memory.createdBy ?? 'agent' };
      const clean = validateMemoryDraft(draft);
      ops.push(memoryUpsert(base, { memoryId: draft.id ?? newId(), ...clean }));
    }
    return ops;
  };

  const appendApprovalEvent = async (proposal: AgentProposalRecord, decision: 'approved' | 'rejected', summary: string): Promise<string | undefined> => {
    try {
      await agent.appendEvent({
        runId: proposal.runId,
        eventId: newId(),
        kind: 'status',
        data: { phase: 'approval', proposalId: proposal.proposalId, decision, summary },
        at: now(),
      });
      return undefined;
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
  };

  return {
    async run(goal, input = {}) {
      controller = new AbortController();
      const result = await runAgent({
        goal,
        ...agentOptions(input),
        now,
        newEventId: newId,
        newRunId: newId,
      });
      controller = undefined;
      return result;
    },

    async resume(runId, input = {}) {
      const run = agent.getRun(runId);
      if (run === undefined) throw new DataError('not-found', `运行 ${runId} 不存在`);
      controller = new AbortController();
      const result = await resumeAgent({
        ...agentOptions({ budget: run.budget, ...input }),
        goal: run.goal,
        runId,
        now,
        newEventId: newId,
      });
      controller = undefined;
      return result;
    },

    cancel() {
      controller?.abort();
    },

    async approve(proposalId) {
      const proposal = agent.getProposal(proposalId);
      if (proposal === undefined) throw new DataError('not-found', `提案 ${proposalId} 不存在`);
      if (proposal.status !== 'pending') throw new DataError('invalid-argument', `提案已是 ${proposal.status}，不能重复审批`);
      const context = {
        cards: (await (repository.cards?.list() ?? Promise.resolve([]))) as readonly CardDocument[],
        memories: await repository.memories.list(),
        messages: await repository.messages.list(options.sessionId),
        settings: options.settings,
      };
      const applied = applyAgentProposal(proposal, context);
      if (applied.ok === false) throw new DataError('apply-failed', applied.reason);
      const businessOps = actionsToOps(applied.actions, proposalId);
      const changed = await agent.decideProposal({
        proposalId,
        decision: 'approved',
        at: now(),
        businessOps,
      });
      if (!changed) throw new DataError('conflict', '提案状态已被其它设备改掉，未应用');
      const warning = await appendApprovalEvent(proposal, 'approved', applied.summary);
      return {
        summary: applied.summary,
        applied: applied.actions.length,
        warnings: warning === undefined ? [] : [`审批已生效，但审计事件写入失败：${warning}`],
      };
    },

    async reject(proposalId) {
      const proposal = agent.getProposal(proposalId);
      if (proposal === undefined) throw new DataError('not-found', `提案 ${proposalId} 不存在`);
      if (proposal.status !== 'pending') throw new DataError('invalid-argument', `提案已是 ${proposal.status}，不能重复审批`);
      const changed = await agent.decideProposal({ proposalId, decision: 'rejected', at: now() });
      if (!changed) throw new DataError('conflict', '提案状态已被其它设备改掉，未拒绝');
      const warning = await appendApprovalEvent(proposal, 'rejected', proposal.summary);
      if (warning !== undefined) throw new DataError('audit-failed', `已拒绝，但审计事件写入失败：${warning}`);
    },

    proposals: (status) => agent.proposals(status),

    async timeline(runId) {
      let target = runId;
      if (target === undefined) {
        const runs = await agent.listRuns();
        target = runs.find((run) => run.sessionId === options.sessionId)?.runId ?? runs[0]?.runId;
      }
      return target === undefined ? [] : agent.events(target);
    },

    listRuns: () => agent.listRuns(),
  };
}
