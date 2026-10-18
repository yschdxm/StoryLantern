/**
 * Agent 运行引擎（纯逻辑，不渲染 UI、不应用提案）。
 *
 * 循环：`chat.reply({messages, tools})` → 若返回 toolCalls 就逐个执行（受 tier/schema 门禁）→
 * 把 assistant tool_calls 与 tool 结果追加进 messages → 直到没有 toolCalls 或预算耗尽。
 *
 * 三条硬规则：
 *  1. **预算先于调用**：超过 maxRounds / maxToolCalls / maxUsd 就停止（不只事后记账）；
 *  2. **取消/错误都留终态**：取消 = `cancelled`，模型/工具异常 = `failed`，预算或 guard 拦截 = `blocked`；
 *  3. **可恢复**：每轮把 messages 与已执行工具写 `agent.event.append(kind:'checkpoint')`；
 *     `resumeAgent` 从最近 checkpoint 继续（不重放已执行的工具）。
 */

import { ulid } from '../../../../packages/oplog/src/index.ts';
import type { AgentEventKind, AgentRunFinishStatus } from '../../../../packages/oplog/src/index.ts';
import type { AgentToolContext, AgentToolRegistry, AgentToolSchema } from './agent-tools.ts';

export interface AgentBudget {
  maxRounds: number;
  maxToolCalls: number;
  maxUsd?: number;
}

export interface AgentChatToolCall {
  id: string;
  name: string;
  /** 宿主可能给对象，也可能给 JSON 字符串（OpenAI 原生是字符串）；引擎两种都接受。 */
  arguments: unknown;
}

export interface AgentChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: readonly AgentChatToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface AgentChatUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export interface AgentChatReply {
  text: string;
  toolCalls?: readonly AgentChatToolCall[];
  usage?: AgentChatUsage;
  aborted?: boolean;
}

export interface AgentChatRequest {
  messages: readonly AgentChatMessage[];
  tools?: readonly AgentToolSchema[];
  profileId?: string;
}

/** 引擎只需要 `reply`；ChatClient 结构性满足（app-repo 落地 function calling 后自然接上）。 */
export interface AgentChatClient {
  reply(request: AgentChatRequest, handlers?: { signal?: AbortSignal }): Promise<AgentChatReply>;
}

/** 恢复所需的最小检查点（与 `agent.event.append(kind:'checkpoint')` 的 data 同形）。 */
export interface AgentCheckpoint {
  messages: readonly AgentChatMessage[];
  rounds: number;
  toolCalls: number;
  usd: number;
  executedTools: readonly string[];
}

/** 引擎持久化端口：由仓储/op 层实现（本批只定义契约，UI 接线在下一批）。 */
export interface AgentRunStore {
  startRun(input: {
    runId: string;
    goal: string;
    budget: AgentBudget;
    sessionId?: string;
    modelProfileId?: string;
    createdAt: number;
  }): Promise<void>;
  appendEvent(input: { runId: string; eventId: string; kind: AgentEventKind; data: unknown; at: number }): Promise<void>;
  finishRun(input: { runId: string; status: AgentRunFinishStatus; at: number }): Promise<void>;
  loadCheckpoint(runId: string): Promise<AgentCheckpoint | undefined>;
}

export interface AgentEngineEvent {
  eventId: string;
  runId: string;
  kind: AgentEventKind;
  data: unknown;
  at: number;
}

export type AgentStopReason =
  | 'completed'
  | 'cancelled'
  | 'budget-rounds'
  | 'budget-tool-calls'
  | 'budget-usd'
  | 'error'
  | 'guard-blocked'
  | 'no-checkpoint';

export interface AgentRunResult {
  runId: string;
  status: AgentRunFinishStatus;
  stopReason: AgentStopReason;
  /** 最终正文（只有 done 时有意义；失败/取消可能是空串）。 */
  text: string;
  rounds: number;
  toolCalls: number;
  usd: number;
  events: readonly AgentEngineEvent[];
}

export interface AgentEngineOptions {
  goal: string;
  chat: AgentChatClient;
  tools: AgentToolRegistry;
  store: AgentRunStore;
  budget: AgentBudget;
  signal?: AbortSignal;
  onEvent?: (event: AgentEngineEvent) => void;
  /** guard 工具（提案类）默认拒绝；审批策略确认后才允许。 */
  allowGuardTools?: boolean;
  /** 把 usage 换成美元；不提供时 maxUsd 只是记录字段、无法约束（文档已写明）。 */
  costOf?: (usage: AgentChatUsage | undefined) => number;
  sessionId?: string;
  modelProfileId?: string;
  runId?: string;
  now?: () => number;
  newEventId?: () => string;
  newRunId?: () => string;
}

interface LoopState {
  messages: AgentChatMessage[];
  rounds: number;
  toolCalls: number;
  usd: number;
  executedTools: string[];
}

function checkpointOf(state: LoopState): AgentCheckpoint {
  return {
    messages: state.messages,
    rounds: state.rounds,
    toolCalls: state.toolCalls,
    usd: state.usd,
    executedTools: state.executedTools,
  };
}

/** 工具调用参数：宿主可能给 JSON 字符串；解析失败就把原值交给 schema 校验去拒绝。 */
export function normalizeToolArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  const trimmed = value.trim();
  if (trimmed === '') return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

