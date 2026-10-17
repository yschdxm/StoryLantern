import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldPackManifest } from '../../../packages/cards/src/index.ts';
import {
  buildPack,
  DEFAULT_PACK_LANGUAGE,
  DEFAULT_PACK_VERSION,
  draftOfPack,
  emptyPackDraft,
  normalizeCardIds,
  splitTags,
  tagsText,
  toggleCard,
} from '../src/screens/world-edit/pack-form.ts';

/**
 * 世界包表单的纯逻辑契约。
 *
 * 约定写死两件事：
 *  1. `buildPack` **不校验名称**（名称非空由界面拦保存）——空名时仍返回结构完整的清单；
 *  2. 表单没拥有的字段（以及未来版本的未知字段）必须原样保留，编辑一次不能抹掉。
 */

const NOW = 1_700_000_000_000;

test('新建：默认版本 / 语言，名称与卡片为空，其它可选字段省略', () => {
  const draft = emptyPackDraft();
  assert.equal(draft.name, '');
  assert.equal(draft.version, DEFAULT_PACK_VERSION);
  assert.equal(draft.language, DEFAULT_PACK_LANGUAGE);
  assert.equal(draft.description, '');
  assert.equal(draft.author, '');
  assert.equal(draft.license, '');
  assert.equal(draft.tags, '');
  assert.deepEqual(draft.card_ids, []);

  const pack = buildPack(undefined, draft, NOW);
  assert.equal(pack.schema, 'worldpack/v1');
  assert.ok(pack.id.length > 0, '新建时生成 id');
  assert.equal(pack.version, '1.0.0');
  assert.equal(pack.language, 'zh-CN');
  assert.equal(pack.created_at, NOW);
  assert.equal(pack.updated_at, NOW);
  assert.deepEqual(pack.card_ids, []);
  assert.equal(pack.description, undefined);
  assert.equal(pack.author, undefined);
});

test('往返：id / created_at / 未知字段原样保留，表单字段按草稿更新', () => {
  const existing = {
    schema: 'worldpack/v1',
    id: 'pack-1',
    name: '旧名字',
    version: '0.9.0',
    language: 'zh-CN',
    description: '旧描述',
    author: '旧作者',
    license: 'CC-BY',
    tags: ['奇幻', '边境'],
    card_ids: ['c1', 'c2'],
    created_at: 111,
    updated_at: 222,
    // 未来版本可能新增、当前表单不认识：必须保留
    custom_future_field: { hello: 1 },
  } as unknown as WorldPackManifest;

  const draft = draftOfPack(existing);
  assert.equal(draft.name, '旧名字');
  assert.deepEqual(draft.card_ids, ['c1', 'c2']);
  assert.equal(draft.tags, '奇幻，边境');

  draft.name = '新名字';
  draft.version = '';
  draft.description = '';
  draft.author = '新作者';
  const built = buildPack(existing, draft, NOW);

  assert.equal(built.id, 'pack-1');
  assert.equal(built.created_at, 111);
  assert.equal(built.updated_at, NOW);
  assert.equal(built.name, '新名字');
  assert.equal(built.version, '1.0.0', '版本清空时回到默认值');
  assert.equal(built.language, 'zh-CN');
  assert.equal(built.description, undefined, '表单里清空 → 清单里删除（不是悄悄保留旧值）');
  assert.equal(built.author, '新作者');
  assert.equal(built.license, 'CC-BY', '草稿没动过的字段保持原值');
  assert.deepEqual(built.tags, ['奇幻', '边境']);
  assert.deepEqual((built as unknown as Record<string, unknown>)['custom_future_field'], { hello: 1 });

  // 草稿 ↔ 清单再走一遍不漂移
  const again = draftOfPack(built);
  assert.equal(again.name, '新名字');
  assert.equal(again.version, '1.0.0');
});

test('卡片多选：toggle 保持点击顺序，normalize 去重保序', () => {
  let ids: string[] = [];
  ids = toggleCard(ids, 'b');
  ids = toggleCard(ids, 'a');
  ids = toggleCard(ids, 'c');
  assert.deepEqual(ids, ['b', 'a', 'c'], '新勾选追加到末尾，不按字母重排');
  ids = toggleCard(ids, 'a');
  assert.deepEqual(ids, ['b', 'c'], '取消勾选只移除该项，其余顺序不变');

  assert.deepEqual(normalizeCardIds(['a', 'b', 'a', '', ' b ', 'c']), ['a', 'b', 'c']);

  const draft = { ...emptyPackDraft(), name: '包', card_ids: ['c2', 'c1', 'c2'] };
  assert.deepEqual(buildPack(undefined, draft, NOW).card_ids, ['c2', 'c1'], '写入清单前也要去重保序');
});

test('标签：中英文逗号/顿号/换行都能切分，写回清单时去空', () => {
  assert.deepEqual(splitTags('奇幻，边境, 低魔、夜间\n'), ['奇幻', '边境', '低魔', '夜间']);
  assert.equal(tagsText(['奇幻', '边境']), '奇幻，边境');
  assert.equal(tagsText(undefined), '');

  const draft = { ...emptyPackDraft(), name: '包', tags: '奇幻，，边境, ' };
  assert.deepEqual(buildPack(undefined, draft, NOW).tags, ['奇幻', '边境']);

  const cleared = buildPack(
    { schema: 'worldpack/v1', id: 'p', name: '包', version: '1.0.0', language: 'zh-CN', card_ids: [], tags: ['旧'] },
    { ...emptyPackDraft(), name: '包' },
    NOW,
  );
  assert.equal(cleared.tags, undefined, '清空标签要能删掉旧值');
});

test('名称校验约定：buildPack 不抛错（空名由界面拦保存），空名仍产出完整结构', () => {
  const built = buildPack(undefined, { ...emptyPackDraft(), name: '   ' }, NOW);
  assert.equal(built.name, '', 'build 不替界面做校验；界面用它做保存禁用判断');
  assert.equal(built.schema, 'worldpack/v1');
  assert.ok(built.id.length > 0);
});
