import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatRequestV2, type BuildChatRequestV2Options } from '../src/data/prompt-v2.ts';
import { loreBooksOf } from '../src/data/prompt-lore.ts';
import type { CardMeta, LoreCard, SessionRuntime, SessionSetup } from '../../../packages/cards/src/index.ts';

/** B3–B6：卡片 `LoreTrigger` → 扫描器字段的映射，以及"被抑制"如何进 trace。 */

const meta = (patch: Partial<CardMeta> = {}): CardMeta => ({
  id: 'l1', schema: 'lore/v1', name: '条目', version: '1.0.0',
  language: 'zh-CN', description: '', rating: 'general', ...patch,
});
const loreCard = (patch: Partial<LoreCard> = {}): LoreCard => ({
  card_type: 'lore', meta: meta(), kind: 'other', content: '', keys: [], ...patch,
});
const setupOf = (patch: Partial<SessionSetup> = {}): SessionSetup => ({
  characters: [], premise: '', opening_mode: 'self', origin: 'user', ...patch,
});
const runtimeOf = (patch: Partial<SessionRuntime> = {}): SessionRuntime => ({ variables: {}, items: {}, scene_state: {}, ...patch });
const optionsOf = (patch: Partial<BuildChatRequestV2Options> = {}): BuildChatRequestV2Options => ({
  settings: {}, sessionTitle: '', setup: setupOf(), cards: [], runtime: runtimeOf(), history: [], ...patch,
});

test('loreBooksOf：LoreTrigger 的高级字段全部映射到 ScanEntry', () => {
  const card = loreCard({
    trigger: {
      priority: 10, constant: true, recursive: false, depth: 2,
      selective_logic: 3, exclude_recursion: true, prevent_recursion: true, delay_until_recursion: 4,
      group: '天气', group_weight: 70, sticky: 2, cooldown: 3, delay: 1,
      match_whole_words: true, token_budget: 20,
    },
  });
  const entry = loreBooksOf([card])[0]?.entries[0];
  assert.equal(entry?.order, 90);
  assert.equal(entry?.constant, true);
  assert.equal(entry?.recursive, false);
  assert.equal(entry?.depth, 2);
  assert.equal(entry?.selectiveLogic, 3);
  assert.equal(entry?.excludeRecursion, true);
  assert.equal(entry?.preventRecursion, true);
  assert.equal(entry?.delayUntilRecursion, 4);
  assert.equal(entry?.group, '天气');
  assert.equal(entry?.groupWeight, 70);
  assert.equal(entry?.sticky, 2);
  assert.equal(entry?.cooldown, 3);
  assert.equal(entry?.delay, 1);
  assert.equal(entry?.matchWholeWords, true);
  assert.equal(entry?.tokenBudget, 20);
});

test('group：同组只注入一条，被丢掉的进 trace.loreDropped', () => {
  const request = buildChatRequestV2(optionsOf({
    history: [{ role: 'user', content: '下雨了' }],
    cards: [
      loreCard({ meta: meta({ id: 'g1', name: '甲' }), content: '雨天的甲设定。', keys: ['下雨'], trigger: { group: '天气', group_weight: 1 } }),
      loreCard({ meta: meta({ id: 'g2', name: '乙' }), content: '雨天的乙设定。', keys: ['下雨'], trigger: { group: '天气', group_weight: 1 } }),
    ],
  }));
  assert.equal(request.lore.length, 1, '同组只留一条');
  assert.match(request.systemPrompt, /【相关设定】/);
  assert.ok(request.trace.loreDropped >= 1, 'group 丢掉的条目要计数，不静默');
});

test('delay：总轮次不够时整条不参与，并计入 loreDropped', () => {
  const request = buildChatRequestV2(optionsOf({
    history: [{ role: 'user', content: '铜铃响了' }],
    cards: [loreCard({ content: '铜铃设定。', keys: ['铜铃'], trigger: { delay: 3 } })],
  }));
  assert.deepEqual(request.lore, []);
  assert.equal(request.trace.loreDropped, 1);
});

test('selectiveLogic：AND ALL 需要主键+全部次键，NOT ANY 则相反', () => {
  const andAll = buildChatRequestV2(optionsOf({
    history: [{ role: 'user', content: '甲 乙' }],
    cards: [loreCard({ content: '内容', keys: ['甲'], secondary_keys: ['乙'], trigger: { selective_logic: 3 } })],
  }));
  assert.equal(andAll.lore.length, 1);
  const notAny = buildChatRequestV2(optionsOf({
    history: [{ role: 'user', content: '甲 乙' }],
    cards: [loreCard({ content: '内容', keys: ['甲'], secondary_keys: ['乙'], trigger: { selective_logic: 2 } })],
  }));
  assert.equal(notAny.lore.length, 0);
});
