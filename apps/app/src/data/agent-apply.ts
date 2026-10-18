/**
 * 提案应用（审批之后 → 中立动作）。**纯函数，不造 op、不写库**。
 *
 * 为什么先产出"中立动作"而不是直接 `Op`：批准提案的人/流程只该关心"改什么"，
 * 具体落成哪条 op 由仓储层（app-repo）翻译；这样应用逻辑能在 Node 里穷举测试，
 * 也不会把 op 基座（deviceId/HLC）带进纯函数。
 *
 * 严格性：**不猜**。缺字段、目标不存在/类型不符、kind 未知、summary 为空、非 pending 提案
 * 一律返回明确 reason；`memory_compaction` 没有 mergedText 直接拒绝（绝不拿拼接冒充模型合并）。
 *
 * 合并语义（写清，避免两种真相）：
 *  - `lorebook_patch` 目标典籍 → `content` **追加**（空行分隔；已包含则 no-op）；
 *    目标不存在 → 新建 lore 卡（id = `lore-<proposalId>`，常驻触发 `constant:true`，作者可改）。
 *  - `prompt_patch` 角色卡 → `prompts.system_extra` **追加**（空行分隔；已包含则 no-op）；
 *    无目标 → 设置 `chat.authors_note` 追加（同一个追加规则）。
 *  - `memory_compaction` → `memory.merge`，带 `characterId` 与合并后的 `sourceMessageIds`（保留 provenance）。
 *  - `reply_rewrite` → `message.edit`（只允许 assistant 消息）。
 */

import type { AgentProposalRecord } from '../../../../packages/oplog/src/index.ts';
import type { CardDocument, CharacterCard, LoreCard } from '../../../../packages/cards/src/index.ts';
import { SETTING_KEYS, type Memory, type MemoryDraft, type Message } from './types.ts';

export type AgentApplyAction =
  | { kind: 'card.upsert'; card: CardDocument }
  | { kind: 'card.patch'; cardId: string; patch: { content?: string; prompts?: { system_extra?: string } } }
  | { kind: 'memory.merge'; memoryIds: string[]; text: string; characterId: string; sourceMessageIds: string[] }
  | { kind: 'memory.upsert'; memory: MemoryDraft }
  | { kind: 'message.edit'; messageId: string; content: string }
  | { kind: 'setting.set'; key: string; value: string };

export interface AgentApplyContext {
  cards: readonly CardDocument[];
  memories: readonly Memory[];
  messages: readonly Message[];
  settings: Readonly<Record<string, string>>;
}

export type AgentApplyResult =
  | { ok: true; actions: AgentApplyAction[]; summary: string }
  | { ok: false; reason: string };

const NAME_MAX = 40;
const NEW_CARD_VERSION = '1.0.0';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function fail(reason: string): AgentApplyResult {
  return { ok: false, reason };
}

/** 追加文本；已包含则返回 undefined（调用方决定 no-op）。 */
function appendText(existing: string | undefined, patch: string): string | undefined {
  const base = (existing ?? '').trim();
  if (base === '') return patch;
  if (base.includes(patch)) return undefined;
  return `${base}\n\n${patch}`;
}

function firstLine(text: string): string {
  const line = text.split('\n').map((part) => part.trim()).find((part) => part !== '');
  return line === undefined ? '' : Array.from(line).slice(0, 80).join('');
}

function languageOf(context: AgentApplyContext): string {
  const value = context.settings[SETTING_KEYS.locale];
  return value === 'en' ? 'en' : 'zh-CN';
}

function newLoreCard(proposal: AgentProposalRecord, summary: string, patch: string, context: AgentApplyContext): LoreCard {
  const name = Array.from(summary).slice(0, NAME_MAX).join('');
  return {
    card_type: 'lore',
    meta: {
      // 确定性 id：同一个提案无论应用几次都指向同一张卡（幂等由仓储层保证）。
      id: `lore-${proposal.proposalId}`,
      schema: 'lore/v1',
      name,
      version: NEW_CARD_VERSION,
      language: languageOf(context),
      rating: 'general',
      description: firstLine(patch),
    },
    kind: 'other',
    content: patch,
    keys: [],
    // 没有关键词可触发：常驻注入保证"新卡立即可用"；作者可在编辑器里改成关键词触发。
    trigger: { constant: true },
  };
}

function applyLorebookPatch(proposal: AgentProposalRecord, payload: Record<string, unknown>, context: AgentApplyContext): AgentApplyResult {
  const patch = textOf(payload['patch']);
  if (patch === undefined) return fail('lorebook_patch 缺少非空 patch（要写入的正文）');
  const targetCardId = payload['targetCardId'];
  if (targetCardId !== undefined && (typeof targetCardId !== 'string' || targetCardId.trim() === '')) {
    return fail('targetCardId 必须是非空字符串（或省略表示新建）');
  }
  if (targetCardId !== undefined) {
    const target = context.cards.find((card) => card.meta.id === targetCardId);
    if (target === undefined) return fail(`目标卡片不存在：${targetCardId}`);
    if (target.card_type !== 'lore') return fail(`目标卡片不是典籍（card_type=${target.card_type}）：${targetCardId}`);
    const content = appendText(target.content, patch);
    if (content === undefined) return { ok: true, actions: [], summary: '典籍内容已包含这段补丁，无需修改' };
    return { ok: true, actions: [{ kind: 'card.patch', cardId: targetCardId, patch: { content } }], summary: `追加典籍「${target.meta.name}」的正文` };
  }
  const summary = textOf(proposal.summary) ?? '';
  return {
    ok: true,
    actions: [{ kind: 'card.upsert', card: newLoreCard(proposal, summary, patch, context) }],
    summary: `新建典籍卡「${Array.from(summary).slice(0, NAME_MAX).join('')}」`,
  };
}

