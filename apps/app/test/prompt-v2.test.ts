import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChatRequestV2,
  type BuildChatRequestV2Options,
} from '../src/data/prompt-v2.ts';
import { estimateTokens } from '../src/data/tokens.ts';
import { registerPromptBlocksV2 } from '../src/data/prompt-blocks-v2.ts';
import { assembleBlocks } from '../../../plugins/writing-pipeline/src/index.ts';
import { Registry } from '../../../packages/plugin-api/src/index.ts';
import type { BlockDefinition } from '../../../plugins/context-blocks/src/index.ts';
import { SETTING_KEYS } from '../src/data/types.ts';
import type {
  CardMeta,
  CharacterCard,
  ItemCard,
  LoreCard,
  SceneCard,
  SessionRuntime,
  SessionSetup,
} from '../../../packages/cards/src/index.ts';

/**
 * 新卡片模型的提示词装配：测的是**取舍与顺序**——哪些内容进上下文、按什么顺序、
 * 被裁掉时 trace 能不能说清（块 id / kind / included / 理由 / 计数）。
 */

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

const loreCard = (patch: Partial<LoreCard> = {}): LoreCard => ({
  card_type: 'lore', meta: meta({ id: 'l1', schema: 'lore/v1', name: '银月战争' }),
  kind: 'history', content: '', keys: [], ...patch,
});

const setupOf = (patch: Partial<SessionSetup> = {}): SessionSetup => ({
  characters: [], premise: '', opening_mode: 'auto', origin: 'user', ...patch,
});

const runtimeOf = (patch: Partial<SessionRuntime> = {}): SessionRuntime => ({
  variables: {}, items: {}, scene_state: {}, ...patch,
});

const optionsOf = (patch: Partial<BuildChatRequestV2Options> = {}): BuildChatRequestV2Options => ({
  settings: {}, sessionTitle: '测试会话', setup: setupOf(), cards: [], runtime: runtimeOf(), history: [], ...patch,
});

/** 用真实的块注册表 + 管线纯函数搭一条最小装配管线。 */
const pipelineOf = () => {
  const registry = new Registry<BlockDefinition>({ onDuplicate: 'replace' });
  registerPromptBlocksV2(registry);
  const blocks = registry.list().map((entry) => entry.value);
  return (context: Parameters<typeof assembleBlocks>[1], budget?: number) =>
    assembleBlocks(blocks, context, budget ?? 2048);
};

test('最小输入：一个角色 + 空 setup，系统提示里有「你要扮演」与角色名', () => {
  const request = buildChatRequestV2(optionsOf({ cards: [characterCard()] }));
  assert.match(request.systemPrompt, /你要扮演「林霜」/);
  assert.equal(request.trace.pipeline, false, '没注入 assemble 时应如实标记为兜底路径');
});

test('顺序：custom → setup → character → state/scene/items', () => {
  const character = characterCard({
    state: {
      schema: { affection: { type: 'integer', default: 0 } },
      update_policy: { allow_llm_patch: true, require_engine_validation: true },
    },
  });
  const request = buildChatRequestV2(optionsOf({
    settings: { [SETTING_KEYS.systemPrompt]: '全局自定义提示。' },
    setup: setupOf({ premise: '雨夜投宿。' }),
    cards: [character, sceneCard({ appearance: { summary: '昏暗。' } }), itemCard()],
    runtime: runtimeOf({
      variables: { 'character:c1': { affection: 5 } },
      items: { a: { instance_id: 'a', item_id: 'i1', holder: 'c1' } },
      current_scene_id: 's1',
    }),
  }));
  const prompt = request.systemPrompt;
  const at = (needle: string): number => prompt.indexOf(needle);
  assert.ok(at('全局自定义提示。') >= 0);
  assert.ok(at('全局自定义提示。') < at('【本局处境】'));
  assert.ok(at('【本局处境】') < at('你要扮演'));
  assert.ok(at('你要扮演') < at('【当前状态】'));
  assert.ok(at('你要扮演') < at('【当前场景】'));
  assert.ok(at('你要扮演') < at('【持有物品】'));
});

