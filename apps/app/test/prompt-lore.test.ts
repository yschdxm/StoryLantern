import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatRequestV2, type BuildChatRequestV2Options } from '../src/data/prompt-v2.ts';
import { loreBooksOf } from '../src/data/prompt-lore.ts';
import type {
  CharacterCard,
  ItemCard,
  SceneCard,
  CardMeta,
  LoreCard,
  SessionRuntime,
  SessionSetup,
} from '../../../packages/cards/src/index.ts';

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
const characterCard = (patch: Partial<CharacterCard> = {}): CharacterCard => ({
  card_type: 'character', meta: meta({ id: 'c1', schema: 'rolecard/v1', name: '林霜' }),
  identity: { name: '林霜', background: '背景' },
  persona: { summary: '冷静', traits: [], knowledge_boundary: '', ability_boundary: '' },
  speech: { style: '' },
  examples: [{ id: 'ex1', messages: [{ role: 'assistant', content: '例子台词' }] }],
  state: {
    schema: { affection: { type: 'integer', default: 0, visible_to_user: true } },
    update_policy: { allow_llm_patch: true, require_engine_validation: true },
  },
  ...patch,
});
const sceneCard = (patch: Partial<SceneCard> = {}): SceneCard => ({
  card_type: 'scene', meta: meta({ id: 's1', schema: 'scene/v1', name: '边境酒馆' }), type: 'physical', description: '昏暗。', ...patch,
});
const itemCard = (patch: Partial<ItemCard> = {}): ItemCard => ({
  card_type: 'item', meta: meta({ id: 'i1', schema: 'item/v1', name: '月光剑' }), type: 'weapon', description: '一枚旧剑。', function: '防身', ...patch,
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

// ---------------------------------------------------------------- B2 / B9 / B19

test('position 0–6：按自有优先级落进 systemPrompt；未设 position 仍走旧块（不回归）', () => {
  const cards = [
    characterCard(), sceneCard(), itemCard(),
    ...([0, 1, 2, 3, 5, 6] as const).map((position) =>
      loreCard({ meta: meta({ id: `lp${position}`, name: `位置${position}` }), content: `POS${position}`, keys: ['触发'], trigger: { position } })),
    loreCard({ meta: meta({ id: 'legacy', name: '旧块' }), content: 'LEGACY', keys: ['触发'] }),
  ];
  const request = buildChatRequestV2(optionsOf({
    cards,
    setup: setupOf({ characters: ['c1'] }),
    runtime: runtimeOf({
      variables: { 'character:c1': { affection: 5 } },
      items: { a: { instance_id: 'a', item_id: 'i1', holder: 'c1' } },
      current_scene_id: 's1',
    }),
    history: [{ role: 'user', content: '触发' }],
  }));
  const at = (needle: string): number => request.systemPrompt.indexOf(needle);
  assert.ok(at('POS0') >= 0 && at('POS0') < at('你要扮演'), '0 = 角色前');
  assert.ok(at('你要扮演') < at('POS1') && at('POS1') < at('【当前状态】'), '1 = 角色后');
  assert.ok(at('【当前状态】') < at('POS2') && at('POS2') < at('【当前场景】'), '2 = 场景前');
  assert.ok(at('【当前场景】') < at('POS3') && at('POS3') < at('【持有物品】'), '3 = 场景后');
  assert.ok(at('【持有物品】') < at('POS5') && at('POS5') < at('【对话示例】'), '5 = 示例前');
  assert.ok(at('【对话示例】') < at('POS6') && at('POS6') < at('LEGACY'), '6 = 示例后；未设 = 旧块');
  assert.equal(request.trace.lorePositionCounts[0], 1);
  assert.equal(request.trace.lorePositionCounts[1], 1);
  assert.equal(request.trace.lorePositionCounts[4], 0);
  assert.equal(request.trace.lorePositionCounts[8], 1, '未设 position 计入索引 8');
});

test('position=4 @depth：作为 system 消息插入，引用窗口同步补 undefined', () => {
  const make = (depth: number) => buildChatRequestV2(optionsOf({
    cite: true,
    history: [
      { role: 'user', content: '一', id: 'h1' },
      { role: 'user', content: '二', id: 'h2' },
      { role: 'user', content: '三', id: 'h3' },
    ],
    cards: [loreCard({ content: 'DEPTH', keys: ['三'], trigger: { position: 4, depth } })],
  }));
  const depth1 = make(1);
  assert.deepEqual(depth1.messages.map((message) => message.content), ['[1] 一', '[2] 二', 'DEPTH', '[3] 三']);
  assert.deepEqual(depth1.messages.map((message) => message.role), ['user', 'user', 'system', 'user']);
  assert.deepEqual(depth1.citationWindow, ['h1', 'h2', undefined, 'h3'], '插入后窗口仍与 messages 1:1');
  assert.equal(make(0).messages[3]?.content, 'DEPTH', 'depth<=0 = 最后');
  assert.equal(make(4).messages[0]?.content, 'DEPTH', 'depth 超过历史长度 = 最前');
});

test('position=7 outlet：不注入但计数+名字进 trace（无宿主消费者，不静默）', () => {
  const request = buildChatRequestV2(optionsOf({
    history: [{ role: 'user', content: '触发' }],
    cards: [
      loreCard({ meta: meta({ id: 'out', name: '出口' }), content: 'OUTLET-BODY', keys: ['触发'], trigger: { position: 7, outlet: 'weather' } }),
      loreCard({ meta: meta({ id: 'p0', name: '前' }), content: 'POS0-BODY', keys: ['触发'], trigger: { position: 0 } }),
    ],
  }));
  assert.equal(request.systemPrompt.includes('OUTLET-BODY'), false);
  assert.equal(request.messages.some((message) => message.content.includes('OUTLET-BODY')), false);
  assert.deepEqual(request.trace.loreOutletsIgnored, ['weather']);
  assert.equal(request.trace.loreOutletDropped, 1);
  assert.equal(request.trace.loreDropped, 1);
  assert.equal(request.trace.lorePositionCounts[0], 1);
  assert.equal(request.trace.lorePositionCounts[7], 0);
});

test('B9 角色名键：成员名进扫描文本，历史没提也能触发', () => {
  const request = buildChatRequestV2(optionsOf({
    setup: setupOf({ characters: ['c1'] }),
    cards: [
      characterCard({ identity: { name: '星野', background: '背景' } }),
      loreCard({ meta: meta({ id: 'name-lore', name: '名' }), content: '星野的设定。', keys: ['星野'] }),
    ],
    history: [{ role: 'user', content: '你好' }],
  }));
  assert.deepEqual(request.lore.map((entry) => entry.entryId), ['name-lore']);
});
