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

test('典籍触发策略：整词匹配与单条预算往返（空 = 不限制）', () => {
  const onDraft: LoreDraft = {
    ...minimalLore(),
    trigger: { ...minimalLore().trigger, matchWholeWords: true, tokenBudget: '120' },
  };
  const onCard = buildCard(undefined, onDraft) as LoreCard;
  assert.equal(onCard.trigger?.match_whole_words, true);
  assert.equal(onCard.trigger?.token_budget, 120);
  const onAgain = draftOfCard(onCard) as LoreDraft;
  assert.equal(onAgain.trigger.matchWholeWords, true);
  assert.equal(onAgain.trigger.tokenBudget, '120');

  const offDraft: LoreDraft = {
    ...minimalLore(),
    trigger: { ...minimalLore().trigger, matchWholeWords: false, tokenBudget: '' },
  };
  const offCard = buildCard(undefined, offDraft) as LoreCard;
  assert.equal('match_whole_words' in (offCard.trigger ?? {}), false);
  assert.equal('token_budget' in (offCard.trigger ?? {}), false);
  const offAgain = draftOfCard(offCard) as LoreDraft;
  assert.equal(offAgain.trigger.matchWholeWords, false);
  assert.equal(offAgain.trigger.tokenBudget, '');
});

test('典籍触发策略 B3–B6：次键逻辑/递归/分组/轮次往返，0 与空保留语义', () => {
  const draft: LoreDraft = {
    ...minimalLore(),
    trigger: {
      ...minimalLore().trigger,
      selectiveLogic: '3',
      excludeRecursion: true,
      preventRecursion: true,
      delayUntilRecursion: '2',
      group: '月相',
      groupWeight: '80',
      sticky: '3',
      cooldown: '4',
      delay: '1',
    },
  };
  const card = buildCard(undefined, draft) as LoreCard;
  assert.equal(card.trigger?.selective_logic, 3);
  assert.equal(card.trigger?.exclude_recursion, true);
  assert.equal(card.trigger?.prevent_recursion, true);
  assert.equal(card.trigger?.delay_until_recursion, 2);
  assert.equal(card.trigger?.group, '月相');
  assert.equal(card.trigger?.group_weight, 80);
  assert.equal(card.trigger?.sticky, 3);
  assert.equal(card.trigger?.cooldown, 4);
  assert.equal(card.trigger?.delay, 1);
  const again = draftOfCard(card) as LoreDraft;
  assert.equal(again.trigger.selectiveLogic, '3');
  assert.equal(again.trigger.groupWeight, '80');
  assert.equal(again.trigger.sticky, '3');

  // 0 是合法值；空/关 = 未设（从卡片上消失）
  const zero = buildCard(undefined, {
    ...minimalLore(),
    trigger: { ...minimalLore().trigger, selectiveLogic: '0', groupWeight: '0', sticky: '0', cooldown: '0', delay: '0' },
  }) as LoreCard;
  assert.equal(zero.trigger?.selective_logic, 0);
  assert.equal(zero.trigger?.group_weight, 0);
  assert.equal(zero.trigger?.sticky, 0);
  assert.equal(zero.trigger?.cooldown, 0);
  assert.equal(zero.trigger?.delay, 0);

  const empty = buildCard(undefined, {
    ...minimalLore(),
    trigger: {
      ...minimalLore().trigger,
      group: '',
      groupWeight: '',
      sticky: '',
      cooldown: '',
      delay: '',
      delayUntilRecursion: '',
      excludeRecursion: false,
      preventRecursion: false,
    },
  }) as LoreCard;
  for (const key of ['group', 'group_weight', 'sticky', 'cooldown', 'delay', 'delay_until_recursion', 'exclude_recursion', 'prevent_recursion'] as const) {
    assert.equal(key in (empty.trigger ?? {}), false, `${key} 不应写入空值`);
  }

  // 表单外的 trigger 未知字段保留
  const withExtra = { ...card, trigger: { ...(card.trigger ?? {}), 'vendor.x': true } } as unknown as LoreCard;
  const preserved = buildCard(withExtra, draftOfCard(withExtra) as LoreDraft) as LoreCard;
  assert.equal((preserved.trigger as unknown as Record<string, unknown>)['vendor.x'], true);
});

test('典籍注入位置/outlet/depth：往返与未设置语义', () => {
  const draft: LoreDraft = {
    ...minimalLore(),
    trigger: { ...minimalLore().trigger, position: '4', outlet: 'prompt.outlet', depth: '6' },
  };
  const card = buildCard(undefined, draft) as LoreCard;
  assert.equal(card.trigger?.position, 4);
  assert.equal(card.trigger?.outlet, 'prompt.outlet');
  assert.equal(card.trigger?.depth, 6);
  const again = draftOfCard(card) as LoreDraft;
  assert.equal(again.trigger.position, '4');
  assert.equal(again.trigger.outlet, 'prompt.outlet');
  assert.equal(again.trigger.depth, '6');

  // position=4 且 depth 留空 → 默认 4
  const defaultDepth = buildCard(undefined, {
    ...minimalLore(),
    trigger: { ...minimalLore().trigger, position: '4', depth: '' },
  }) as LoreCard;
  assert.equal(defaultDepth.trigger?.depth, 4);

  // 未设置 position → 不写字段；空 outlet 删除
  const unset = buildCard(undefined, {
    ...minimalLore(),
    trigger: { ...minimalLore().trigger, position: '', outlet: '', depth: '' },
  }) as LoreCard;
  assert.equal('position' in (unset.trigger ?? {}), false);
  assert.equal('outlet' in (unset.trigger ?? {}), false);
  assert.equal('depth' in (unset.trigger ?? {}), false);
});

test('name 为空时校验报 error（编辑器能逐条展示）', () => {
  const card = buildCard(undefined, { ...minimalScene(), name: '   ' });
  const result = validateCard(card);
  const errors = result.issues.filter((issue) => issue.severity === 'error');
  assert.ok(errors.some((issue) => issue.path === 'meta.name'), `应报 meta.name：${JSON.stringify(errors)}`);
});
