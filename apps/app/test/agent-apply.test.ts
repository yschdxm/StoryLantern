import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentProposalKind, AgentProposalRecord } from '../../../packages/oplog/src/index.ts';
import type { CharacterCard, LoreCard, SceneCard } from '../../../packages/cards/src/index.ts';
import type { Memory, Message } from '../src/data/types.ts';
import { applyAgentProposal, type AgentApplyContext, type AgentApplyResult } from '../src/data/agent-apply.ts';

/**
 * 提案应用（审批后 → 中立动作）：
 *  - 四种 kind 的正常/拒绝/目标不存在/缺字段；
 *  - **不修改输入对象**（纯函数）；
 *  - 拒绝必须给明确 reason（不能静默兜底或拿拼接冒充模型合并）。
 */

const meta = (id: string, name: string, schema: string) => ({
  id, schema, name, version: '1.0.0', language: 'zh-CN', rating: 'general' as const, description: '',
});

const loreCard = (patch: Partial<LoreCard> = {}): LoreCard => ({
  card_type: 'lore', meta: meta('l1', '银月战争', 'lore/v1'), kind: 'history',
  content: '旧内容。', keys: ['月亮'], ...patch,
});

const characterCard = (patch: Partial<CharacterCard> = {}): CharacterCard => ({
  card_type: 'character', meta: meta('c1', '林霜', 'rolecard/v1'),
  identity: { name: '林霜', background: '' },
  persona: { summary: '', traits: [], knowledge_boundary: '', ability_boundary: '' },
  speech: { style: '' }, prompts: { system_extra: '旧提示。' }, ...patch,
});

const sceneCard = (): SceneCard => ({
  card_type: 'scene', meta: meta('s1', '酒馆', 'scene/v1'), type: 'physical', description: '',
});

const memory = (id: string, patch: Partial<Memory> = {}): Memory => ({
  id, characterId: 'c1', text: `记忆 ${id}`, keys: [], importance: 50,
  sourceSessionId: 'sess1', sourceMessageIds: [`msg-${id}`], createdBy: 'user', createdAt: 1, updatedAt: 1, ...patch,
});

const assistant: Message = {
  id: 'a1', sessionId: 'sess1', role: 'assistant', content: '原文。', status: 'done',
  createdAt: 1, candidates: [], selectedCandidateId: '',
};
const userMessage: Message = {
  id: 'u1', sessionId: 'sess1', role: 'user', content: '用户的话。', status: 'done',
  createdAt: 2, candidates: [], selectedCandidateId: '',
};

const context: AgentApplyContext = {
  cards: [loreCard(), characterCard(), sceneCard()],
  memories: [memory('m1'), memory('m2'), memory('m3', { characterId: 'c2' })],
  messages: [assistant, userMessage],
  settings: {},
};

function proposal(
  kind: AgentProposalKind,
  payload: unknown,
  patch: Partial<AgentProposalRecord> = {},
): AgentProposalRecord {
  return {
    proposalId: 'p1',
    runId: 'r1',
    kind,
    summary: '一条提案',
    payload,
    status: 'pending',
    createdAt: 1,
    createdHlc: { t: 1, c: 0 },
    createdOpId: 'op1',
    ...patch,
  };
}

function ok(result: AgentApplyResult): Extract<AgentApplyResult, { ok: true }> {
  assert.equal(result.ok, true, result.ok ? '' : result.reason);
  return result as Extract<AgentApplyResult, { ok: true }>;
}

function rejected(result: AgentApplyResult, pattern: RegExp): void {
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, pattern);
}

test('lorebook_patch：目标典籍 → card.patch 追加正文；不修改输入', () => {
  const before = JSON.stringify(context);
  const result = ok(applyAgentProposal(proposal('lorebook_patch', { targetCardId: 'l1', patch: '新补的一段。' }), context));
  assert.deepEqual(result.actions, [{ kind: 'card.patch', cardId: 'l1', patch: { content: '旧内容。\n\n新补的一段。' } }]);
  assert.match(result.summary, /追加典籍/);
  assert.equal(JSON.stringify(context), before, '输入对象必须原样');
});

test('lorebook_patch：目标不存在 → card.upsert 新常驻典籍卡（确定性 id/name）', () => {
  const summary = '银月教会的祷词与禁忌'.repeat(5);
  const result = ok(applyAgentProposal(proposal('lorebook_patch', { patch: '祷词必须站着念。' }, { summary }), context));
  const action = result.actions[0];
  assert.equal(action?.kind, 'card.upsert');
  const card = action?.kind === 'card.upsert' ? action.card : undefined;
  assert.equal(card?.card_type, 'lore');
  assert.equal(card?.meta.id, 'lore-p1');
  assert.equal(card?.meta.name.length, 40);
  assert.equal(card?.meta.language, 'zh-CN');
  assert.equal(card?.meta.description, '祷词必须站着念。');
  if (card?.card_type !== 'lore') throw new Error('应为 lore');
  assert.equal(card.content, '祷词必须站着念。');
  assert.deepEqual(card.keys, []);
  assert.deepEqual(card.trigger, { constant: true });
});

test('lorebook_patch：目标是角色卡/缺 patch/已包含 → 拒绝或 no-op', () => {
  rejected(applyAgentProposal(proposal('lorebook_patch', { targetCardId: 'c1', patch: 'x' }), context), /不是典籍/);
  rejected(applyAgentProposal(proposal('lorebook_patch', { targetCardId: 'l1' }), context), /缺少非空 patch/);
  rejected(applyAgentProposal(proposal('lorebook_patch', { targetCardId: 'missing', patch: 'x' }), context), /目标卡片不存在/);
  const noop = ok(applyAgentProposal(proposal('lorebook_patch', { targetCardId: 'l1', patch: '旧内容。' }), context));
  assert.deepEqual(noop.actions, []);
  assert.match(noop.summary, /无需修改/);
});

