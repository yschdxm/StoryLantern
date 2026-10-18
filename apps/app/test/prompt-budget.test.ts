import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleBlocks } from '../../../plugins/writing-pipeline/src/index.ts';
import { Registry } from '../../../packages/plugin-api/src/index.ts';
import type { BlockDefinition } from '../../../plugins/context-blocks/src/index.ts';
import type {
  CharacterCard,
  ItemCard,
  LoreCard,
  SceneCard,
  SessionRuntime,
  SessionSetup,
} from '../../../packages/cards/src/index.ts';
import type { Memory } from '../src/data/types.ts';
import {
  createPromptBlockDataV2,
  buildChatRequestV2,
  type BuildChatRequestV2Options,
  type PromptTraceBlockV2,
} from '../src/data/prompt-v2.ts';
import { registerPromptBlocksV2, renderAllSections } from '../src/data/prompt-blocks-v2.ts';

/**
 * B20 每块预算/保留策略 + B21 实体级 source 在**应用装配层**的验收。
 *
 * 预算顺序：先块内截断（保住每块开头），再全局预算丢低优先级块；character/setup 必须保留。
 * 这里同时断言"管线路径"与"兜底路径"，因为聊天里两条路径都可能走（isModelConfigured 不同）。
 */

const meta = (id: string, name: string, schema: string) => ({
  id, schema, name, version: '1.0.0', language: 'zh-CN', description: '', rating: 'general' as const,
});

const characterCard = (patch: Partial<CharacterCard> = {}): CharacterCard => ({
  card_type: 'character',
  meta: meta('c1', '林霜', 'rolecard/v1'),
  identity: { name: '林霜', background: '' },
  persona: { summary: '冷面', traits: ['冷静'], knowledge_boundary: '', ability_boundary: '' },
  speech: { style: '短句' },
  ...patch,
});

const sceneCard = (patch: Partial<SceneCard> = {}): SceneCard => ({
  card_type: 'scene', meta: meta('s1', '边境酒馆', 'scene/v1'), type: 'physical', description: '酒馆',
  appearance: { summary: '昏暗。' }, ...patch,
});

const itemCard = (patch: Partial<ItemCard> = {}): ItemCard => ({
  card_type: 'item', meta: meta('i1', '月光剑', 'item/v1'), type: 'weapon', description: '', function: '', ...patch,
});

const loreCard = (patch: Partial<LoreCard> = {}): LoreCard => ({
  card_type: 'lore', meta: meta('l1', '银月战争', 'lore/v1'), kind: 'history', content: '月亮的事情。', keys: ['月亮'], ...patch,
});

const setupOf = (patch: Partial<SessionSetup> = {}): SessionSetup => ({
  characters: ['c1'], premise: '', opening_mode: 'auto', origin: 'user', ...patch,
});

const runtimeOf = (patch: Partial<SessionRuntime> = {}): SessionRuntime => ({
  variables: {}, items: {}, scene_state: {}, ...patch,
});

const optionsOf = (patch: Partial<BuildChatRequestV2Options> = {}): BuildChatRequestV2Options => ({
  settings: {}, sessionTitle: '测试会话', setup: setupOf(), cards: [], runtime: runtimeOf(), history: [], ...patch,
});

const pipelineOf = () => {
  const registry = new Registry<BlockDefinition>({ onDuplicate: 'replace' });
  registerPromptBlocksV2(registry);
  const blocks = registry.list().map((entry) => entry.value);
  return (context: Parameters<typeof assembleBlocks>[1], budget?: number) => assembleBlocks(blocks, context, budget ?? 2048);
};

const blockOf = (blocks: readonly PromptTraceBlockV2[], id: string): PromptTraceBlockV2 | undefined =>
  blocks.find((block) => block.id === id);

test('管线路径：两块同时超各自预算时分别块内截断，结尾加省略号并标 droppedChars', () => {
  const character = characterCard({ identity: { name: '林霜', background: '背'.repeat(2000) } });
  const lore = loreCard({ content: '设'.repeat(600), keys: ['月亮'] });
  const request = buildChatRequestV2(optionsOf({
    cards: [character, lore],
    history: [{ role: 'user', content: '月亮' }],
    assemble: pipelineOf(),
  }));
  const characterBlock = blockOf(request.trace.blocks, 'app.character');
  const loreBlock = blockOf(request.trace.blocks, 'app.lore.matched');
  assert.equal(characterBlock?.truncated, true, '角色块超 800 预算要被截断');
  assert.ok((characterBlock?.droppedChars ?? 0) > 0);
  assert.ok(request.systemPrompt.includes('…'));
  assert.equal(characterBlock?.tokenBudget, 800);
  assert.equal(loreBlock?.truncated, true, '典籍块超 500 预算要被截断');
  assert.equal(loreBlock?.tokenBudget, 500);
  assert.ok((loreBlock?.estimatedTokens ?? 0) <= 500);
});

