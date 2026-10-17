import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionCards, resolveActivation } from '../src/activation.ts';
import type { CharacterCard, ItemCard, LoreCard, SceneCard } from '../src/index.ts';
import type { SessionRuntime, SessionSetup } from '../src/types-session.ts';

/**
 * 激活规则（"哪张卡参与这一局"）的五条判定：
 * 库级停用 → 会话例外关闭 → 会话例外强制打开 → 按类型自动激活 → 资源池。
 *
 * 这些判定是提示词装配的前置：错一条，用户就会看到"我明明有这张卡，模型却没看到"。
 */

function baseMeta(id: string, schema: string, name = id) {
  return { id, schema, name, version: '1.0.0', language: 'zh-CN', rating: 'general' as const, description: '' };
}

const character: CharacterCard = {
  card_type: 'character',
  meta: baseMeta('c1', 'rolecard/v1', '星野'),
  identity: { name: '星野', background: '' },
  persona: { summary: '', traits: [], knowledge_boundary: '', ability_boundary: '' },
  speech: { style: '' },
};

const scene: SceneCard = {
  card_type: 'scene',
  meta: baseMeta('s1', 'scene/v1', '酒馆'),
  type: 'physical',
  description: '雨夜酒馆',
};

const item: ItemCard = {
  card_type: 'item',
  meta: baseMeta('i1', 'item/v1', '月光剑'),
  type: 'weapon',
  description: '',
  function: '发光',
};

const lore: LoreCard = {
  card_type: 'lore',
  meta: baseMeta('l1', 'lore/v1', '铜铃'),
  kind: 'other',
  content: '铜铃是报信之物',
  keys: ['铜铃'],
};

function setup(overrides: Partial<SessionSetup> = {}): SessionSetup {
  return { characters: ['c1'], premise: '', opening_mode: 'self', origin: 'user', ...overrides };
}

function runtime(overrides: Partial<SessionRuntime> = {}): SessionRuntime {
  return { variables: { session: {} }, items: {}, scene_state: {}, ...overrides };
}

test('激活：库级停用优先于一切（任何会话都不参与）', () => {
  const verdict = resolveActivation(character, { setup: setup(), runtime: runtime(), libraryEnabled: false });
  assert.deepEqual(verdict, { active: false, code: 'library-disabled' });
});

test('激活：会话例外关掉 → 即使在场也不参与；例外打开 → 即使不在场也参与', () => {
  const off = resolveActivation(character, {
    setup: setup({ overrides: { c1: false } }),
    runtime: runtime(),
  });
  assert.deepEqual(off, { active: false, code: 'override-off' });

  const on = resolveActivation(lore, {
    setup: setup({ overrides: { l1: true } }),
    runtime: runtime(),
    mounted: new Set<string>(),
  });
  assert.deepEqual(on, { active: true, code: 'override-on' });
});

test('激活：角色看在不在场，场景看当前舞台', () => {
  assert.deepEqual(resolveActivation(character, { setup: setup(), runtime: runtime() }), {
    active: true,
    code: 'member',
  });
  assert.deepEqual(resolveActivation(character, { setup: setup({ characters: [] }), runtime: runtime() }), {
    active: false,
    code: 'not-in-session',
  });
  assert.deepEqual(
    resolveActivation(scene, { setup: setup(), runtime: runtime({ current_scene_id: 's1' }) }),
    { active: true, code: 'current-scene' },
  );
  assert.deepEqual(resolveActivation(scene, { setup: setup(), runtime: runtime({ current_scene_id: 'other' }) }), {
    active: false,
    code: 'not-in-session',
  });
});

test('激活：物品看实例是否存在且持有者在场（角色或当前场景）', () => {
  const held = runtime({
    items: { x1: { instance_id: 'x1', item_id: 'i1', holder: 'c1' } },
  });
  assert.deepEqual(resolveActivation(item, { setup: setup(), runtime: held }), {
    active: true,
    code: 'held-item',
  });

  const inScene = runtime({
    current_scene_id: 's1',
    items: { x1: { instance_id: 'x1', item_id: 'i1', holder: 's1' } },
  });
  assert.equal(resolveActivation(item, { setup: setup(), runtime: inScene }).code, 'held-item');

  const elsewhere = runtime({ items: { x1: { instance_id: 'x1', item_id: 'i1', holder: 'stranger' } } });
  assert.deepEqual(resolveActivation(item, { setup: setup(), runtime: elsewhere }), {
    active: false,
    code: 'no-instance',
  });
});

test('激活：典籍只看资源池（关键词命中由扫描器负责），没挂载就不参与', () => {
  assert.deepEqual(
    resolveActivation(lore, { setup: setup(), runtime: runtime(), mounted: new Set(['l1']) }),
    { active: true, code: 'mounted' },
  );
  assert.deepEqual(resolveActivation(lore, { setup: setup(), runtime: runtime(), mounted: new Set(['other']) }), {
    active: false,
    code: 'not-mounted',
  });
  // 没设置资源池 = 全库可用
  assert.equal(resolveActivation(lore, { setup: setup(), runtime: runtime() }).code, 'mounted');
});

test('激活：partitionCards 拆成两批，并把原因带出来（顺序保持输入顺序）', () => {
  const result = partitionCards([character, scene, item, lore], {
    setup: setup({ characters: ['c1'] }),
    runtime: runtime(),
    isLibraryEnabled: (id) => id !== 'i1',
  });
  assert.deepEqual(
    result.active.map((card) => card.meta.id),
    ['c1', 'l1'],
  );
  assert.deepEqual(
    result.inactive.map((entry) => [entry.id, entry.code]),
    [
      ['s1', 'not-in-session'],
      ['i1', 'library-disabled'],
    ],
  );
});
