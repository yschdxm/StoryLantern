import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCard,
  type CardIssue,
  type CharacterCard,
  type SceneCard,
  type VisualAsset,
} from '../../../packages/cards/src/index.ts';
import { applyDraftToCard } from '../src/data/character-compat.ts';
import {
  draftsToVisuals,
  emptyVisualDraft,
  visualsToDrafts,
  withPrimary,
} from '../src/data/visuals-form.ts';
import { appendVisualCaptions, visualCaptions } from '../src/data/prompt-visuals.ts';
import {
  renderCharacterSection,
  renderSceneSection,
  type PromptBlockDataV2,
} from '../src/data/prompt-blocks-v2.ts';

/**
 * 视觉设定（描述优先）：
 *  - 草稿 ↔ 卡片往返保留未知字段、顺序与 `is_primary` 归一；
 *  - 校验：无图有 caption 只是 warning，坏 path / 空 caption 是 error；
 *  - 提示词只取 caption（最多 3 条 / 场景 1 条），顺序确定。
 */

const ASSET = `asset://${'a'.repeat(64)}`;

function characterWith(visuals: readonly VisualAsset[]): CharacterCard {
  const card = applyDraftToCard(undefined, {
    name: '林霜',
    description: '冷面女剑士。',
    background: '北境出身。',
    personalitySummary: '冷面',
    traits: ['冷静'],
    speechStyle: '短句。',
    knowledgeBoundary: '不知道王都的事。',
    abilityBoundary: '不会魔法。',
  });
  return { ...card, visuals };
}

function issueOf(card: unknown, code: string): CardIssue | undefined {
  return validateCard(card).issues.find((entry) => entry.code === code);
}

test('草稿 ↔ 卡片：顺序、未知字段、variant_of 与已知字段都保留', () => {
  const vendor = { id: 'v1', type: 'portrait', caption: '黑发女剑士', path: ASSET, 'vendor.extra': { keep: true } } as unknown as VisualAsset;
  const second: VisualAsset = { id: 'v2', type: 'detail', caption: '左颊的旧疤' };
  const originals: VisualAsset[] = [
    {
      ...vendor,
      tags: ['主视觉', '冬季'],
      view: 'front',
      binding: 'mood == "冷淡"',
      render_prompt: 'dark hair, scar',
      is_primary: true,
      notes: '作者备注',
      variant_of: 'v0',
    },
    second,
  ];

  const drafts = visualsToDrafts(originals);
  assert.deepEqual(drafts.map((draft) => draft.id), ['v1', 'v2'], '顺序保持');
  assert.equal(drafts[1]?.path, '', '无图条目 path 为空');

  drafts[0]!.caption = '黑发女剑士（改）';
  const back = draftsToVisuals(drafts);
  assert.deepEqual(back.map((visual) => visual.id), ['v1', 'v2'], '保存顺序保持');
  assert.equal(back[0]?.caption, '黑发女剑士（改）');
  assert.equal(back[0]?.path, ASSET);
  assert.deepEqual(back[0]?.tags, ['主视觉', '冬季']);
  assert.equal(back[0]?.is_primary, true);
  assert.equal(back[0]?.variant_of, 'v0', '表单不编辑的字段必须保留');
  assert.deepEqual((back[0] as unknown as Record<string, unknown>)['vendor.extra'], { keep: true }, '未知字段必须保留');
  assert.equal(back[1]?.is_primary, undefined);
});

test('草稿 → 卡片：清空的可选字段被删除；is_primary 全局至多一个（第一个生效）', () => {
  const drafts = visualsToDrafts([
    { id: 'v1', type: 'portrait', caption: '一号', is_primary: true, path: ASSET, tags: ['x'] },
    { id: 'v2', type: 'portrait', caption: '二号', is_primary: true },
  ]);
  drafts[0]!.path = '';
  drafts[0]!.tags = '';
  const back = draftsToVisuals(drafts);
  assert.equal(back[0]?.path, undefined);
  assert.equal(back[0]?.tags, undefined);
  assert.equal(back[0]?.is_primary, true);
  assert.equal(back[1]?.is_primary, undefined, '第二个主视觉被归一掉');

  const uiPicked = withPrimary(visualsToDrafts(back), 'v2', true);
  assert.deepEqual(uiPicked.map((draft) => draft.isPrimary), [false, true], 'UI 单选：勾一个其余置 false');
});

