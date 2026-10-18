import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPromptBlockDataV2,
  passesProbability,
  stableHash,
} from '../src/data/prompt-v2.ts';
import {
  registerPromptBlocksV2,
  renderAllSections,
  renderCharacterSection,
  renderCustomSection,
  renderExamplesSection,
  renderItemsSection,
  renderRulesSection,
  renderSceneSection,
  renderSetupSection,
  renderStateSection,
} from '../src/data/prompt-blocks-v2.ts';
import { Registry } from '../../../packages/plugin-api/src/index.ts';
import type { BlockDefinition } from '../../../plugins/context-blocks/src/index.ts';
import type {
  CardDocument,
  CardMeta,
  CharacterCard,
  ItemCard,
  SceneCard,
  SessionRuntime,
  SessionSetup,
} from '../../../packages/cards/src/index.ts';
import type { MessageRole } from '../src/data/types.ts';

/** 每个块单独的渲染规则：空字段不留标题、引用解析不到时降级为 ID、顺序稳定。 */

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

const sceneCard = (patch: Partial<SceneCard> = {}): SceneCard => ({
  card_type: 'scene', meta: meta({ id: 's1', schema: 'scene/v1', name: '边境酒馆' }),
  type: 'physical', description: '', ...patch,
});

const itemCard = (patch: Partial<ItemCard> = {}): ItemCard => ({
  card_type: 'item', meta: meta({ id: 'i1', schema: 'item/v1', name: '月光剑' }),
  type: 'weapon', description: '', function: '', ...patch,
});

const setupOf = (patch: Partial<SessionSetup> = {}): SessionSetup => ({
  characters: [], premise: '', opening_mode: 'auto', origin: 'user', ...patch,
});

const runtimeOf = (patch: Partial<SessionRuntime> = {}): SessionRuntime => ({
  variables: {}, items: {}, scene_state: {}, ...patch,
});

function dataOf(input: {
  cards?: readonly CardDocument[];
  custom?: string;
  setup?: SessionSetup;
  runtime?: SessionRuntime;
  history?: ReadonlyArray<{ role: MessageRole; content: string }>;
} = {}) {
  return createPromptBlockDataV2({
    custom: input.custom ?? '',
    setup: input.setup ?? setupOf(),
    cards: input.cards ?? [],
    runtime: input.runtime ?? runtimeOf(),
    history: input.history ?? [],
  });
}

test('renderCharacterSection：空字段不产生标题，填充字段按顺序出现', () => {
  const bare = renderCharacterSection(characterCard());
  assert.match(bare, /你要扮演「林霜」/);
  for (const title of ['【身份】', '【外观】', '【性格】', '【恐惧】', '【禁忌】', '【认知边界】', '【能力边界】', '【语气】', '【禁词】', '【台词示例】', '【旁白风格】', '【角色补充】', '【扮演规则】', '【风格】']) {
    assert.ok(!bare.includes(title), `空字段不该留标题：${title}`);
  }

  const full = renderCharacterSection(characterCard({
    identity: { name: '林霜', occupation: '剑士', background: '北境出身。' },
    appearance: { summary: '银发，旧疤。' },
    persona: {
      summary: '冷面女剑士', traits: ['冷静', '寡言'], goals: ['复仇'], fears: ['火'], taboos: ['背叛'],
      knowledge_boundary: '不知道王都的事', ability_boundary: '不会魔法',
    },
    speech: {
      style: '短句', tone: '冷淡', vocabulary: ['喂'], forbidden_words: ['加油'],
      example_lines: ['……'], narration_style: '克制',
    },
    prompts: { system_extra: '补充设定', roleplay_rules: ['规则A'], style_guide: '风格X' },
  }));
  for (const text of ['【身份】职业：剑士', '北境出身。', '【外观】银发，旧疤。', '【性格】冷面女剑士；冷静、寡言', '【目标】复仇', '【恐惧】火', '【禁忌】背叛', '【认知边界】不知道王都的事', '【能力边界】不会魔法', '【语气】短句；冷淡；喂', '【禁词】加油', '【台词示例】\n- ……', '【旁白风格】克制', '【角色补充】补充设定', '【扮演规则】\n- 规则A', '【风格】风格X']) {
    assert.ok(full.includes(text), `缺少：${text}`);
  }
  const positions = ['【身份】', '【外观】', '【性格】', '【目标】', '【角色补充】'].map((title) => full.indexOf(title));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, '字段顺序必须稳定');
});

