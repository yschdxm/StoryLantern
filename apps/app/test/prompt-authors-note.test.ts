import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatRequestV2, type BuildChatRequestV2Options } from '../src/data/prompt-v2.ts';
import { SETTING_KEYS, type Memory } from '../src/data/types.ts';
import type { CardMeta, CharacterCard, SessionRuntime, SessionSetup } from '../../../packages/cards/src/index.ts';

/** B18 作者注：独立块 app.authors_note（before-history 81）、可宏展开、空值如实不可见。 */

const meta = (patch: Partial<CardMeta> = {}): CardMeta => ({
  id: 'c1', schema: 'rolecard/v1', name: '林霜', version: '1.0.0',
  language: 'zh-CN', description: '', rating: 'general', ...patch,
});
const characterCard = (patch: Partial<CharacterCard> = {}): CharacterCard => ({
  card_type: 'character', meta: meta(),
  identity: { name: '林霜', background: '' },
  persona: { summary: '', traits: [], knowledge_boundary: '', ability_boundary: '' },
  speech: { style: '' }, ...patch,
});
const setupOf = (patch: Partial<SessionSetup> = {}): SessionSetup => ({
  characters: [], premise: '', opening_mode: 'self', origin: 'user', ...patch,
});
const runtimeOf = (patch: Partial<SessionRuntime> = {}): SessionRuntime => ({ variables: {}, items: {}, scene_state: {}, ...patch });
const optionsOf = (patch: Partial<BuildChatRequestV2Options> = {}): BuildChatRequestV2Options => ({
  settings: {}, sessionTitle: '', setup: setupOf(), cards: [], runtime: runtimeOf(), history: [], ...patch,
});
const memoryOf = (text: string): Memory => ({
  id: 'm1', characterId: '', text, keys: ['触发'], importance: 50,
  sourceSessionId: 's', sourceMessageIds: [], createdBy: 'user', createdAt: 0, updatedAt: 0,
});

test('设置后进 systemPrompt：独立块 kind=authorsNote，位于 memory 82 之后、summary 80 之前', () => {
  const request = buildChatRequestV2(optionsOf({
    settings: { [SETTING_KEYS.authorsNote]: ' 请保持短句。 ' },
    memories: [memoryOf('MEM 内容')],
    summaries: [{ id: 's1', text: 'SUM 内容', level: 'scene', covers: [] }],
    preselectedSummaries: [{ id: 's1', text: 'SUM 内容', level: 'scene', covers: [] }],
    history: [{ role: 'user', content: '触发' }],
    cards: [characterCard()],
  }));
  const at = (needle: string): number => request.systemPrompt.indexOf(needle);
  assert.ok(at('请保持短句。') >= 0);
  assert.ok(at('MEM 内容') < at('请保持短句。'), 'memory(82) 在作者注(81) 之前');
  assert.ok(at('请保持短句。') < at('SUM 内容'), '作者注(81) 在 summary(80) 之前');
  const block = request.trace.blocks.find((item) => item.id === 'app.authors_note');
  assert.equal(block?.kind, 'authorsNote');
  assert.equal(block?.included, true);
  assert.equal(block?.chars, '请保持短句。'.length);
});

test('空/未设：不进 systemPrompt，但 trace 里如实显示 included:false / 未设置', () => {
  for (const settings of [{}, { [SETTING_KEYS.authorsNote]: '   ' }]) {
    const request = buildChatRequestV2(optionsOf({ settings, cards: [characterCard()] }));
    assert.equal(request.systemPrompt.includes('请保持'), false);
    const block = request.trace.blocks.find((item) => item.id === 'app.authors_note');
    assert.ok(block !== undefined, '块仍可见（与 post-history 一致）');
    assert.equal(block.included, false);
    assert.equal(block.chars, 0);
    assert.equal(block.reason, '未设置');
  }
});

test('宏：作者注展开 {{char}}/{{user}}；用户历史不展开、内容也不进 messages', () => {
  const request = buildChatRequestV2(optionsOf({
    settings: { [SETTING_KEYS.authorsNote]: '{{char}} 提醒 {{user}}：保持克制。' },
    setup: setupOf({ user_role: '旅人' }),
    cards: [characterCard()],
    history: [{ role: 'user', content: '我是 {{char}}' }],
  }));
  assert.match(request.systemPrompt, /林霜 提醒 旅人：保持克制。/);
  assert.equal(request.messages[0]?.content, '我是 {{char}}', '用户历史不展开');
  assert.equal(request.messages.some((message) => message.content.includes('保持克制')), false, '作者注不塞进历史');
});
