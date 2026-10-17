import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectBrief, type BriefContext, type BriefField, type BriefFieldKey } from '../src/brief.ts';
import type { CardMeta } from '../src/types-base.ts';
import type { CharacterCard, CharacterIdentity, Persona, Speech, StateSchema } from '../src/types-character.ts';
import type { ItemCard, LoreCard, SceneCard } from '../src/types-world.ts';

/**
 * brief 的规则：精简、覆盖优先、确定性、不生成中文文案。
 * 测试断言「字段顺序 + 具体值」，因为投影是模型看到的唯一入口，顺序和内容都是语义。
 */

type CardDocument = CharacterCard | SceneCard | ItemCard | LoreCard;

const meta = (patch: Partial<CardMeta> = {}): CardMeta => ({
  id: 'c1', schema: 'rolecard/v1', name: '林霜', version: '1.0.0',
  language: 'zh-CN', description: '给用户看的简介', rating: 'general', ...patch,
});

const identity = (patch: Partial<CharacterIdentity> = {}): CharacterIdentity => ({
  name: '林霜', background: '北境出身，十二岁入伍。', ...patch,
});

const persona = (patch: Partial<Persona> = {}): Persona => ({
  summary: '冷面女剑士', traits: ['冷静', '寡言'], knowledge_boundary: '', ability_boundary: '', ...patch,
});

const speech = (patch: Partial<Speech> = {}): Speech => ({ style: '短句', ...patch });

const stateSchema = (patch: Partial<StateSchema> = {}): StateSchema => ({
  schema: { affection: { type: 'integer', default: 0, visible_to_user: true } },
  update_policy: { allow_llm_patch: true, require_engine_validation: true }, ...patch,
});

const characterCard = (patch: Partial<CharacterCard> = {}): CharacterCard => ({
  card_type: 'character', meta: meta(), identity: identity(), persona: persona(), speech: speech(), ...patch,
});

const sceneCard = (patch: Partial<SceneCard> = {}): SceneCard => ({
  card_type: 'scene',
  meta: meta({ id: 's1', schema: 'scene/v1', name: '边境酒馆' }),
  type: 'physical', description: '边境城唯一的酒馆，鱼龙混杂。',
  appearance: { summary: '雨夜的边境酒馆' },
  atmosphere: { light: '昏暗', sound: '雨声', smell: '酒味', temperature: '阴冷', crowd: '拥挤', mood: '压抑', other: '不该输出' },
  connections: [{ target: 's2' }, { target: 's3' }],
  occupants: [{ target: 'c1', presence: 'resident' }, { target: 'c2', presence: 'occasional' }],
  events: ['有人在角落闹事', '商人兜售可疑货物'], ...patch,
});

const itemCard = (patch: Partial<ItemCard> = {}): ItemCard => ({
  card_type: 'item', meta: meta({ id: 'i1', schema: 'item/v1', name: '月光剑' }),
  type: 'weapon', description: '一柄会发光的剑。', function: '夜间照明并斩断阴影。', rarity: 'rare', ...patch,
});

const loreCard = (patch: Partial<LoreCard> = {}): LoreCard => ({
  card_type: 'lore', meta: meta({ id: 'l1', schema: 'lore/v1', name: '银月战争' }),
  kind: 'history', content: '银月战争发生在三百年前。', keys: ['银月战争'], ...patch,
});

const fieldsOf = (card: CardDocument, context?: BriefContext): BriefField[] => projectBrief(card, context).fields;
const keysOf = (card: CardDocument, context?: BriefContext): BriefFieldKey[] => fieldsOf(card, context).map((field) => field.key);
const valueOf = (card: CardDocument, key: BriefFieldKey, context?: BriefContext): string | undefined =>
  fieldsOf(card, context).find((field) => field.key === key)?.value;

test('card.brief 非空时只输出一条 brief：作者/Agent 写过就以它为准（覆盖机制）', () => {
  const card = characterCard({ brief: '林霜｜冷面女剑士，话少，剑快。' });
  const projection = projectBrief(card);
  assert.equal(projection.kind, 'character');
  assert.deepEqual(projection.fields, [{ key: 'brief', value: '林霜｜冷面女剑士，话少，剑快。' }]);
});

