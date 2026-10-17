import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCard, validatePack, type CardIssue, type CardValidation } from '../src/validate.ts';

/**
 * 校验器测试就是这份语义的说明书：
 *  - error = 数据不可用；warning = 能保存但作者该看见。
 *  - 每种 error 都断言「为什么」：缺了它界面上会缺什么、运行时会坏什么。
 */

const ASSET = `asset://${'a'.repeat(64)}`;

const meta = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'c1', schema: 'rolecard/v1', name: '林霜', version: '1.0.0',
  language: 'zh-CN', description: '冷面女剑士', rating: 'general', ...patch,
});

const identity = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: '林霜', background: '北境出身，十二岁入伍。', ...patch,
});

const persona = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  summary: '冷面女剑士', traits: ['冷静', '寡言'],
  knowledge_boundary: '不知道王都的事', ability_boundary: '不会魔法', ...patch,
});

const speech = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  style: '短句，少修饰', example_lines: ['嗯。', '让开。', '随你。', '不必。', '走吧。'], ...patch,
});

const group = (id: string, tags: string[]): Record<string, unknown> => ({
  id, tags, messages: [{ role: 'user', content: '打招呼' }],
});

const examples = (): Record<string, unknown>[] => [group('e1', ['cold_start']), group('e2', ['冲突']), group('e3', ['日常'])];

const state = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: { affection: { type: 'integer', default: 0, min: 0, max: 100, visible_to_user: true } },
  update_policy: { allow_llm_patch: true, require_engine_validation: true }, ...patch,
});

const visual = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'v1', type: 'portrait', path: ASSET, caption: '黑发女剑士，左颊有疤', is_primary: true, ...patch,
});

const characterCard = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  card_type: 'character', meta: meta(), identity: identity(), persona: persona(),
  speech: speech(), examples: examples(), state: state(), visuals: [visual()], ...patch,
});

const sceneCard = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  card_type: 'scene',
  meta: meta({ id: 's1', schema: 'scene/v1', name: '边境酒馆' }),
  type: 'physical', description: '边境城唯一的酒馆，鱼龙混杂。',
  atmosphere: { light: '昏暗', sound: '雨声', smell: '酒味', mood: '压抑' },
  connections: [{ target: 's2' }], occupants: [{ target: 'c1', presence: 'resident' }],
  props: [{ item_id: 'i1' }], events: ['有人在角落闹事'], is_entry: true, ...patch,
});

const itemCard = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  card_type: 'item', meta: meta({ id: 'i1', schema: 'item/v1', name: '月光剑' }),
  type: 'weapon', description: '一柄会发光的剑。', function: '夜间照明并斩断阴影。', rarity: 'rare', ...patch,
});

const loreCard = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  card_type: 'lore', meta: meta({ id: 'l1', schema: 'lore/v1', name: '银月战争' }),
  kind: 'history', content: '银月战争发生在三百年前。', summary: '三百年前的战争。', keys: ['银月战争'], ...patch,
});

const codes = (result: CardValidation): string[] => result.issues.map((entry) => entry.code);
const paths = (result: CardValidation): string[] => result.issues.map((entry) => entry.path);
const issue = (result: CardValidation, code: string): CardIssue | undefined => result.issues.find((entry) => entry.code === code);

test('四类完整卡：必填齐全且满足全部建议时没有任何 issue', () => {
  for (const card of [characterCard(), sceneCard(), itemCard(), loreCard()]) {
    const result = validateCard(card);
    assert.deepEqual(result.issues, [], `完整卡不应产生噪音：${JSON.stringify(result.issues)}`);
    assert.equal(result.ok, true);
  }
});

test('card_type 非法是 error，且不中断 meta 等其它字段的收集', () => {
  const result = validateCard(characterCard({ card_type: 'weapon', meta: meta({ name: '' }) }));
  assert.equal(issue(result, 'card-type-invalid')?.path, 'card_type', '类型是分发依据，先报它');
  assert.equal(issue(result, 'empty-field')?.path, 'meta.name', '类型坏了也要继续检查元信息');
  assert.equal(result.ok, false);
});

test('meta.schema 必须等于 CARD_SCHEMA[card_type]（否则迁移会认错结构版本）', () => {
  const result = validateCard(characterCard({ meta: meta({ schema: 'scene/v1' }) }));
  const mismatch = issue(result, 'schema-mismatch');
  assert.equal(mismatch?.path, 'meta.schema');
  assert.equal(mismatch?.severity, 'error');
});

