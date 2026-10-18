/**
 * 提案类工具（tier = `guard`）：**只创建 pending proposal，不写任何业务数据**。
 *
 * 为什么单独一层：PLAN §7 的门禁是"任何 Agent 写入都必须有 ApprovalRecord"。
 * 这里连写入都不做——只把"要改什么"落成一条待审提案；批准与应用是下一批（UI/审批）的事。
 * `guard` 的意思是：执行这类工具必须显式开启（引擎 `allowGuardTools` / 审批策略），
 * 不能因为模型自己想调就默认执行。
 */

import { ulid } from '../../../../packages/oplog/src/index.ts';
import type { AgentProposalKind } from '../../../../packages/oplog/src/index.ts';
import type { AgentToolContext, AgentToolDefinition, AgentToolDeps } from './agent-tool-types.ts';

interface ProposalInput {
  proposalId: string;
  runId: string;
  kind: AgentProposalKind;
  summary: string;
  payload: unknown;
}

async function createProposal(
  deps: AgentToolDeps,
  context: AgentToolContext,
  kind: AgentProposalKind,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  if (deps.proposals === undefined) {
    throw new Error('这个运行没有接入提案端口（proposals）；不能假装创建了提案');
  }
  const summary = String(args['summary']);
  const payload = { ...args, summary: undefined };
  delete (payload as Record<string, unknown>)['summary'];
  const input: ProposalInput = {
    proposalId: (deps.newId ?? (() => ulid()))(),
    runId: context.runId,
    kind,
    summary,
    payload,
  };
  await deps.proposals.create(input);
  return {
    proposalId: input.proposalId,
    runId: input.runId,
    kind,
    status: 'pending',
    summary,
    note: '只创建了待审提案；没有应用任何修改。批准与写入由用户/审批流负责。',
  };
}

const SUMMARY_SCHEMA = { type: 'string' as const, minLength: 1, maxLength: 500, description: '一句话说明提案要做什么、为什么' };

export function createProposalTools(deps: AgentToolDeps): AgentToolDefinition[] {
  return [
    {
      name: 'proposeLorebookPatch',
      description: '提出一条典籍/世界书修改提案（只创建待审提案，不写数据）。',
      tier: 'guard',
      parameters: {
        type: 'object',
        properties: {
          summary: SUMMARY_SCHEMA,
          targetCardId: { type: 'string', description: '要修改的典籍卡 id；新建可省略' },
          patch: { type: 'string', minLength: 1, description: '建议的新增/修改内容' },
        },
        required: ['summary', 'patch'],
        additionalProperties: false,
      },
      execute: (args, context) => createProposal(deps, context, 'lorebook_patch', args),
    },
    {
      name: 'proposePromptPatch',
      description: '提出一条提示词/角色设定修改提案（只创建待审提案，不写数据）。',
      tier: 'guard',
      parameters: {
        type: 'object',
        properties: {
          summary: SUMMARY_SCHEMA,
          targetCardId: { type: 'string', description: '要修改的卡片 id；不填表示本次会话的自定义提示' },
          patch: { type: 'string', minLength: 1, description: '建议的提示词修改' },
        },
        required: ['summary', 'patch'],
        additionalProperties: false,
      },
      execute: (args, context) => createProposal(deps, context, 'prompt_patch', args),
    },
    {
      name: 'proposeMemoryCompaction',
      description: '提出一条记忆合并/压缩提案（只创建待审提案，不写数据）。',
      tier: 'guard',
      parameters: {
        type: 'object',
        properties: {
          summary: SUMMARY_SCHEMA,
          memoryIds: { type: 'array', items: { type: 'string' }, description: '要合并的记忆 id 列表（≥2）' },
          mergedText: {
            type: 'string',
            minLength: 1,
            description: '合并后的文本；缺它的提案**不可应用**（应用时会拒绝，不拿拼接冒充）',
          },
        },
        required: ['summary', 'memoryIds'],
        additionalProperties: false,
      },
      execute: (args, context) => createProposal(deps, context, 'memory_compaction', args),
    },
    {
      name: 'proposeReplyRewrite',
      description: '提出一条回复改写提案（只创建待审提案，不写数据）；缺 rewrittenText 的提案不可应用。',
      tier: 'guard',
      parameters: {
        type: 'object',
        properties: {
          summary: SUMMARY_SCHEMA,
          messageId: { type: 'string', description: '要改写的助手消息 id' },
          instruction: { type: 'string', minLength: 1, description: '改写要求' },
          rewrittenText: {
            type: 'string',
            minLength: 1,
            description: '改写后的正文（必填；审批时会作为新版本写入，缺它的提案不可应用）',
          },
        },
        required: ['summary', 'messageId', 'instruction', 'rewrittenText'],
        additionalProperties: false,
      },
      execute: (args, context) => createProposal(deps, context, 'reply_rewrite', args),
    },
  ];
}