test('prompt_patch：目标角色 → card.patch 追加 prompts.system_extra', () => {
  const result = ok(applyAgentProposal(proposal('prompt_patch', { targetCardId: 'c1', patch: '多用短句。' }), context));
  assert.deepEqual(result.actions, [
    { kind: 'card.patch', cardId: 'c1', patch: { prompts: { system_extra: '旧提示。\n\n多用短句。' } } },
  ]);
});

test('prompt_patch：无目标 → setting.set chat.authors_note（追加）；目标不存在 → 拒绝', () => {
  const result = ok(applyAgentProposal(proposal('prompt_patch', { patch: '本次保持克制。' }), context));
  assert.deepEqual(result.actions, [{ kind: 'setting.set', key: 'chat.authors_note', value: '本次保持克制。' }]);

  const withExisting = ok(applyAgentProposal(
    proposal('prompt_patch', { patch: '追加一句。' }),
    { ...context, settings: { 'chat.authors_note': '原有作者注。' } },
  ));
  assert.deepEqual(withExisting.actions, [{ kind: 'setting.set', key: 'chat.authors_note', value: '原有作者注。\n\n追加一句。' }]);

  rejected(applyAgentProposal(proposal('prompt_patch', { targetCardId: 'missing', patch: 'x' }), context), /目标卡片不存在/);
  rejected(applyAgentProposal(proposal('prompt_patch', { targetCardId: 's1', patch: 'x' }), context), /不是角色/);
  rejected(applyAgentProposal(proposal('prompt_patch', {}), context), /缺少非空 patch/);
});

test('memory_compaction：≥2 条且同角色 → memory.merge，合并 provenance 后去重排序', () => {
  const result = ok(applyAgentProposal(
    proposal('memory_compaction', { memoryIds: ['m2', 'm1'], mergedText: '两条记忆合成的结论。' }),
    context,
  ));
  assert.deepEqual(result.actions, [{
    kind: 'memory.merge',
    memoryIds: ['m2', 'm1'],
    text: '两条记忆合成的结论。',
    characterId: 'c1',
    sourceMessageIds: ['msg-m1', 'msg-m2'],
  }]);
  assert.match(result.summary, /2 条记忆/);
});

test('memory_compaction：缺 mergedText / 不足 2 条 / 重复 / 不存在 / 跨角色 → 全部拒绝', () => {
  rejected(applyAgentProposal(proposal('memory_compaction', { memoryIds: ['m1', 'm2'] }), context), /缺少 mergedText/);
  rejected(applyAgentProposal(proposal('memory_compaction', { memoryIds: ['m1', 'm2'], mergedText: '   ' }), context), /缺少 mergedText/);
  rejected(applyAgentProposal(proposal('memory_compaction', { memoryIds: ['m1'], mergedText: 'x' }), context), /至少 2 个/);
  rejected(applyAgentProposal(proposal('memory_compaction', { memoryIds: ['m1', 'm1'], mergedText: 'x' }), context), /不能重复/);
  rejected(applyAgentProposal(proposal('memory_compaction', { memoryIds: ['m1', 'missing'], mergedText: 'x' }), context), /记忆不存在/);
  rejected(applyAgentProposal(proposal('memory_compaction', { memoryIds: ['m1', 'm3'], mergedText: 'x' }), context), /跨角色/);
});

test('reply_rewrite：assistant + 非空 rewrittenText → message.edit；否则拒绝', () => {
  const result = ok(applyAgentProposal(proposal('reply_rewrite', { messageId: 'a1', rewrittenText: '改写后的正文。' }), context));
  assert.deepEqual(result.actions, [{ kind: 'message.edit', messageId: 'a1', content: '改写后的正文。' }]);
  rejected(applyAgentProposal(proposal('reply_rewrite', { messageId: 'a1' }), context), /缺少非空 rewrittenText/);
  rejected(applyAgentProposal(proposal('reply_rewrite', { rewrittenText: 'x' }), context), /缺少 messageId/);
  rejected(applyAgentProposal(proposal('reply_rewrite', { messageId: 'u1', rewrittenText: 'x' }), context), /只能改写 assistant/);
  rejected(applyAgentProposal(proposal('reply_rewrite', { messageId: 'missing', rewrittenText: 'x' }), context), /消息不存在/);
});

test('通用拒绝：summary 空 / 已处理 / payload 非对象 / 未知 kind', () => {
  rejected(applyAgentProposal(proposal('lorebook_patch', { patch: 'x' }, { summary: '   ' }), context), /缺少 summary/);
  rejected(applyAgentProposal(proposal('lorebook_patch', { patch: 'x' }, { status: 'approved' }), context), /不能重复应用/);
  rejected(applyAgentProposal(proposal('lorebook_patch', 'not-object'), context), /payload 必须是对象/);
  rejected(applyAgentProposal(proposal('future_kind' as AgentProposalKind, {}), context), /未知的提案类型/);
});

test('纯函数：所有正常路径都不修改输入（cards/memories/messages/settings 原样）', () => {
  const snapshot = JSON.stringify(context);
  ok(applyAgentProposal(proposal('prompt_patch', { targetCardId: 'c1', patch: '补一句。' }), context));
  ok(applyAgentProposal(proposal('prompt_patch', { patch: '作者注。' }), context));
  ok(applyAgentProposal(proposal('memory_compaction', { memoryIds: ['m1', 'm2'], mergedText: '合并。' }), context));
  ok(applyAgentProposal(proposal('reply_rewrite', { messageId: 'a1', rewrittenText: '新正文。' }), context));
  assert.equal(JSON.stringify(context), snapshot);
});