test('新建条目：id 非空，默认 key_art，caption 空（保存时由校验器拦）', () => {
  const draft = emptyVisualDraft();
  assert.ok(draft.id.length > 0);
  assert.equal(draft.type, 'key_art');
  assert.equal(draft.caption, '');
  assert.notEqual(emptyVisualDraft().id, draft.id);
});

test('校验：无 path 有 caption = warning 且 ok；坏 path / 空 caption 是 error', () => {
  const noImage = characterWith([{ id: 'v1', type: 'portrait', caption: '黑发女剑士，左颊有疤' }]);
  const warning = issueOf(noImage, 'visual-no-image');
  assert.equal(warning?.severity, 'warning');
  assert.equal(warning?.path, 'visuals[0].caption');
  assert.equal(validateCard(noImage).ok, true, '描述优先是允许形态');

  const badPath = characterWith([{ id: 'v1', type: 'portrait', path: 'C:/pic.png', caption: '描述' }]);
  assert.equal(issueOf(badPath, 'asset-ref-invalid')?.severity, 'error');
  assert.equal(validateCard(badPath).ok, false);

  const noCaption = characterWith([{ id: 'v1', type: 'portrait', path: ASSET } as unknown as VisualAsset]);
  assert.equal(issueOf(noCaption, 'visual-caption-missing')?.severity, 'error');
  assert.equal(validateCard(noCaption).ok, false);
});

test('提示词（角色）：【外观参考】最多 3 条 caption，按数组顺序、确定性', () => {
  const visuals: VisualAsset[] = [
    { id: 'v1', type: 'key_art', caption: '黑发，旧疤' },
    { id: 'v2', type: 'portrait', caption: '洗白的旧斗篷' },
    { id: 'v3', type: 'detail', caption: '右手冻伤' },
    { id: 'v4', type: 'palette', caption: '第四条不应出现' },
    { id: 'v5', type: 'concept', caption: '   ' },
  ];
  const card = characterWith(visuals);
  const first = renderCharacterSection(card);
  const second = renderCharacterSection(card);
  assert.equal(first, second, '同一输入必须产出同一文本');
  assert.ok(first.includes('【外观参考】黑发，旧疤；洗白的旧斗篷；右手冻伤'), first);
  assert.ok(!first.includes('第四条不应出现'), '最多 3 条');

  assert.deepEqual(visualCaptions(visuals, 2), ['黑发，旧疤', '洗白的旧斗篷']);
});

test('提示词（场景）：只取当前场景 key_art/background 的第一条 caption', () => {
  const scene: SceneCard = {
    card_type: 'scene',
    meta: { id: 's1', schema: 'scene/v1', name: '边境酒馆', version: '1.0.0', language: 'zh-CN', rating: 'general', description: '雨夜酒馆' },
    type: 'physical',
    description: '雨夜，边境唯一的酒馆。',
    visuals: [
      { id: 'v1', type: 'key_art', caption: '雨夜里的木屋，窗缝漏出灯光' },
      { id: 'v2', type: 'background', caption: '内景不应出现' },
      { id: 'v3', type: 'portrait', caption: '人物立绘不应出现' },
    ],
  };
  const data: PromptBlockDataV2 = {
    custom: '',
    setup: { characters: [], premise: '', opening_mode: 'self', origin: 'user' },
    world: { members: [], characterById: new Map(), sceneById: new Map([[scene.meta.id, scene]]), itemById: new Map(), loreCards: [] },
    runtime: { variables: {}, items: {}, scene_state: {}, current_scene_id: scene.meta.id },
    history: [],
    memories: [],
    summaries: [],
    lastMessageKey: '',
    retrieval: {},
    outcomes: { matchedLore: [], loreDropped: 0, matchedMemories: [], matchedSummaries: [], rulesOmitted: 0 },
  };
  const text = renderSceneSection(data);
  assert.ok(text?.includes('【外观参考】雨夜里的木屋，窗缝漏出灯光'), text);
  assert.ok(!text?.includes('内景不应出现'), '场景只取 1 条');
  assert.equal(renderSceneSection(data), text, '确定性');
  const lines: string[] = [];
  appendVisualCaptions(lines, scene.visuals, '【外观参考】', 1, ['key_art', 'background']);
  assert.deepEqual(lines, ['【外观参考】雨夜里的木屋，窗缝漏出灯光']);
});