async function runLoop(options: AgentEngineOptions, runId: string, isResume: boolean): Promise<AgentRunResult> {
  const now = options.now ?? (() => Date.now());
  const newEventId = options.newEventId ?? (() => ulid());
  const events: AgentEngineEvent[] = [];
  const state: LoopState = { messages: [], rounds: 0, toolCalls: 0, usd: 0, executedTools: [] };

  const emit = async (kind: AgentEventKind, data: unknown): Promise<void> => {
    const event: AgentEngineEvent = { eventId: newEventId(), runId, kind, data, at: now() };
    await options.store.appendEvent({ runId, eventId: event.eventId, kind, data, at: event.at });
    events.push(event);
    options.onEvent?.(event);
  };

  const finish = async (status: AgentRunFinishStatus, stopReason: AgentStopReason, text = ''): Promise<AgentRunResult> => {
    await options.store.finishRun({ runId, status, at: now() });
    await emit('status', { phase: 'finished', status, stopReason, rounds: state.rounds, toolCalls: state.toolCalls, usd: state.usd });
    return { runId, status, stopReason, text, rounds: state.rounds, toolCalls: state.toolCalls, usd: state.usd, events };
  };

  const emitCheckpoint = async (): Promise<void> => {
    await emit('checkpoint', checkpointOf(state));
  };

  if (isResume) {
    const checkpoint = await options.store.loadCheckpoint(runId);
    if (checkpoint === undefined) {
      return finish('failed', 'no-checkpoint');
    }
    state.messages = [...checkpoint.messages];
    state.rounds = checkpoint.rounds;
    state.toolCalls = checkpoint.toolCalls;
    state.usd = checkpoint.usd;
    state.executedTools = [...checkpoint.executedTools];
  } else {
    state.messages = [{ role: 'user', content: options.goal }];
    await options.store.startRun({
      runId,
      goal: options.goal,
      budget: options.budget,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.modelProfileId === undefined ? {} : { modelProfileId: options.modelProfileId }),
      createdAt: now(),
    });
    await emit('status', { phase: 'started', goal: options.goal, budget: options.budget });
  }

  const toolContext: AgentToolContext = {
    runId,
    ...(options.allowGuardTools === true ? { allowGuard: true } : {}),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  for (;;) {
    if (isAborted(options.signal)) return finish('cancelled', 'cancelled');
    if (state.rounds >= options.budget.maxRounds) {
      await emitCheckpoint();
      return finish('blocked', 'budget-rounds');
    }
    state.rounds += 1;

    let reply: AgentChatReply;
    try {
      reply = await options.chat.reply(
        {
          // 传快照数组：调用方/假客户端可能保留这个引用，引擎之后还会 push，不能让它跟着变。
          messages: [...state.messages],
          tools: options.tools.definitions(),
          ...(options.modelProfileId === undefined ? {} : { profileId: options.modelProfileId }),
        },
        ...(options.signal === undefined ? [] : [{ signal: options.signal }]),
      );
    } catch (cause) {
      if (isAborted(options.signal)) return finish('cancelled', 'cancelled');
      await emit('error', { phase: 'reply', message: cause instanceof Error ? cause.message : String(cause) });
      return finish('failed', 'error');
    }

    if (reply.aborted === true) return finish('cancelled', 'cancelled');
    state.messages.push({
      role: 'assistant',
      content: reply.text,
      ...(reply.toolCalls === undefined || reply.toolCalls.length === 0 ? {} : { toolCalls: reply.toolCalls }),
    });
    await emit('assistant', { text: reply.text, toolCalls: reply.toolCalls ?? [] });

    if (options.costOf !== undefined) {
      state.usd += options.costOf(reply.usage);
      if (options.budget.maxUsd !== undefined && state.usd > options.budget.maxUsd) {
        await emitCheckpoint();
        return finish('blocked', 'budget-usd', reply.text);
      }
    }

    const calls = reply.toolCalls ?? [];
    if (calls.length === 0) {
      await emitCheckpoint();
      return finish('done', 'completed', reply.text);
    }

    for (const call of calls) {
      if (isAborted(options.signal)) return finish('cancelled', 'cancelled');
      state.toolCalls += 1;
      if (state.toolCalls > options.budget.maxToolCalls) {
        await emitCheckpoint();
        return finish('blocked', 'budget-tool-calls', reply.text);
      }
      state.executedTools.push(call.name);
      await emit('tool', { toolCallId: call.id, name: call.name, arguments: call.arguments });
      const result = await options.tools.execute(call.name, normalizeToolArguments(call.arguments), toolContext);
      await emit('tool_result', {
        toolCallId: call.id,
        name: call.name,
        ok: result.ok,
        ...(result.ok ? { value: result.value } : { error: result.error }),
      });
      if (result.ok === false && result.error.code === 'tier-blocked') {
        await emitCheckpoint();
        return finish('blocked', 'guard-blocked', reply.text);
      }
      state.messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(result) });
    }
    await emitCheckpoint();
  }
}

/** 取消判定收口：函数调用避免 TS 把上一次的 `aborted === false` 窄化带进下一轮。 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** 开始一次 Agent 运行。 */
export async function runAgent(options: AgentEngineOptions): Promise<AgentRunResult> {
  const runId = options.runId ?? (options.newRunId ?? (() => ulid()))();
  return runLoop(options, runId, false);
}

/** 从最近一条 checkpoint 恢复（不重复 start，也不重放已执行的工具）。 */
export async function resumeAgent(options: AgentEngineOptions & { runId: string }): Promise<AgentRunResult> {
  return runLoop(options, options.runId, true);
}
