/**
 * Agent 工具的类型契约（registry / 执行器 / 引擎共用）。
 *
 * 依赖用**窄接口**而不是 AppStore：工具只读仓储与状态，测试用假实现即可，
 * 不会把整棵应用状态树拖进纯函数测试。
 */

import type { Message } from './types.ts';
import type { Summary } from './summary-types.ts';
import type { RequestLogPort } from './request-log.ts';
import type { AgentJsonSchema } from './agent-tool-schema.ts';
import type { AgentProposalKind } from '../../../../packages/oplog/src/index.ts';

/** 工具能看到的只读数据（AppStore 结构性满足它）。 */
export interface AgentToolStore {
  getState(): { messages: readonly Message[]; activeSessionId?: string };
  actions: {
    messagesOf(sessionId: string): Promise<readonly Message[]>;
    summariesOf(sessionId: string): Promise<readonly Summary[]>;
  };
}

/** 提案只创建 pending、不写业务数据：所以端口只有一个 create。 */
export interface AgentProposalPort {
  create(input: {
    proposalId: string;
    runId: string;
    kind: AgentProposalKind;
    summary: string;
    payload: unknown;
  }): Promise<void>;
}

export interface AgentToolDeps {
  store: AgentToolStore;
  /** 请求审计日志（本机 kv）；没有就不假装有 —— readRequest 会明确返回空原因。 */
  requestLog?: RequestLogPort;
  /** 提案端口；没有时提案工具返回明确错误（不会静默丢弃）。 */
  proposals?: AgentProposalPort;
  newId?: () => string;
  now?: () => number;
}

export interface AgentToolContext {
  runId: string;
  /** guard 工具必须显式开启（例如通过了用户审批策略）。缺省 false = 拒绝。 */
  allowGuard?: boolean;
  signal?: AbortSignal;
}

export type AgentToolTier = 'restrict' | 'guard';

export interface AgentToolDefinition {
  name: string;
  description: string;
  tier: AgentToolTier;
  parameters: AgentJsonSchema;
  execute(args: Readonly<Record<string, unknown>>, context: AgentToolContext): Promise<unknown>;
}

/** 给 ChatClient 的 tool 定义（OpenAI 兼容形状；只含函数工具）。 */
export interface AgentToolSchema {
  type: 'function';
  function: { name: string; description: string; parameters: AgentJsonSchema };
}

export type AgentToolExecution =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } };
