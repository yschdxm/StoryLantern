/**
 * Agent 工具注册表（PLAN §7）：只读工具 + 提案工具。
 *
 * 三条门禁都在这里（引擎与 UI 共用一个入口）：
 *  1. **tier**：`restrict` 直接执行；`guard` 必须显式 `allowGuard`（默认拒绝）；
 *  2. **参数 schema**：手写校验（`agent-tool-schema.ts`），坏参数不执行；
 *  3. **错误不吞**：未知工具/坏参数/执行异常都返回结构化 error（引擎会把它们写进 tool_result）。
 */

import { createProposalTools } from './agent-tool-proposals.ts';
import { createReadTools } from './agent-tool-reads.ts';
import { validateAgentArgs } from './agent-tool-schema.ts';
import type {
  AgentToolContext,
  AgentToolDefinition,
  AgentToolDeps,
  AgentToolExecution,
  AgentToolSchema,
} from './agent-tool-types.ts';

export interface AgentToolRegistry {
  /** 全部工具定义（执行用）。 */
  list(): readonly AgentToolDefinition[];
  /** 给模型看的函数工具定义（JSON Schema）。 */
  definitions(): readonly AgentToolSchema[];
  has(name: string): boolean;
  execute(name: string, rawArgs: unknown, context: AgentToolContext): Promise<AgentToolExecution>;
}

function toSchema(tool: AgentToolDefinition): AgentToolSchema {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}

export function createAgentTools(deps: AgentToolDeps): AgentToolRegistry {
  const tools = new Map<string, AgentToolDefinition>();
  for (const tool of [...createReadTools(deps), ...createProposalTools(deps)]) {
    if (tools.has(tool.name)) throw new Error(`Agent 工具重名：${tool.name}`);
    tools.set(tool.name, tool);
  }
  const list = [...tools.values()];

  return {
    list: () => list,
    definitions: () => list.map(toSchema),
    has: (name) => tools.has(name),

    async execute(name, rawArgs, context) {
      const tool = tools.get(name);
      if (tool === undefined) {
        return { ok: false, error: { code: 'unknown-tool', message: `没有这个工具：${name}` } };
      }
      if (tool.tier === 'guard' && context.allowGuard !== true) {
        return { ok: false, error: { code: 'tier-blocked', message: `工具 ${name} 是 guard 级：需要显式开启（审批策略）` } };
      }
      const args = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
      const errors = validateAgentArgs(tool.parameters, args);
      if (errors.length > 0) {
        return { ok: false, error: { code: 'invalid-arguments', message: `工具 ${name} 参数不合法：${errors.join('；')}` } };
      }
      const record = args as Readonly<Record<string, unknown>>;
      try {
        return { ok: true, value: await tool.execute(record, context) };
      } catch (cause) {
        return {
          ok: false,
          error: { code: 'tool-error', message: cause instanceof Error ? cause.message : String(cause) },
        };
      }
    },
  };
}

export type {
  AgentToolContext,
  AgentToolDefinition,
  AgentToolDeps,
  AgentToolExecution,
  AgentToolSchema,
  AgentToolTier,
} from './agent-tool-types.ts';