test('state：可见变量渲染、visible_to_user=false 不出现、prompt_render 模板生效', () => {
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
  const request = buildChatRequestV2(optionsOf({
    cards: [character],
    runtime: runtimeOf({
      variables: { 'character:c1': { affection: 42, secret: '隐藏值', mood: '冷淡' }, session: { tension: 3 } },
    }),
  }));
  assert.match(request.systemPrompt, /【当前状态】/);
  assert.match(request.systemPrompt, /- 林霜\.affection: 42/);
  assert.ok(!request.systemPrompt.includes('隐藏值'), 'visible_to_user=false 的变量不该进提示词');
  assert.match(request.systemPrompt, /- mood=冷淡/, 'prompt_render 应替换 {{name}}/{{value}}');
  assert.match(request.systemPrompt, /- 本局\.tension: 3/, '会话级变量也要渲染');
});

test('scene：名称/氛围/可去/在场都出现，presence 中文标注正确，未解析引用降级为 ID', () => {
  const cards = [
    characterCard(),
    characterCard({ meta: meta({ id: 'c2', name: '老王' }), identity: { name: '老王', background: '' } }),
    sceneCard({
      appearance: { summary: '雨夜昏暗的酒馆。' },
      atmosphere: { light: '昏暗', sound: '雨声', smell: '酒味', temperature: '阴冷', crowd: '拥挤', mood: '压抑' },
      connections: [{ target: 's2' }, { target: 'missing' }],
      occupants: [
        { target: 'c1', presence: 'resident' },
        { target: 'c2', presence: 'frequent' },
        { target: 'ghost', presence: 'rare' },
      ],
    }),
    sceneCard({ meta: meta({ id: 's2', schema: 'scene/v1', name: '北门' }), type: 'physical', description: '' }),
  ];
  const request = buildChatRequestV2(optionsOf({ cards, runtime: runtimeOf({ current_scene_id: 's1' }) }));
  assert.match(request.systemPrompt, /【当前场景】边境酒馆/);
  assert.match(request.systemPrompt, /雨夜昏暗的酒馆。/);
  assert.match(request.systemPrompt, /光：昏暗；声：雨声；气味：酒味；温度：阴冷；人群：拥挤；气氛：压抑/);
  assert.match(request.systemPrompt, /【可去】北门、missing/);
  assert.match(request.systemPrompt, /【在场】林霜（常驻）、老王（常来）、ghost（罕见）/);
});

test('items：只输出成员持有的实例，condition 有值的项出现', () => {
  const request = buildChatRequestV2(optionsOf({
    cards: [characterCard(), itemCard(), itemCard({ meta: meta({ id: 'i2', schema: 'item/v1', name: '别人的剑' }) })],
    runtime: runtimeOf({
      items: {
        a: { instance_id: 'a', item_id: 'i1', holder: 'c1', condition: { durability: 80, note: '' } },
        b: { instance_id: 'b', item_id: 'i2', holder: 'npc' },
      },
    }),
  }));
  assert.match(request.systemPrompt, /【持有物品】/);
  assert.match(request.systemPrompt, /- 月光剑（durability：80）/);
  assert.ok(!request.systemPrompt.includes('别人的剑'), '非成员持有的物品不该出现');
  assert.ok(!request.systemPrompt.includes('note'), 'condition 的空值项不输出');
});