test('meta 必填字符串缺失/空白都报 error，并用点号路径定位', () => {
  const result = validateCard(characterCard({ meta: meta({ id: undefined, description: '   ' }) }));
  assert.equal(issue(result, 'missing-field')?.path, 'meta.id');
  assert.equal(issue(result, 'empty-field')?.path, 'meta.description');
});

test('meta.rating 只接受 general / teen / mature', () => {
  const result = validateCard(characterCard({ meta: meta({ rating: 'adult' }) }));
  assert.equal(issue(result, 'invalid-value')?.path, 'meta.rating');
  assert.equal(result.ok, false);
});

test('visuals 有 path 没 caption 是 error：caption 是纯文本模型唯一入口', () => {
  const result = validateCard(characterCard({ visuals: [{ id: 'v1', type: 'portrait', path: ASSET }] }));
  const caption = issue(result, 'visual-caption-missing');
  assert.equal(caption?.path, 'visuals[0].caption');
  assert.equal(caption?.severity, 'error');
  assert.equal(result.ok, false);
});

test('visuals 每项的 id / type 必填；path 可选（只有 description 也能用）', () => {
  const result = validateCard(characterCard({ visuals: [{ caption: '只有描述' }] }));
  assert.deepEqual(paths(result), ['visuals[0].id', 'visuals[0].type', 'visuals[0].caption']);
  assert.deepEqual(codes(result), ['missing-field', 'missing-field', 'visual-no-image']);
  assert.equal(result.ok, false, 'id/type 缺失仍是 error');
});

test('visuals：无 path 但有 caption → 只 warning visual-no-image，可保存', () => {
  const result = validateCard(characterCard({
    visuals: [{ id: 'v1', type: 'portrait', caption: '黑发女剑士，左颊有疤' }],
  }));
  const noImage = issue(result, 'visual-no-image');
  assert.equal(noImage?.path, 'visuals[0].caption');
  assert.equal(noImage?.severity, 'warning');
  assert.equal(result.ok, true, '资产通道未接线：描述优先是允许形态');
});

test('visuals：caption 为空是 error；path 空字符串也是 error', () => {
  const noCaption = validateCard(characterCard({ visuals: [{ id: 'v1', type: 'portrait' }] }));
  assert.equal(issue(noCaption, 'visual-caption-missing')?.severity, 'error');
  const emptyPath = validateCard(characterCard({ visuals: [{ id: 'v1', type: 'portrait', path: '', caption: '描述' }] }));
  assert.equal(issue(emptyPath, 'empty-field')?.path, 'visuals[0].path');
});

test('visuals.path 必须是 asset://<sha256>：绝对路径跨设备必坏', () => {
  const bad = validateCard(characterCard({ visuals: [visual({ path: 'C:/pics/portrait.png' })] }));
  assert.equal(issue(bad, 'asset-ref-invalid')?.path, 'visuals[0].path');
  const good = validateCard(characterCard({ visuals: [visual({ path: ASSET })] }));
  assert.equal(issue(good, 'asset-ref-invalid'), undefined);
});

test('多个 is_primary 只 warning：能保存，但主视觉会不确定', () => {
  const result = validateCard(characterCard({ visuals: [visual(), visual({ id: 'v2', is_primary: true })] }));
  assert.equal(issue(result, 'visual-primary-multiple')?.severity, 'warning');
  assert.equal(result.ok, true);
});

test('边界字段缺失是 error（防幻觉字段没有任何值）', () => {
  const result = validateCard(characterCard({ persona: persona({ knowledge_boundary: undefined }) }));
  assert.equal(issue(result, 'missing-field')?.path, 'persona.knowledge_boundary');
  assert.equal(result.ok, false);
});

test('边界字段空串只 warning：旧卡导入后待补全，不拦保存', () => {
  const result = validateCard(characterCard({ persona: persona({ knowledge_boundary: '', ability_boundary: '不会魔法' }) }));
  const pending = issue(result, 'boundary-pending');
  assert.equal(pending?.path, 'persona.knowledge_boundary');
  assert.equal(pending?.severity, 'warning');
  assert.equal(result.ok, true, '空串是「待补全」而不是「不可用」');
});

test('角色必填：identity.background / persona.summary / traits 空数组 / speech.style 空串是 warning（可保存，待补全）', () => {
  const result = validateCard(characterCard({
    identity: identity({ background: '' }), persona: persona({ summary: '', traits: [] }), speech: speech({ style: '' }),
  }));
  assert.deepEqual(paths(result), ['identity.background', 'persona.summary', 'persona.traits', 'speech.style']);
  assert.equal(result.ok, true, '空字段只提示，不拦保存（否则导入的旧卡永远存不进去）');
  for (const path of ['identity.background', 'persona.summary', 'persona.traits', 'speech.style']) {
    assert.equal(result.issues.find((entry) => entry.path === path)?.severity, 'warning', path);
  }
});