test('renderSceneSection：名称/氛围固定顺序/可去/在场；未解析引用降级为 ID', () => {
  const data = dataOf({
    cards: [
      characterCard(),
      characterCard({ meta: meta({ id: 'c2', name: '老王' }), identity: { name: '老王', background: '' } }),
      sceneCard({
        appearance: { summary: '雨夜的酒馆。' },
        atmosphere: { mood: '压抑', light: '昏暗', crowd: '拥挤', sound: '雨声', smell: '酒味', temperature: '阴冷' },
        connections: [{ target: 's2' }, { target: 'missing' }],
        occupants: [
          { target: 'c1', presence: 'resident' },
          { target: 'c2', presence: 'frequent' },
          { target: 'ghost', presence: 'rare' },
        ],
      }),
      sceneCard({ meta: meta({ id: 's2', schema: 'scene/v1', name: '北门' }), type: 'physical', description: '' }),
    ],
    runtime: runtimeOf({ current_scene_id: 's1' }),
  });
  const text = renderSceneSection(data) ?? '';
  assert.match(text, /^【当前场景】边境酒馆/);
  assert.match(text, /雨夜的酒馆。/);
  assert.match(text, /光：昏暗；声：雨声；气味：酒味；温度：阴冷；人群：拥挤；气氛：压抑/);
  assert.match(text, /【可去】北门、missing/);
  assert.match(text, /【在场】林霜（常驻）、老王（常来）、ghost（罕见）/);
  const briefOnly = renderSceneSection(dataOf({
    cards: [sceneCard({ brief: '只有 brief 的场景。' })],
    runtime: runtimeOf({ current_scene_id: 's1' }),
  }));
  assert.match(briefOnly ?? '', /只有 brief 的场景。/);
});

test('renderSceneSection：没有当前场景 / 场景解析不到时整块不出', () => {
  assert.equal(renderSceneSection(dataOf()), undefined);
  assert.equal(renderSceneSection(dataOf({ runtime: runtimeOf({ current_scene_id: 'missing' }) })), undefined);
});

test('renderStateSection：可见性、prompt_render 模板、会话级变量；没有变量时整块不出', () => {
  const character = characterCard({
    state: {
      schema: {
        affection: { type: 'integer', default: 0, visible_to_user: true },
        secret: { type: 'string', default: '', visible_to_user: false },
        mood: { type: 'string', default: '冷淡', prompt_render: '{{name}}={{value}}' },
      },
      update_policy: { allow_llm_patch: true, require_engine_validation: true },
    },
  });
  const text = renderStateSection(dataOf({
    cards: [character],
    runtime: runtimeOf({ variables: { 'character:c1': { affection: 42, secret: '隐藏值', mood: '冷淡' }, session: { tension: 3 } } }),
  }));
  assert.match(text ?? '', /【当前状态】/);
  assert.match(text ?? '', /- 林霜\.affection: 42/);
  assert.match(text ?? '', /- mood=冷淡/);
  assert.match(text ?? '', /- 本局\.tension: 3/);
  assert.ok(!(text ?? '').includes('隐藏值'));
  assert.equal(renderStateSection(dataOf({ cards: [character] })), undefined);
});

test('renderItemsSection：只输出成员持有的实例，condition 有值项出现，缺失定义降级为 ID', () => {
  const text = renderItemsSection(dataOf({
    cards: [characterCard(), itemCard()],
    runtime: runtimeOf({
      items: {
        a: { instance_id: 'a', item_id: 'i1', holder: 'c1', condition: { durability: 80, note: '' } },
        b: { instance_id: 'b', item_id: 'i2', holder: 'c1' },
        c: { instance_id: 'c', item_id: 'i1', holder: 'npc' },
      },
    }),
  }));
  assert.match(text ?? '', /【持有物品】/);
  assert.match(text ?? '', /- 月光剑（durability：80）/);
  assert.match(text ?? '', /- i2/, '物品定义缺失时输出 ID，不抛异常');
  assert.ok(!(text ?? '').includes('- 月光剑（\n'), '非成员持有不应出现');
  assert.equal(renderItemsSection(dataOf({ cards: [characterCard()] })), undefined);
});

test('renderSetupSection：只输出非空项，tone 用中文映射', () => {
  assert.equal(renderSetupSection(dataOf()), undefined);
  const text = renderSetupSection(dataOf({ setup: setupOf({ premise: '雨夜投宿。', user_role: '旅人', setting: '低魔边境', tone: 'dark' }) }));
  assert.equal(text, '【本局处境】雨夜投宿。\n【你的身份】旅人\n【世界基调】低魔边境\n【基调】黑暗');
  const partial = renderSetupSection(dataOf({ setup: setupOf({ premise: '雨夜投宿。', tone: 'mystery' }) }));
  assert.match(partial ?? '', /【基调】悬疑/);
  assert.ok(!(partial ?? '').includes('【你的身份】'));
});