test('card.brief 只有空白时视为没写，退回结构化投影', () => {
  const card = characterCard({ brief: '   \n' });
  assert.deepEqual(keysOf(card), ['name', 'summary', 'traits']);
});

test('角色字段顺序：name / summary / traits / mood / boundaries / state（界面按此顺序渲染）', () => {
  const card = characterCard({
    persona: persona({ knowledge_boundary: '不知道王都的事', ability_boundary: '不会魔法' }),
    state: stateSchema(),
  });
  const context: BriefContext = { variables: { 'character:c1': { mood: '温柔', affection: 35 } } };
  assert.deepEqual(keysOf(card, context), ['name', 'summary', 'traits', 'mood', 'boundaries', 'state']);
  assert.equal(valueOf(card, 'summary', context), '冷面女剑士');
  assert.equal(valueOf(card, 'traits', context), '冷静, 寡言');
  assert.equal(valueOf(card, 'mood', context), '温柔');
  assert.equal(valueOf(card, 'boundaries', context), '不知道王都的事 / 不会魔法');
  assert.equal(valueOf(card, 'state', context), 'affection=35');
});

test('mood 只来自运行时变量：没有变量就不输出 mood（不拿 default_mood 冒充运行时）', () => {
  const card = characterCard({ persona: persona({ default_mood: '冷淡' }) });
  assert.equal(valueOf(card, 'mood'), undefined);
});

test('boundaries 只输出非空的一侧：缺哪边就少哪边', () => {
  const onlyKnowledge = characterCard({ persona: persona({ knowledge_boundary: '不知道王都的事' }) });
  assert.equal(valueOf(onlyKnowledge, 'boundaries'), '不知道王都的事');
  const bothEmpty = characterCard({ persona: persona({ knowledge_boundary: '', ability_boundary: '' }) });
  assert.equal(valueOf(bothEmpty, 'boundaries'), undefined);
});

test('state 按变量名排序（不依赖 schema 的插入顺序）且只含 visible_to_user 的变量', () => {
  const card = characterCard({
    state: stateSchema({
      schema: {
        trust: { type: 'integer', default: 10, visible_to_user: true },
        affection: { type: 'integer', default: 0, visible_to_user: true },
        secret: { type: 'string', default: '不能给用户看', visible_to_user: false },
      },
    }),
  });
  assert.equal(valueOf(card, 'state'), 'affection=0, trust=10', '没有运行时值时用卡内 default，且排序稳定');
  const context: BriefContext = { variables: { 'character:c1': { affection: 35, trust: 42 } } };
  assert.equal(valueOf(card, 'state', context), 'affection=35, trust=42', '运行时值优先于 default');
});

test('没有可见变量时不输出 state 字段', () => {
  const card = characterCard({ state: stateSchema({ schema: { secret: { type: 'string', default: 'x', visible_to_user: false } } }) });
  assert.equal(valueOf(card, 'state'), undefined);
});

test('场景字段顺序与换名：connections/occupants 存的是 ID，投影换成显示名', () => {
  const context: BriefContext = {
    scene_names: new Map([['s2', '北门'], ['s3', '后巷']]),
    character_names: new Map([['c1', '老王']]),
  };
  const card = sceneCard();
  assert.deepEqual(keysOf(card, context), ['name', 'summary', 'atmosphere', 'exits', 'occupants', 'events', 'events']);
  assert.equal(valueOf(card, 'name', context), '边境酒馆');
  assert.equal(valueOf(card, 'summary', context), '雨夜的边境酒馆');
  assert.equal(valueOf(card, 'atmosphere', context), '昏暗 / 雨声 / 酒味 / 阴冷 / 拥挤 / 压抑', '固定顺序且不输出 other');
  assert.equal(valueOf(card, 'exits', context), '北门, 后巷');
  assert.equal(valueOf(card, 'occupants', context), '老王, c2(occasional)', '换不到名字用 ID；非 resident 用英文键标注');
});

test('场景没有名字上下文时退回 ID（不丢信息，也不编名字）', () => {
  const card = sceneCard();
  assert.equal(valueOf(card, 'exits'), 's2, s3');
  assert.equal(valueOf(card, 'occupants'), 'c1, c2(occasional)');
});