test('examples：第一轮优先 cold_start，历史非空时取前 2 组', () => {
  const character = characterCard({
    examples: [
      { id: 'e1', tags: ['daily'], messages: [{ role: 'user', content: '普通开场' }] },
      { id: 'e2', tags: ['cold_start'], messages: [{ role: 'user', content: '初次见面' }, { role: 'assistant', content: '我等你很久了。' }] },
    ],
  });
  const first = buildChatRequestV2(optionsOf({ cards: [character] }));
  assert.match(first.systemPrompt, /【对话示例】/);
  assert.match(first.systemPrompt, /user: 初次见面/);
  assert.match(first.systemPrompt, /assistant: 我等你很久了。/);
  assert.ok(!first.systemPrompt.includes('普通开场'), '冷启动那组优先时应只取它');

  const later = buildChatRequestV2(optionsOf({
    cards: [character],
    history: [{ role: 'user', content: '你好' }],
  }));
  assert.match(later.systemPrompt, /普通开场/);
  assert.match(later.systemPrompt, /初次见面/, '非第一轮取前 2 组');
});

test('lore：关键词命中注入、probability:0 永不注入且计数、constant 始终注入', () => {
  const cards = [
    loreCard({ content: '铜铃是隘口的报信之物。', keys: ['铜铃'] }),
    loreCard({ meta: meta({ id: 'l2', schema: 'lore/v1', name: '概率条目' }), content: '永远不会出现。', keys: ['铜铃'], trigger: { probability: 0 } }),
    loreCard({ meta: meta({ id: 'l3', schema: 'lore/v1', name: '常量条目' }), content: '这个世界有两轮月亮。', keys: [], trigger: { constant: true } }),
  ];
  const request = buildChatRequestV2(optionsOf({
    cards,
    history: [{ role: 'user', content: '我听见了铜铃' }],
  }));
  assert.match(request.systemPrompt, /【相关设定】/);
  assert.match(request.systemPrompt, /铜铃是隘口的报信之物。/);
  assert.match(request.systemPrompt, /这个世界有两轮月亮。/);
  assert.ok(!request.systemPrompt.includes('永远不会出现。'), 'probability:0 的条目必须被拦下');
  assert.equal(request.trace.loreDropped, 1);
  assert.deepEqual(request.trace.lore.map((entry) => entry.entryId).sort(), ['l1', 'l3']);
});

test('rules：无条件的 constraint 注入，带 conditions 的跳过并计数', () => {
  const character = characterCard({
    rules: [
      { id: 'r1', enabled: true, priority: 10, when: { event: 'before_prompt' }, actions: [{ type: 'constraint', text: '不要替用户说话。' }] },
      { id: 'r2', enabled: true, priority: 5, when: { event: 'before_prompt', conditions: ['affection > 50'] }, actions: [{ type: 'constraint', text: '条件规则' }] },
      { id: 'r3', enabled: false, priority: 9, when: { event: 'before_prompt' }, actions: [{ type: 'constraint', text: '停用的规则' }] },
      { id: 'r4', enabled: true, priority: 20, when: { event: 'before_reply' }, actions: [{ type: 'constraint', text: '回复后规则' }] },
    ],
  });
  const request = buildChatRequestV2(optionsOf({ cards: [character] }));
  assert.match(request.systemPrompt, /不要替用户说话。/);
  assert.ok(!request.systemPrompt.includes('条件规则'));
  assert.ok(!request.systemPrompt.includes('停用的规则'));
  assert.ok(!request.systemPrompt.includes('回复后规则'));
  assert.equal(request.trace.rulesOmitted, 1);
});

