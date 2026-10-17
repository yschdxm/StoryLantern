/**
 * 角色编辑器的**表单态 ↔ 卡片**辅助：卡片 → 草稿、状态变量表格 ↔ `state.schema`。
 *
 * 为什么不在 `data/character-compat.ts`：那个文件已贴近 400 行门禁，而这里的形态
 * （文本输入框里的默认值/最小/最大值）是**编辑器 UI 的**中间态，不是领域模型。
 * 纯逻辑仍然可单测；`CharacterEditScreen` 与 `AdvancedSections` 共用这一份转换。
 */

import type {
  CharacterCard,
  StateSchema,
  StateValue,
  StateVarDef,
  StateVarType,
} from '../../../../../packages/cards/src/index.ts';
import {
  DEFAULT_STATE_UPDATE_POLICY,
  type CharacterCardDraft,
} from '../../data/character-compat.ts';
import { draftsToVisuals, visualsToDrafts, type VisualDraft } from '../../data/visuals-form.ts';
import { attachRules, draftsToRules, rulesToDrafts, type RuleDraft } from '../../data/rules-form.ts';

/** 状态变量表格的一行（默认值在界面上是文本，保存时按 type 解析）。 */
export interface StateVariableDraft {
  name: string;
  type: StateVarType;
  defaultText: string;
  min: string;
  max: string;
  visible: boolean;
}

const copyList = (items: readonly string[] | undefined): string[] | undefined =>
  items === undefined ? undefined : [...items];

/** 角色的视觉设定 → 草稿（顺序保持、未知字段挂 raw）。 */
export function visualDraftsOf(card: CharacterCard): VisualDraft[] {
  return visualsToDrafts(card.visuals);
}

/** 把视觉草稿挂回卡片；全部删除时移除 `visuals` 字段（不写空数组）。 */
export function attachVisuals(card: CharacterCard, drafts: readonly VisualDraft[]): CharacterCard {
  const visuals = draftsToVisuals(drafts);
  if (visuals.length === 0) {
    const { visuals: _ignored, ...rest } = card;
    return rest;
  }
  return { ...card, visuals };
}

/** 角色规则 → 草稿（条件按行展开、动作保留 raw）。 */
export function ruleDraftsOf(card: CharacterCard): RuleDraft[] {
  return rulesToDrafts(card.rules);
}

/** 把规则草稿挂回卡片；全部删除时移除 `rules` 字段。 */
export function attachRulesToCard(card: CharacterCard, drafts: readonly RuleDraft[]): CharacterCard {
  return attachRules(card, draftsToRules(drafts));
}

/** 卡片 → 编辑器草稿（示例对话 / 状态变量由调用方另取）。 */
export function draftOfCard(card: CharacterCard): CharacterCardDraft {
  return {
    id: card.meta.id,
    name: card.identity.name,
    description: card.meta.description,
    background: card.identity.background,
    appearanceSummary: card.appearance?.summary,
    personalitySummary: card.persona.summary,
    traits: [...card.persona.traits],
    goals: copyList(card.persona.goals),
    fears: copyList(card.persona.fears),
    taboos: copyList(card.persona.taboos),
    knowledgeBoundary: card.persona.knowledge_boundary,
    abilityBoundary: card.persona.ability_boundary,
    mood: card.persona.default_mood,
    speechStyle: card.speech.style,
    tone: card.speech.tone,
    vocabulary: copyList(card.speech.vocabulary),
    forbiddenWords: copyList(card.speech.forbidden_words),
    narrationStyle: card.speech.narration_style,
    exampleLines: copyList(card.speech.example_lines),
    systemExtra: card.prompts?.system_extra,
    roleplayRules: copyList(card.prompts?.roleplay_rules),
    styleGuide: card.prompts?.style_guide,
    brief: card.brief,
    tags: copyList(card.meta.tags),
    rating: card.meta.rating,
    language: card.meta.language,
    occupation: card.identity.occupation,
    species: card.identity.species,
    age: card.identity.age,
    gender: card.identity.gender,
    location: card.identity.location,
  };
}

function defaultValueText(value: StateValue | undefined): string {
  if (value === undefined || value === null) return '';
  return Array.isArray(value) ? value.join(', ') : String(value);
}

export function stateVariableDraftsOf(state: StateSchema | undefined): StateVariableDraft[] {
  if (state === undefined) return [];
  return Object.entries(state.schema).map(([name, definition]) => ({
    name,
    type: definition.type,
    defaultText: defaultValueText(definition.default),
    min: definition.min === undefined ? '' : String(definition.min),
    max: definition.max === undefined ? '' : String(definition.max),
    visible: definition.visible_to_user !== false,
  }));
}

function parseDefault(type: StateVarType, text: string): StateValue {
  if (type === 'boolean') return text.trim().toLowerCase() === 'true';
  if (type === 'integer') return Number.isFinite(Number(text.trim())) ? Math.round(Number(text.trim())) : 0;
  if (type === 'array') {
    return text
      .split(/[\n\r,，]/)
      .map((item) => item.trim())
      .filter((item) => item !== '');
  }
  return text;
}

/** 表格行 → `state.schema`；没有任何命名变量时返回 undefined（不写空的 state）。 */
export function stateSchemaOfDrafts(drafts: readonly StateVariableDraft[]): StateSchema | undefined {
  const schema: Record<string, StateVarDef> = {};
  for (const draft of drafts) {
    const name = draft.name.trim();
    if (name === '') continue;
    const definition: StateVarDef = {
      type: draft.type,
      default: parseDefault(draft.type, draft.defaultText),
      visible_to_user: draft.visible,
    };
    if (draft.type === 'integer') {
      const min = Number(draft.min.trim());
      const max = Number(draft.max.trim());
      if (draft.min.trim() !== '' && Number.isFinite(min)) definition.min = min;
      if (draft.max.trim() !== '' && Number.isFinite(max)) definition.max = max;
    }
    schema[name] = definition;
  }
  return Object.keys(schema).length === 0 ? undefined : { schema, update_policy: DEFAULT_STATE_UPDATE_POLICY };
}
