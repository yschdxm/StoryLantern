import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPromptBlockDataV2 } from '../src/data/prompt-v2.ts';
import { renderRulesSection } from '../src/data/prompt-blocks-v2.ts';
import { loreTextOf } from '../src/data/prompt-lore.ts';
import type {
  CardMeta,
  CharacterCard,
  LoreCard,
  SessionRuntime,
  SessionSetup,
} from '../../../packages/cards/src/index.ts';

/**
 * 条件求值接进装配的验收：
 *  - 角色规则的 `when.conditions` 用运行时变量求值（真→注入，假/错→跳过并计数）；
 *  - 典籍的 `trigger.conditions` 同上；`enabled:false` 的条目直接不参与；
 *  - 旧迁移的 `legacy-disabled` 标记也当停用处理（过渡兼容）。
 */

function meta(id: string, schema: string, name: string): CardMeta {
  return { id, schema, name, version: '1.0.0', language: 'zh-CN', rating: 'general', description: '简介' };
}

function character(rules: CharacterCard['rules']): CharacterCard {
  return {
    card_type: 'character',
    meta: meta('c1', 'rolecard/v1', '星野'),
    identity: { name: '星野', background: '' },
    persona: { summary: '', traits: [], knowledge_boundary: '', ability_boundary: '' },
    speech: { style: '' },
    ...(rules === undefined ? {} : { rules }),
  };
}

function lore(id: string, overrides: Partial<LoreCard> = {}): LoreCard {
  return {
    card_type: 'lore',
    meta: meta(id, 'lore/v1', id),
    kind: 'other',
    content: `${id} 的正文`,
    keys: ['铜铃'],
    ...overrides,
  };
}

function setup(characters: readonly string[] = ['c1']): SessionSetup {
  return { characters, premise: '', opening_mode: 'self', origin: 'user' };
}

function runtime(variables: Record<string, Record<string, number | string | boolean>> = {}): SessionRuntime {
  return {
    variables: { session: {}, ...(variables as SessionRuntime['variables']) },
    items: {},
    scene_state: {},
  };
}

const history = [{ role: 'user' as const, content: '铜铃响了吗' }];

test('规则条件：为真时注入，为假时不注入并计数', () => {
  const rules = [
    {
      id: 'r1',
      enabled: true,
      priority: 10,
      when: { event: 'before_prompt' as const, conditions: ['affection >= 70'] },
      actions: [{ type: 'constraint' as const, text: '软化语气' }],
    },
  ];
  const data = createPromptBlockDataV2({
    custom: '',
    setup: setup(),
    cards: [character(rules)],
    runtime: runtime({ 'character:c1': { affection: 80 } }),
    history,
  });
  assert.equal(renderRulesSection(data), '软化语气');
  assert.equal(data.outcomes.rulesOmitted, 0);

  const data2 = createPromptBlockDataV2({
    custom: '',
    setup: setup(),
    cards: [character(rules)],
    runtime: runtime({ 'character:c1': { affection: 10 } }),
    history,
  });
  assert.equal(renderRulesSection(data2), undefined);
  assert.equal(data2.outcomes.rulesOmitted, 1);
});

test('规则条件：未知变量/类型不匹配 → 跳过并计数（不假装生效）', () => {
  for (const condition of ['unknown_flag == true', 'mood >= 3']) {
    const rules = [
      {
        id: 'r1',
        enabled: true,
        priority: 10,
        when: { event: 'before_prompt' as const, conditions: [condition] },
        actions: [{ type: 'constraint' as const, text: '不该出现' }],
      },
    ];
    const data = createPromptBlockDataV2({
      custom: '',
      setup: setup(),
      cards: [character(rules)],
      runtime: runtime({ 'character:c1': { mood: '温柔' } }),
      history,
    });
    assert.equal(renderRulesSection(data), undefined, condition);
    assert.equal(data.outcomes.rulesOmitted, 1, condition);
  }
});

test('规则条件：会话变量可用，角色变量覆盖同名项', () => {
  const rules = [
    {
      id: 'r1',
      enabled: true,
      priority: 10,
      when: { event: 'before_prompt' as const, conditions: ['weather == "雨"', 'affection > 50'] },
      actions: [{ type: 'inject_prompt' as const, text: '描写雨声' }],
    },
  ];
  const data = createPromptBlockDataV2({
    custom: '',
    setup: setup(),
    cards: [character(rules)],
    runtime: runtime({ session: { weather: '雨' }, 'character:c1': { affection: 60 } }),
    history,
  });
  assert.equal(renderRulesSection(data), '描写雨声');
});

test('典籍：enabled=false 的条目直接不参与（并计入未注入）', () => {
  const data = createPromptBlockDataV2({
    custom: '',
    setup: setup(),
    cards: [lore('l1', { enabled: false })],
    runtime: runtime(),
    history,
  });
  assert.equal(loreTextOf(data), undefined);
  assert.equal(data.outcomes.loreDropped, 1);
  assert.equal(data.outcomes.matchedLore.length, 0);
});

test('典籍：条件为真才注入；条件求值失败不注入', () => {
  const hit = lore('l1', { trigger: { conditions: ['affection >= 70'] } });
  const ok = createPromptBlockDataV2({
    custom: '',
    setup: setup(),
    cards: [hit],
    runtime: runtime({ 'character:c1': { affection: 80 } }),
    history,
  });
  assert.ok(loreTextOf(ok)?.includes('l1 的正文'));

  const fail = createPromptBlockDataV2({
    custom: '',
    setup: setup(),
    cards: [hit],
    runtime: runtime({ 'character:c1': { affection: 60 } }),
    history,
  });
  assert.equal(loreTextOf(fail), undefined);
  assert.equal(fail.outcomes.loreDropped, 1);

  const broken = createPromptBlockDataV2({
    custom: '',
    setup: setup(),
    cards: [lore('l2', { trigger: { conditions: ['missing > 1'] } })],
    runtime: runtime(),
    history,
  });
  assert.equal(loreTextOf(broken), undefined);
  assert.equal(broken.outcomes.loreDropped, 1);
});

test('典籍：旧迁移的 legacy-disabled 标记也当停用（过渡兼容）', () => {
  const legacy = lore('l1', { meta: { ...meta('l1', 'lore/v1', 'l1'), tags: ['legacy-disabled'] } });
  const data = createPromptBlockDataV2({
    custom: '',
    setup: setup(),
    cards: [legacy],
    runtime: runtime(),
    history,
  });
  assert.equal(loreTextOf(data), undefined);
  assert.equal(data.outcomes.loreDropped, 1);
});