test('renderRulesSection：无条件规则注入、带 conditions 的跳过并计数、按 priority 降序', () => {
  const character = characterCard({
    rules: [
      { id: 'low', enabled: true, priority: 1, when: { event: 'before_prompt' }, actions: [{ type: 'inject_prompt', text: '低优先。' }] },
      { id: 'high', enabled: true, priority: 10, when: { event: 'before_prompt' }, actions: [{ type: 'constraint', text: '高优先。' }] },
      { id: 'cond', enabled: true, priority: 99, when: { event: 'before_prompt', conditions: ['affection > 50'] }, actions: [{ type: 'constraint', text: '条件规则' }] },
    ],
  });
  const data = dataOf({ cards: [character] });
  const text = renderRulesSection(data) ?? '';
  assert.ok(text.indexOf('高优先。') < text.indexOf('低优先。'), 'priority 高的在前');
  assert.ok(!text.includes('条件规则'));
  assert.equal(data.outcomes.rulesOmitted, 1);
});

test('renderExamplesSection：第一轮优先 cold_start，其它情况取前 2 组；role 原样输出', () => {
  const character = characterCard({
    examples: [
      { id: 'e1', tags: ['daily'], messages: [{ role: 'user', content: '普通开场' }] },
      { id: 'e2', tags: ['cold_start'], messages: [{ role: 'narrator', content: '初次见面' }] },
      { id: 'e3', tags: ['other'], messages: [{ role: 'assistant', content: '第三组' }] },
    ],
  });
  const first = renderExamplesSection(dataOf({ cards: [character] })) ?? '';
  assert.match(first, /^【对话示例】/);
  assert.match(first, /narrator: 初次见面/);
  assert.ok(!first.includes('普通开场'));

  const later = renderExamplesSection(dataOf({ cards: [character], history: [{ role: 'user', content: '你好' }] })) ?? '';
  assert.match(later, /user: 普通开场/);
  assert.match(later, /narrator: 初次见面/);
  assert.ok(!later.includes('第三组'), '非第一轮只取前 2 组');
});

test('renderAllSections：兜底顺序按 placement/priority，成员角色逐块', () => {
  const data = dataOf({
    cards: [
      sceneCard(),
      itemCard(),
      characterCard({ examples: [{ id: 'e1', messages: [{ role: 'user', content: '你好。' }] }] }),
    ],
    runtime: runtimeOf({
      variables: { 'character:c1': { affection: 1 } },
      items: { a: { instance_id: 'a', item_id: 'i1', holder: 'c1' } },
      current_scene_id: 's1',
    }),
    history: [{ role: 'user', content: '你好' }],
  });
  data.retrieval.memory = '【长期记忆】';
  data.retrieval.summary = '【相关摘要】';
  data.retrieval.lore = '【相关设定】';
  assert.deepEqual(renderAllSections(data).map((section) => section.id), [
    'app.character.c1',
    'app.state',
    'app.scene',
    'app.items',
    'app.examples',
    'app.memory.matched',
    'app.summary.matched',
    'app.lore.matched',
  ]);
  assert.equal(renderCustomSection(data), undefined);
  assert.equal(renderCustomSection(dataOf({ custom: '  自定义。  ' })), '自定义。');
});

test('registerPromptBlocksV2：块 id / placement / priority 与装配表一致', () => {
  const registry = new Registry<BlockDefinition>({ onDuplicate: 'throw' });
  const off = registerPromptBlocksV2(registry);
  assert.deepEqual(
    registry.list().map((entry) => [entry.id, entry.value.placement, entry.value.priority]),
    [
      ['app.system.custom', 'system', 100],
      ['app.setup', 'system', 99],
      ['app.rules', 'system', 98],
      ['app.character', 'system', 95],
      ['app.state', 'system', 90],
      ['app.scene', 'system', 88],
      ['app.items', 'system', 86],
      ['app.examples', 'system', 84],
      ['app.lore.pos0', 'system', 96],
      ['app.lore.pos1', 'system', 94],
      ['app.lore.pos2', 'system', 89],
      ['app.lore.pos3', 'system', 87],
      ['app.lore.pos5', 'system', 85],
      ['app.lore.pos6', 'system', 83],
      ['app.memory.matched', 'before-history', 82],
      ['app.authors_note', 'before-history', 81],
      ['app.summary.matched', 'before-history', 80],
      ['app.lore.matched', 'before-history', 78],
    ],
  );
  off();
  assert.equal(registry.size, 0, '反注册函数要把块都摘掉');
});

test('概率判定是确定性的（同一输入同结果，禁止随机）', () => {
  assert.equal(stableHash('l1|c1:月亮'), stableHash('l1|c1:月亮'));
  assert.equal(passesProbability('l1', undefined, 'seed'), true);
  assert.equal(passesProbability('l1', 100, 'seed'), true);
  assert.equal(passesProbability('l1', 0, 'seed'), false);
  const outcomes = new Set([1, 2, 3, 4, 5].map(() => passesProbability('l1', 50, 'seed')));
  assert.equal(outcomes.size, 1, '同一输入必须每次同结果');
});