test('预算裁剪：60 token 时 lore/summary 先被裁，character 保留', () => {
  const character = characterCard({ identity: { name: '林霜', background: '北境出身，十二岁入伍。' } });
  const summary = { id: 'sum1', text: '月亮'.repeat(40), level: 'turn', covers: [] };
  const request = buildChatRequestV2(optionsOf({
    cards: [character, loreCard({ content: '月亮'.repeat(40), keys: ['月亮'] })],
    history: [{ role: 'user', content: '月亮' }],
    summaries: [summary],
    preselectedSummaries: [summary],
    assemble: pipelineOf(),
    budgetTokens: 60,
  }));
  assert.equal(request.trace.pipeline, true);
  assert.ok(estimateTokens(`你要扮演「林霜」。\n【身份】职业：；背景：北境出身，十二岁入伍。`) < 60);
  const blockOf = (id: string) => request.trace.blocks.find((block) => block.id === id);
  assert.equal(blockOf('app.character')?.included, true, 'character 优先级高，应保留');
  assert.equal(blockOf('app.summary.matched')?.included, false, 'summary 优先级低，先被裁');
  assert.equal(blockOf('app.lore.matched')?.included, false, 'lore 优先级最低，先被裁');
  assert.ok(request.trace.omitted >= 2);
  assert.ok(!request.systemPrompt.includes('月亮'), '被裁的块不该出现在系统提示里');
});

test('cite:true 编号并追加引用说明；cite:false 不编号', () => {
  const history = [
    { role: 'user' as const, content: '第一句' },
    { role: 'assistant' as const, content: '第二句' },
  ];
  const cited = buildChatRequestV2(optionsOf({ cite: true, history }));
  assert.deepEqual(cited.messages.map((message) => message.content), ['[1] 第一句', '[2] 第二句']);
  assert.match(cited.systemPrompt, /编号/);
  assert.ok(cited.trace.blocks.some((block) => block.id === 'citation.instruction'));

  const plain = buildChatRequestV2(optionsOf({ history }));
  assert.deepEqual(plain.messages.map((message) => message.content), ['第一句', '第二句']);
  assert.ok(!plain.systemPrompt.includes('编号'));
});

test('确定性：打乱 cards 数组顺序，输出完全一致（兜底与管线两条路径）', () => {
  const cards = [
    characterCard(),
    sceneCard({ appearance: { summary: '昏暗。' }, occupants: [{ target: 'c1', presence: 'resident' }] }),
    itemCard(),
    loreCard({ content: '月亮的事情。', keys: ['月亮'] }),
  ];
  const build = (ordered: typeof cards, assemble?: BuildChatRequestV2Options['assemble']) =>
    buildChatRequestV2(optionsOf({
      cards: ordered,
      runtime: runtimeOf({ current_scene_id: 's1', items: { a: { instance_id: 'a', item_id: 'i1', holder: 'c1' } } }),
      history: [{ role: 'user', content: '月亮' }],
      ...(assemble === undefined ? {} : { assemble, budgetTokens: 4000 }),
    }));
  for (const assemble of [undefined, pipelineOf()]) {
    const first = build(cards, assemble);
    const second = build([...cards].reverse(), assemble);
    assert.equal(first.systemPrompt, second.systemPrompt);
    assert.deepEqual(first.messages, second.messages);
    assert.deepEqual(first.trace.blocks, second.trace.blocks);
    assert.deepEqual(first.trace.lore, second.trace.lore);
  }
});

test('没有 assemble 时走兜底拼接：trace.pipeline === false，块按固定顺序出现', () => {
  const request = buildChatRequestV2(optionsOf({
    settings: { [SETTING_KEYS.systemPrompt]: '自定义。' },
    cards: [characterCard()],
  }));
  assert.equal(request.trace.pipeline, false);
  assert.deepEqual(request.trace.blocks.map((block) => block.kind), ['custom', 'character', 'postHistory']);
  assert.deepEqual(request.trace.blocks.map((block) => block.id), ['app.system.custom', 'app.character.c1', 'app.post_history']);
  assert.ok(request.systemPrompt.startsWith('自定义。'));
});

// ---------------------------------------------------------------- post-history / 引用窗口

