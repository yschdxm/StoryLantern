import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCard, type ItemCard, type LoreCard, type SceneCard } from '../../../packages/cards/src/index.ts';
import {
  buildCard,
  draftOfCard,
  emptyWorldDraft,
  splitKeyList,
  type ItemDraft,
  type LoreDraft,
  type SceneDraft,
  type WorldCardDraft,
} from '../src/screens/world-edit/world-form.ts';

/**
 * 世界资源表单的纯逻辑：草稿 ↔ 卡片。
 *
 * 三条容易出事的性质：
 *  1. 必填项齐全时能过 `validateCard`（表单不制造结构性错误）；
 *  2. 一次保存只覆盖表单字段，visuals/refs/agent/compat/extensions/item.behaviors 原样保留；
 *  3. 空行丢弃、顺序保持、触发词去重（表单是"人写的东西"，不能把空字符串存进卡片）。
 */

function minimalScene(): SceneDraft {
  return {
    ...(emptyWorldDraft('scene') as SceneDraft),
    name: '边境酒馆',
    description: '雨夜边境唯一的酒馆。',
    sceneDescription: '木屋，炉火将尽，鱼龙混杂。',
  };
}

function minimalItem(): ItemDraft {
  return {
    ...(emptyWorldDraft('item') as ItemDraft),
    name: '月光剑',
    description: '一把会低语的剑。',
    descriptionText: '剑身泛着冷白的光。',
    functionText: '月光下命中率提高。',
  };
}

function minimalLore(): LoreDraft {
  return {
    ...(emptyWorldDraft('lore') as LoreDraft),
    name: '银月教会',
    description: '信仰月神的教会。',
    content: '银月教会信仰月神，势力庞大。',
    keys: '银月, 教会',
  };
}

const minimalByKind: Record<'scene' | 'item' | 'lore', WorldCardDraft> = {
  scene: minimalScene(),
  item: minimalItem(),
  lore: minimalLore(),
};

test('空草稿（补必填项）→ 卡片通过 validateCard（无 error）', () => {
  for (const kind of ['scene', 'item', 'lore'] as const) {
    const card = buildCard(undefined, minimalByKind[kind]);
    const result = validateCard(card);
    const errors = result.issues.filter((issue) => issue.severity === 'error');
    assert.deepEqual(errors, [], `${kind} 不应有 error：${JSON.stringify(errors)}`);
    assert.equal(card.card_type, kind);
    assert.ok(card.meta.id.length > 0);
    assert.equal(card.meta.schema, kind === 'scene' ? 'scene/v1' : kind === 'item' ? 'item/v1' : 'lore/v1');
    assert.equal(card.meta.version, '1.0.0');
    assert.equal(card.meta.rating, 'general');
    assert.equal(card.meta.language, 'zh-CN');
  }
});

test('卡片 → 草稿 → 卡片：表单外的字段原样保留', () => {
  const cover = `asset://${'a'.repeat(64)}`;
  const scene = buildCard(undefined, minimalScene()) as SceneCard;
  const existingScene: SceneCard = {
    ...scene,
    meta: { ...scene.meta, author: '原作者', license: 'CC-BY-4.0', cover },
    brief: '作者写的简报',
    visuals: [{ id: 'v1', type: 'background', path: `asset://${'b'.repeat(64)}`, caption: '雨夜酒馆' }],
    refs: [{ target: 'north-gate', type: 'scene' }],
    agent: { policy: 'ask' },
    compat: { imported_from: 'sillytavern/v2' },
    extensions: { 'vendor.test': { keep: true } },
    default_state: { weather: '雨', tension: 3, night: true },
  };
  const sceneAgain = buildCard(existingScene, draftOfCard(existingScene)) as SceneCard;
  assert.equal(sceneAgain.meta.author, '原作者');
  assert.equal(sceneAgain.meta.license, 'CC-BY-4.0');
  assert.equal(sceneAgain.meta.cover, cover);
  assert.equal(sceneAgain.brief, '作者写的简报');
  assert.deepEqual(sceneAgain.visuals, existingScene.visuals);
  assert.deepEqual(sceneAgain.refs, existingScene.refs);
  assert.deepEqual(sceneAgain.agent, existingScene.agent);
  assert.deepEqual(sceneAgain.compat, existingScene.compat);
  assert.deepEqual(sceneAgain.extensions, existingScene.extensions);
  assert.deepEqual(sceneAgain.default_state, { weather: '雨', tension: 3, night: true }, '未改动的值必须保留原类型');

  const item = buildCard(undefined, minimalItem()) as ItemCard;
  const existingItem: ItemCard = {
    ...item,
    meta: { ...item.meta, author: '制作者' },
    behaviors: [{ id: 'b1', enabled: true, priority: 1, when: { event: 'before_reply' }, actions: [{ type: 'constraint', text: '会低语' }] }],
    visuals: [{ id: 'v2', type: 'detail', path: `asset://${'c'.repeat(64)}`, caption: '剑格纹样' }],
  };
  const itemAgain = buildCard(existingItem, draftOfCard(existingItem)) as ItemCard;
  assert.equal(itemAgain.meta.author, '制作者');
  assert.deepEqual(itemAgain.behaviors, existingItem.behaviors);
  assert.deepEqual(itemAgain.visuals, existingItem.visuals);
});

test('场景：连接/在场者/道具的空行丢弃且顺序保持', () => {
  const draft: SceneDraft = {
    ...minimalScene(),
    connections: [
      { target: '', direction: 'both', how: '空行', condition: '' },
      { target: 'scene-2', direction: 'one_way', how: '步行', condition: '' },
      { target: ' scene-3 ', direction: 'both', how: '', condition: 'has_key' },
      { target: '   ', direction: 'both', how: '', condition: '' },
    ],
    occupants: [
      { target: '', presence: 'resident', when: '', note: '' },
      { target: 'char-2', presence: 'occasional', when: '雨夜', note: '' },
      { target: 'char-1', presence: 'resident', when: '', note: '老板' },
    ],
    props: [
      { itemId: '', note: '空行' },
      { itemId: 'item-2', note: '' },
      { itemId: 'item-1', note: '柜台上' },
    ],
  };
  const card = buildCard(undefined, draft) as SceneCard;
  assert.deepEqual(card.connections?.map((row) => row.target), ['scene-2', 'scene-3']);
  assert.equal(card.connections?.[1]?.condition, 'has_key');
  assert.deepEqual(card.occupants?.map((row) => row.target), ['char-2', 'char-1']);
  assert.deepEqual(card.props?.map((row) => row.item_id), ['item-2', 'item-1']);
});

test('典籍：主/二级触发词去空白、去重（保序）', () => {
  const draft: LoreDraft = {
    ...minimalLore(),
    keys: ' 银月 , 银月,教会,,  ',
    secondaryKeys: ' 夜 ,夜, 月 ',
  };
  const card = buildCard(undefined, draft) as LoreCard;
  assert.deepEqual(card.keys, ['银月', '教会']);
  assert.deepEqual(card.secondary_keys, ['夜', '月']);
  assert.deepEqual(splitKeyList(' a, a ,, b 、b '), ['a', 'b']);
});

test('name 为空时校验报 error（编辑器能逐条展示）', () => {
  const card = buildCard(undefined, { ...minimalScene(), name: '   ' });
  const result = validateCard(card);
  const errors = result.issues.filter((issue) => issue.severity === 'error');
  assert.ok(errors.some((issue) => issue.path === 'meta.name'), `应报 meta.name：${JSON.stringify(errors)}`);
});