test('兜底路径也执行每块预算：没有 assemble 时同样截断（不是只有管线才生效）', () => {
  const data = createPromptBlockDataV2({
    custom: '',
    setup: setupOf(),
    cards: [characterCard({ identity: { name: '林霜', background: '背'.repeat(2000) } })],
    runtime: runtimeOf(),
    history: [],
  });
  data.retrieval.lore = '设'.repeat(2000);
  const sections = renderAllSections(data);
  const character = sections.find((section) => section.id === 'app.character.c1');
  const lore = sections.find((section) => section.id === 'app.lore.matched');
  assert.equal(character?.truncated, true);
  assert.ok((character?.droppedChars ?? 0) > 0);
  assert.equal(character?.tokenBudget, 800);
  assert.equal(lore?.truncated, true);
  assert.equal(lore?.tokenBudget, 500);
});

test('保留策略：全局预算很小时 character/setup 仍纳入，其余低优先级块被丢', () => {
  const request = buildChatRequestV2(optionsOf({
    settings: { 'chat.system_prompt': '' },
    setup: setupOf({ premise: '雨夜投宿。' }),
    cards: [characterCard(), loreCard({ content: '月亮'.repeat(300), keys: ['月亮'] })],
    history: [{ role: 'user', content: '月亮' }],
    memories: [{ id: 'm1', characterId: '', text: '记忆'.repeat(200), keys: [], importance: 50, sourceSessionId: '', sourceMessageIds: [], createdBy: 'user', createdAt: 0, updatedAt: 0 }],
    assemble: pipelineOf(),
    budgetTokens: 10,
  }));
  assert.equal(blockOf(request.trace.blocks, 'app.character')?.included, true, '角色设定必须保留');
  assert.equal(blockOf(request.trace.blocks, 'app.setup')?.included, true, '本局处境必须保留');
  assert.equal(blockOf(request.trace.blocks, 'app.lore.matched')?.included, false, '非保留块在全局预算不足时被丢');
  assert.match(blockOf(request.trace.blocks, 'app.character')?.reason ?? '', /必须保留/);
  assert.ok(request.trace.usedTokens > request.trace.budgetTokens, '必须保留允许超出全局预算，面板要能解释');
});

test('B21 source：管线路径的块带实体级来源（角色/场景/物品/典籍/记忆/摘要/会话）', () => {
  const memory: Memory = {
    id: 'm1', characterId: '', text: '记得月亮。', keys: [], importance: 50,
    sourceSessionId: '', sourceMessageIds: [], createdBy: 'user', createdAt: 0, updatedAt: 0,
  };
  const summary = { id: 'sum1', text: '摘要内容。', level: 'scene', covers: [] };
  const request = buildChatRequestV2(optionsOf({
    settings: { 'chat.system_prompt': '全局提示。' },
    setup: setupOf({ premise: '雨夜投宿。' }),
    cards: [characterCard(), sceneCard(), itemCard(), loreCard({ content: '月亮的事情。', keys: ['月亮'] })],
    runtime: runtimeOf({
      variables: {},
      items: { a: { instance_id: 'a', item_id: 'i1', holder: 'c1' } },
      current_scene_id: 's1',
    }),
    history: [{ role: 'user', content: '月亮' }],
    memories: [memory],
    summaries: [summary],
    preselectedSummaries: [summary],
    assemble: pipelineOf(),
  }));
  assert.deepEqual(blockOf(request.trace.blocks, 'app.character')?.source, { type: 'character', id: 'c1', label: '林霜' });
  assert.deepEqual(blockOf(request.trace.blocks, 'app.scene')?.source, { type: 'scene', id: 's1', label: '边境酒馆' });
  assert.deepEqual(blockOf(request.trace.blocks, 'app.items')?.source, { type: 'item', id: 'i1', label: '月光剑' });
  assert.deepEqual(blockOf(request.trace.blocks, 'app.lore.matched')?.source, { type: 'lore', id: 'l1', label: '银月战争' });
  assert.deepEqual(blockOf(request.trace.blocks, 'app.memory.matched')?.source, { type: 'memory', id: 'm1' });
  assert.deepEqual(blockOf(request.trace.blocks, 'app.summary.matched')?.source, { type: 'summary', id: 'sum1' });
  assert.deepEqual(blockOf(request.trace.blocks, 'app.system.custom')?.source, { type: 'session', label: '测试会话' });
  assert.deepEqual(blockOf(request.trace.blocks, 'app.setup')?.source, { type: 'session', label: '测试会话' });
});

test('B21 source：兜底路径同样带来源（逐角色块用角色 id）', () => {
  const request = buildChatRequestV2(optionsOf({ cards: [characterCard()] }));
  assert.equal(request.trace.pipeline, false);
  assert.deepEqual(blockOf(request.trace.blocks, 'app.character.c1')?.source, { type: 'character', id: 'c1', label: '林霜' });
});

test('B20/B21 不改变既有语义：不超预算的块原样输出、无截断标记', () => {
  const request = buildChatRequestV2(optionsOf({ cards: [characterCard()], assemble: pipelineOf() }));
  const character = blockOf(request.trace.blocks, 'app.character');
  assert.equal(character?.truncated, undefined);
  assert.equal(character?.tokenBudget, 800);
  assert.ok(request.systemPrompt.includes('你要扮演「林霜」'));
});