function applyPromptPatch(proposal: AgentProposalRecord, payload: Record<string, unknown>, context: AgentApplyContext): AgentApplyResult {
  const patch = textOf(payload['patch']);
  if (patch === undefined) return fail('prompt_patch 缺少非空 patch（要追加的提示词）');
  const targetCardId = payload['targetCardId'];
  if (targetCardId !== undefined && (typeof targetCardId !== 'string' || targetCardId.trim() === '')) {
    return fail('targetCardId 必须是非空字符串（或省略表示写会话作者注）');
  }
  if (targetCardId !== undefined) {
    const target = context.cards.find((card) => card.meta.id === targetCardId);
    if (target === undefined) return fail(`目标卡片不存在：${targetCardId}`);
    if (target.card_type !== 'character') return fail(`目标卡片不是角色（card_type=${target.card_type}）：${targetCardId}`);
    const character = target as CharacterCard;
    const merged = appendText(character.prompts?.system_extra, patch);
    if (merged === undefined) return { ok: true, actions: [], summary: '角色提示已包含这段补丁，无需修改' };
    return {
      ok: true,
      actions: [{ kind: 'card.patch', cardId: targetCardId, patch: { prompts: { system_extra: merged } } }],
      summary: `追加角色「${character.meta.name}」的自带提示`,
    };
  }
  const merged = appendText(context.settings[SETTING_KEYS.authorsNote], patch);
  if (merged === undefined) return { ok: true, actions: [], summary: '作者注已包含这段补丁，无需修改' };
  return {
    ok: true,
    actions: [{ kind: 'setting.set', key: SETTING_KEYS.authorsNote, value: merged }],
    summary: '追加到本会话作者注（chat.authors_note）',
  };
}

function applyMemoryCompaction(payload: Record<string, unknown>, context: AgentApplyContext): AgentApplyResult {
  const rawIds = payload['memoryIds'];
  if (!Array.isArray(rawIds) || rawIds.length < 2) return fail('memory_compaction 需要至少 2 个 memoryIds');
  const memoryIds = rawIds.map((id) => (typeof id === 'string' ? id.trim() : ''));
  if (memoryIds.some((id) => id === '')) return fail('memoryIds 必须是非空字符串数组');
  if (new Set(memoryIds).size !== memoryIds.length) return fail('memoryIds 不能重复');

  const found: Memory[] = [];
  for (const id of memoryIds) {
    const memory = context.memories.find((item) => item.id === id);
    if (memory === undefined) return fail(`记忆不存在：${id}`);
    found.push(memory);
  }
  const mergedText = textOf(payload['mergedText']);
  if (mergedText === undefined) return fail('提案缺少 mergedText，不能合并');

  const characterIds = new Set(found.map((memory) => memory.characterId));
  if (characterIds.size !== 1) return fail('不能跨角色合并记忆（characterId 不一致）');
  const characterId = found[0]?.characterId ?? '';
  const sourceMessageIds = [...new Set(found.flatMap((memory) => memory.sourceMessageIds))].sort();
  return {
    ok: true,
    actions: [{ kind: 'memory.merge', memoryIds: [...memoryIds], text: mergedText, characterId, sourceMessageIds }],
    summary: `合并 ${memoryIds.length} 条记忆（保留 provenance ${sourceMessageIds.length} 条来源）`,
  };
}

function applyReplyRewrite(payload: Record<string, unknown>, context: AgentApplyContext): AgentApplyResult {
  const messageId = payload['messageId'];
  if (typeof messageId !== 'string' || messageId.trim() === '') return fail('reply_rewrite 缺少 messageId');
  const rewritten = textOf(payload['rewrittenText']);
  if (rewritten === undefined) return fail('reply_rewrite 缺少非空 rewrittenText（不能拿空文本冒充改写）');
  const message = context.messages.find((item) => item.id === messageId);
  if (message === undefined) return fail(`消息不存在：${messageId}`);
  if (message.role !== 'assistant') return fail(`只能改写 assistant 消息（这条是 ${message.role}）：${messageId}`);
  return {
    ok: true,
    actions: [{ kind: 'message.edit', messageId, content: rewritten }],
    summary: `改写助手消息 ${messageId}`,
  };
}

/** 把一条**已批准**的提案翻译成中立动作；任何不合法都返回 reason，不做任何兜底猜测。 */
export function applyAgentProposal(proposal: AgentProposalRecord, context: AgentApplyContext): AgentApplyResult {
  const summary = typeof proposal.summary === 'string' ? proposal.summary.trim() : '';
  if (summary === '') return fail('提案缺少 summary，无法安全应用');
  if (proposal.status !== 'pending') return fail(`提案已是 ${proposal.status}，不能重复应用`);
  if (!isRecord(proposal.payload)) return fail('提案 payload 必须是对象');

  switch (proposal.kind) {
    case 'lorebook_patch': return applyLorebookPatch(proposal, proposal.payload, context);
    case 'prompt_patch': return applyPromptPatch(proposal, proposal.payload, context);
    case 'memory_compaction': return applyMemoryCompaction(proposal.payload, context);
    case 'reply_rewrite': return applyReplyRewrite(proposal.payload, context);
    default: return fail(`未知的提案类型：${String(proposal.kind)}`);
  }
}