test('场景空的可选块不输出：没有氛围/连接/在场者/事件时 brief 只剩名字', () => {
  const card = sceneCard();
  delete card.appearance;
  delete card.atmosphere;
  delete card.connections;
  delete card.occupants;
  delete card.events;
  assert.deepEqual(keysOf(card), ['name']);
});

test('events 逐条输出，保持原顺序（每句话都是独立事件）', () => {
  const events = fieldsOf(sceneCard()).filter((field) => field.key === 'events').map((field) => field.value);
  assert.deepEqual(events, ['有人在角落闹事', '商人兜售可疑货物']);
});

test('氛围顺序固定为 light→sound→smell→temperature→crowd→mood，与对象键的插入顺序无关', () => {
  const first = sceneCard({ atmosphere: { mood: '压抑', light: '昏暗' } });
  const second = sceneCard({ atmosphere: { light: '昏暗', mood: '压抑' } });
  assert.equal(valueOf(first, 'atmosphere'), '昏暗 / 压抑');
  assert.deepEqual(fieldsOf(first), fieldsOf(second), '同语义的输入必须投影出同样的 brief');
});

test('物品字段顺序：name / function / holder / condition（holder 换成持有者显示名）', () => {
  const context: BriefContext = {
    character_names: new Map([['c1', '林霜']]),
    items: [{ item_id: 'i1', holder: 'c1', condition: { durability: 80, charge: 3 } }],
  };
  const card = itemCard();
  assert.deepEqual(keysOf(card, context), ['name', 'function', 'holder', 'condition']);
  assert.equal(valueOf(card, 'holder', context), '林霜');
  assert.equal(valueOf(card, 'condition', context), 'charge=3, durability=80', 'condition 按名排序保证确定性');
});

test('物品放在场景里时 holder 换成场景名', () => {
  const context: BriefContext = {
    scene_names: new Map([['s1', '边境酒馆']]),
    items: [{ item_id: 'i1', holder: 's1' }],
  };
  assert.equal(valueOf(itemCard(), 'holder', context), '边境酒馆');
});

test('物品 holder 换不到显示名或没有实例时，不输出 holder（宁可少字段也不输出裸 ID）', () => {
  const noInstance = itemCard();
  assert.equal(valueOf(noInstance, 'holder'), undefined);
  const unmappable: BriefContext = { items: [{ item_id: 'i1', holder: 'c1' }] };
  assert.equal(valueOf(itemCard(), 'holder', unmappable), undefined);
  assert.deepEqual(keysOf(itemCard(), unmappable), ['name', 'function']);
});

test('典籍 summary 优先：有 summary 就不输出 content', () => {
  const card = loreCard({ summary: '三百年前的战争。', content: '正文'.repeat(300) });
  assert.deepEqual(keysOf(card), ['name', 'summary']);
  assert.equal(valueOf(card, 'summary'), '三百年前的战争。');
});

test('典籍没有 summary 时用 content，超过 200 字符截断并加省略号', () => {
  const long = loreCard({ content: '银'.repeat(250) });
  assert.deepEqual(keysOf(long), ['name', 'content']);
  assert.equal(valueOf(long, 'content'), `${'银'.repeat(200)}…`);
  assert.equal(Array.from(valueOf(long, 'content') ?? '').length, 201, '200 字符 + 一个省略号');
});

test('典籍没有 summary 且 content 很短时原样输出', () => {
  const short = loreCard({ content: '银月战争发生在三百年前。' });
  assert.equal(valueOf(short, 'content'), '银月战争发生在三百年前。');
});

test('不读 meta.description：给用户看的简介不进 brief', () => {
  const card = characterCard();
  const text = fieldsOf(card).map((field) => field.value).join(' ');
  assert.equal(text.includes('给用户看的简介'), false);
});

test('确定性：同输入两次投影完全一致（同对象与等价新对象都一样）', () => {
  const card = sceneCard();
  assert.deepEqual(projectBrief(card), projectBrief(sceneCard()));
  assert.deepEqual(projectBrief(card), projectBrief(card));
});

test('kind 跟着卡片类型走', () => {
  assert.equal(projectBrief(characterCard()).kind, 'character');
  assert.equal(projectBrief(sceneCard()).kind, 'scene');
  assert.equal(projectBrief(itemCard()).kind, 'item');
  assert.equal(projectBrief(loreCard()).kind, 'lore');
});