test('角色必填再补：identity.name 空串与 persona.traits 缺失仍是 error（结构不对 vs 还没填）', () => {
  const noName = validateCard(characterCard({ identity: identity({ name: '' }) }));
  assert.equal(issue(noName, 'empty-field')?.path, 'identity.name');
  const noTraits = validateCard(characterCard({ persona: persona({ traits: undefined }) }));
  assert.equal(issue(noTraits, 'missing-field')?.path, 'persona.traits');
});

test('example_lines 整个缺失也 warning（0 条，建议至少 5 条）', () => {
  const result = validateCard(characterCard({ speech: speech({ example_lines: undefined }) }));
  assert.equal(issue(result, 'example-lines-too-few')?.severity, 'warning');
  assert.equal(result.ok, true);
});

test('examples 少于 3 组只 warning：示例是建议，不是可用性门槛', () => {
  const result = validateCard(characterCard({ examples: [group('e1', ['cold_start'])] }));
  assert.equal(issue(result, 'examples-too-few')?.severity, 'warning');
  assert.equal(issue(result, 'examples-too-few')?.path, 'examples');
  assert.equal(result.ok, true);
});

test('缺少冷启动示例（tags 含 cold_start/初次）只 warning：否则智能开场易写成通用 AI 腔', () => {
  const none = validateCard(characterCard({ examples: [group('e1', ['冲突']), group('e2', ['日常']), group('e3', ['战斗'])] }));
  assert.equal(issue(none, 'cold-start-example-missing')?.severity, 'warning');
  const chineseTag = validateCard(characterCard({ examples: [group('e1', ['初次']), group('e2', ['日常'])] }));
  assert.equal(issue(chineseTag, 'cold-start-example-missing'), undefined, '中文标签「初次」同样算冷启动');
});

test('example_lines 少于 5 条只 warning（声音校准不足）', () => {
  const result = validateCard(characterCard({ speech: speech({ example_lines: ['嗯。'] }) }));
  assert.equal(issue(result, 'example-lines-too-few')?.severity, 'warning');
  assert.equal(issue(result, 'example-lines-too-few')?.path, 'speech.example_lines');
  assert.equal(result.ok, true);
});

test('state 变量 default 与 type 不匹配只 warning（卡仍可保存）', () => {
  const result = validateCard(characterCard({ state: state({ schema: { affection: { type: 'integer', default: '很高' } } }) }));
  assert.equal(issue(result, 'state-default-mismatch')?.path, 'state.schema.affection.default');
  assert.equal(issue(result, 'state-default-mismatch')?.severity, 'warning');
  assert.equal(result.ok, true);
});

test('state default 越界（min/max）与不在 enum 都是 warning', () => {
  const result = validateCard(characterCard({
    state: state({ schema: {
      affection: { type: 'integer', default: 120, min: 0, max: 100 },
      mood: { type: 'string', default: '暴躁', enum: ['冷淡', '温和'] },
    } }),
  }));
  assert.equal(issue(result, 'state-default-out-of-range')?.path, 'state.schema.affection.default');
  assert.equal(issue(result, 'state-default-not-in-enum')?.path, 'state.schema.mood.default');
  assert.equal(result.ok, true);
});

test('场景卡：type 非法与 description 空是 error', () => {
  const result = validateCard(sceneCard({ type: 'cave', description: '' }));
  assert.deepEqual(paths(result), ['type', 'description']);
  assert.equal(result.ok, false);
});

test('场景卡 warning：atmosphere 缺失 / connections 为空 / 入口无连接', () => {
  const result = validateCard(sceneCard({ atmosphere: undefined, connections: [], is_entry: true }));
  assert.equal(issue(result, 'atmosphere-missing')?.severity, 'warning');
  assert.equal(issue(result, 'connections-empty')?.severity, 'warning');
  assert.equal(issue(result, 'entry-scene-no-connections')?.severity, 'warning');
  assert.equal(result.ok, true, '场景可用性建议不该拦住保存');
});

test('场景完全没有 connections 也只是 warning（场景簿是可选资源，不拦保存）', () => {
  const card = sceneCard();
  delete card['connections'];
  const result = validateCard(card);
  assert.equal(issue(result, 'connections-empty')?.severity, 'warning');
  assert.equal(issue(result, 'entry-scene-no-connections')?.severity, 'warning');
  assert.equal(result.ok, true);
});

