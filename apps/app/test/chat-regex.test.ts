import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatRequestV2 } from '../src/data/prompt-v2.ts';
import { resolveCitations } from '../src/data/citations.ts';
import {
  regexScriptsOfCards,
  transformAiOutput,
  transformReasoning,
  transformUserInput,
} from '../src/data/chat-regex.ts';
import type { CardMeta, LoreCard, SessionRuntime, SessionSetup } from '../../../packages/cards/src/index.ts';

/**
 * B13：正则脚本接进聊天链路（user_input / ai_output / reasoning / world_info）。
 * 每个 placement 都要证明：只改该改的文本、卡片原文不动、坏脚本跳过不阻断、统计可见。
 */

const meta = (patch: Partial<CardMeta> = {}): CardMeta => ({
  id: 'c1',
  schema: 'lore/v1',
  name: '卡',
  version: '1.0.0',
  language: 'zh-CN',
  description: '',
  rating: 'general',
  ...patch,
});

function cardWithScripts(scripts: unknown[], patch: Partial<LoreCard> = {}): LoreCard {
  return {
    card_type: 'lore',
    meta: meta(),
    kind: 'other',
    content: '',
    keys: [],
    extensions: { storylantern: { regex_scripts: scripts } },
    ...patch,
  };
}

const script = (find: string, replace: string, placement: string, id = find): Record<string, unknown> => ({
  id,
  name: id,
  find,
  replace,
  placement,
});

const setupOf = (patch: Partial<SessionSetup> = {}): SessionSetup => ({
  characters: ['c1'],
  premise: '',
  opening_mode: 'self',
  origin: 'user',
  ...patch,
});
const runtimeOf = (patch: Partial<SessionRuntime> = {}): SessionRuntime => ({ variables: {}, items: {}, scene_state: {}, ...patch });

test('user_input：只转换本次输入，卡片与历史原文不动', () => {
  const card = cardWithScripts([script('甲', '乙', 'user_input')]);
  const result = transformUserInput('甲说了一句', [card], setupOf());
  assert.equal(result.text, '乙说了一句');
  assert.equal(result.applied, 1);
  assert.deepEqual(result.skipped, []);
  assert.equal(card.content, '', '卡片原文不能改');
  assert.equal((card.extensions?.storylantern as { regex_scripts: unknown[] }).regex_scripts.length, 1);
});

test('user_input：坏正则跳过并计数，不阻断发送（文本原样）', () => {
  const card = cardWithScripts([script('[', 'x', 'user_input', 'bad'), script('甲', '乙', 'user_input')]);
  const result = transformUserInput('甲', [card], setupOf());
  assert.equal(result.text, '乙');
  assert.equal(result.applied, 1);
  assert.deepEqual(result.skipped, [{ id: 'bad', reason: 'invalid_pattern' }]);
});

test('ai_output：先跑正则、再 strip 引用，脚本文本里新增的 [2] 也会被清理并解析成引用', () => {
  const card = cardWithScripts([script('好', '好[2]', 'ai_output')]);
  const ai = transformAiOutput('今天真好', [card], setupOf());
  assert.equal(ai.text, '今天真好[2]', '正则先跑');
  const resolved = resolveCitations(ai.text, ['M1', 'M2']);
  assert.equal(resolved.text, '今天真好', 'strip 在正则之后，标记不会留在正文');
  assert.deepEqual(resolved.citations, [{ index: 2, messageId: 'M2', resolved: true }]);
});

test('reasoning：思考链按 reasoning placement 转换（正文脚本不误伤）', () => {
  const card = cardWithScripts([
    script('想', '思', 'reasoning'),
    script('正文', '被改', 'ai_output'),
  ]);
  const result = transformReasoning('我先想一下正文', [card], setupOf());
  assert.equal(result.text, '我先思一下正文', '只执行 reasoning 脚本');
});

test('world_info：注入副本被转换、卡片原文不动、applied/skipped 附着在 trace 数据上', () => {
  const content = '铜铃在夜里会响。';
  const card = cardWithScripts(
    [script('夜里', '深夜', 'world_info', 'ok'), script('[', 'x', 'world_info', 'bad')],
    { content, keys: ['铜铃'] },
  );
  const request = buildChatRequestV2({
    settings: {},
    sessionTitle: '',
    setup: setupOf(),
    cards: [card],
    runtime: runtimeOf(),
    history: [{ role: 'user', content: '铜铃是什么？' }],
  });
  assert.match(request.systemPrompt, /铜铃在深夜会响/, '注入的是转换后的副本');
  assert.equal(card.content, content, '卡片原文不能改');
  const injected = request.lore[0] as
    | (typeof request.lore)[number] & { worldInfoApplied?: number; worldInfoSkipped?: { id: string; reason: string }[] }
    | undefined;
  assert.equal(injected?.worldInfoApplied, 1);
  assert.deepEqual(injected?.worldInfoSkipped, [{ id: 'bad', reason: 'invalid_pattern' }]);
});

test('脚本来源：overrides 关掉的卡不参与；没有脚本的卡不产生统计噪音', () => {
  const card = cardWithScripts([script('甲', '乙', 'user_input')]);
  assert.equal(regexScriptsOfCards([card], setupOf({ overrides: { c1: false } })).length, 0);
  const plain = cardWithScripts([]);
  assert.deepEqual(transformUserInput('甲', [plain], setupOf()), { text: '甲', applied: 0, skipped: [] });
});