test('post-history：按成员顺序拼接、空串不出现、不进 systemPrompt', () => {
  const withShort = characterCard({ prompts: { post_history_instructions: ' 保持短句。 ' } });
  const withAction = characterCard({
    meta: meta({ id: 'c2', name: '老王' }),
    identity: { name: '老王', background: '' },
    prompts: { post_history_instructions: '不要替用户行动。' },
  });
  const silent = characterCard({ meta: meta({ id: 'c3', name: '无声' }), identity: { name: '无声', background: '' } });
  const request = buildChatRequestV2(optionsOf({
    setup: setupOf({ characters: ['c2', 'c1', 'c3'] }),
    cards: [withShort, withAction, silent], // 数组顺序故意打乱：以 setup.characters 为准
  }));
  assert.equal(request.postHistory, '不要替用户行动。\n保持短句。');
  assert.ok(!request.systemPrompt.includes('不要替用户行动。'), 'post-history 不进 systemPrompt');
  const block = request.trace.blocks.find((entry) => entry.id === 'app.post_history');
  assert.equal(block?.kind, 'postHistory');
  assert.equal(block?.included, true);
  assert.equal(block?.chars, request.postHistory?.length);
  assert.equal(block?.estimatedTokens, estimateTokens('不要替用户行动。\n保持短句。'));
  const withoutInstructions = buildChatRequestV2(optionsOf({
    setup: setupOf({ characters: ['c2', 'c1', 'c3'] }),
    cards: [
      characterCard(),
      characterCard({ meta: meta({ id: 'c2', name: '老王' }), identity: { name: '老王', background: '' } }),
      silent,
    ],
  }));
  assert.equal(request.trace.usedTokens, withoutInstructions.trace.usedTokens, 'post-history 不占系统提示预算');
  assert.equal(request.trace.systemChars, withoutInstructions.trace.systemChars, 'post-history 不进 systemPrompt');

  const empty = buildChatRequestV2(optionsOf({ cards: [silent] }));
  assert.equal(empty.postHistory, undefined);
  assert.equal(empty.trace.blocks.find((entry) => entry.id === 'app.post_history')?.included, false, '没有指令时块仍在，但如实标 false');
});

test('citationWindow：与 messages 一一对应；有 id 用 id、无 id 为 undefined', () => {
  const request = buildChatRequestV2(optionsOf({
    cite: true,
    history: [
      { role: 'user', content: '甲', id: 'M1' },
      { role: 'assistant', content: '乙' },
      { role: 'system', content: '丙', id: 'M3' },
    ],
  }));
  assert.deepEqual(request.citationWindow, ['M1', undefined, 'M3']);
  assert.deepEqual(request.messages.map((message) => message.content), ['[1] 甲', '[2] 乙', '[3] 丙']);
});

test('已有 [3] 的历史在发给模型前被 strip；扫描仍用未 strip 的原文', () => {
  const request = buildChatRequestV2(optionsOf({
    cite: true,
    history: [
      { role: 'assistant', content: '[3] 我记得那件事。', id: 'M1' },
      { role: 'user', content: '继续', id: 'M2' },
    ],
    cards: [loreCard({ content: '标记也能触发。', keys: ['[3]'] })],
  }));
  assert.deepEqual(request.messages.map((message) => message.content), ['[1] 我记得那件事。', '[2] 继续']);
  assert.deepEqual(request.lore.map((entry) => entry.entryId), ['l1'], '关键词扫描用的是未 strip 的历史原文');

  const plain = buildChatRequestV2(optionsOf({ history: [{ role: 'assistant', content: '[3] 原文', id: 'M1' }] }));
  assert.equal(plain.messages[0]?.content, '[3] 原文', '不编号时不改写内容');
});

test('典籍单条预算（token_budget）当前未实现：不假装截断（全局预算仍生效）', () => {
  const content = '长'.repeat(50);
  const request = buildChatRequestV2(optionsOf({
    history: [{ role: 'user', content: '长' }],
    cards: [loreCard({ content, keys: ['长'], trigger: { token_budget: 1 } })],
  }));
  assert.ok(request.systemPrompt.includes(content), '扫描器没有单条预算字段，不能假装按 1 截断');
});