test('物品卡：type/description/function 是 error，rarity 缺失只 warning', () => {
  const bad = validateCard(itemCard({ type: 'potion', description: '', function: undefined }));
  assert.deepEqual(paths(bad), ['type', 'description', 'function']);
  assert.equal(bad.ok, false);
  const noRarity = validateCard(itemCard({ rarity: undefined }));
  assert.equal(issue(noRarity, 'rarity-missing')?.severity, 'warning');
  assert.equal(noRarity.ok, true);
});

test('典籍卡：kind/content/keys 是 error', () => {
  const result = validateCard(loreCard({ kind: 'poem', content: '', keys: [] }));
  assert.deepEqual(paths(result), ['kind', 'content', 'keys']);
  assert.equal(result.ok, false);
});

test('典籍 keys 为空在 trigger.constant 为 true 时合法：常驻条目不需要触发词', () => {
  const result = validateCard(loreCard({ keys: [], trigger: { constant: true } }));
  assert.deepEqual(result.issues, []);
  assert.equal(result.ok, true);
});

test('典籍 keys 缺失：非常驻是 error，常驻（trigger.constant）合法', () => {
  const missing = loreCard();
  delete missing['keys'];
  assert.equal(issue(validateCard(missing), 'missing-field')?.path, 'keys');
  const constant = { ...missing, trigger: { constant: true } };
  assert.deepEqual(validateCard(constant).issues, []);
});

test('典籍 summary 缺失只 warning：brief 会退化为 content 截断', () => {
  const result = validateCard(loreCard({ summary: undefined }));
  assert.equal(issue(result, 'lore-summary-missing')?.severity, 'warning');
  assert.equal(issue(result, 'lore-summary-missing')?.path, 'summary');
  assert.equal(result.ok, true);
});

test('dangling-ref 只在传 known_card_ids 时检查，且只是 warning', () => {
  const card = characterCard({ refs: [{ target: 'missing-id', type: 'related' }] });
  assert.equal(issue(validateCard(card), 'dangling-ref'), undefined, '没有 known 集合就无从判断');
  const checked = validateCard(card, { known_card_ids: new Set(['known-id']) });
  const dangling = issue(checked, 'dangling-ref');
  assert.equal(dangling?.path, 'refs[0].target');
  assert.equal(dangling?.severity, 'warning');
  assert.equal(checked.ok, true, '世界包可分批导入，引用不到不该拦保存');
});

test('场景引用（connections/occupants/props）同样检查 dangling-ref，路径精确到条目', () => {
  const result = validateCard(sceneCard(), { known_card_ids: new Set(['s1']) });
  assert.deepEqual(paths(result), ['connections[0].target', 'occupants[0].target', 'props[0].item_id']);
  assert.deepEqual(codes(result), ['dangling-ref', 'dangling-ref', 'dangling-ref']);
});

test('引用目标存在时没有 dangling-ref 警告', () => {
  const result = validateCard(sceneCard(), { known_card_ids: new Set(['s1', 's2', 'c1', 'i1']) });
  assert.deepEqual(result.issues, []);
});

test('输入是 unknown：根不是对象也不抛异常，只报 error', () => {
  for (const value of [null, 42, 'card', [], { card_type: 'character' }]) {
    const result = validateCard(value);
    assert.equal(typeof result.ok, 'boolean', `不应该被 ${String(value)} 炸掉`);
    assert.equal(result.ok, false);
  }
});

test('结构错但类型可识别时继续收集：meta 坏了不影响场景字段检查', () => {
  const result = validateCard({ card_type: 'scene', meta: 'bad', type: 'physical', description: '' });
  assert.equal(issue(result, 'invalid-type')?.path, 'meta');
  assert.equal(issue(result, 'empty-field')?.path, 'description');
});

test('validatePack：合法清单无 issue；schema/必填/卡片 ID 错误都能定位', () => {
  const valid = { schema: 'worldpack/v1', id: 'w1', name: '北境', version: '1.0.0', language: 'zh-CN', card_ids: ['c1'] };
  assert.deepEqual(validatePack(valid).issues, []);
  const bad = validatePack({ schema: 'worldpack/v2', card_ids: ['c1', ''] });
  assert.deepEqual(codes(bad), ['schema-mismatch', 'missing-field', 'missing-field', 'missing-field', 'missing-field', 'invalid-value']);
  assert.equal(issue(bad, 'schema-mismatch')?.path, 'schema');
  assert.equal(issue(bad, 'invalid-value')?.path, 'card_ids[1]');
  assert.equal(validatePack(undefined).ok, false);
});
