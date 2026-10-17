/**
 * 世界资源编辑器（场景 / 物品 / 典籍）的**纯表单逻辑**：草稿 ↔ 卡片。
 *
 * 不 import React（可在 Node 里穷举）。`buildCard` 只覆盖表单拥有的字段，
 * 保留 visuals / refs / agent / compat / extensions / item.behaviors 等表单不编辑的内容；
 * 空行保存前丢弃，触发词去空白去重。设计见 `docs/specs/世界资源设计文档.md` 第 4、5、6 章。
 */

import {
  CARD_SCHEMA, type CardAppearance, type CardDocument, type CardMeta, type ItemCard,
  type ItemDurability, type ItemKind, type ItemRarity, type ItemUsability, type ItemValue,
  type LoreCard, type LoreKind, type LoreLogic, type LoreTrigger, type OccupantPresence,
  type Rating, type SceneCard, type SceneConnection, type SceneKind, type SceneOccupant,
  type SceneProp, type StateValue,
} from '../../../../../packages/cards/src/index.ts';
import { ulid } from '../../../../../packages/oplog/src/index.ts';
import type { WorldKind } from '../../app/router.ts';

export type WorldCard = SceneCard | ItemCard | LoreCard;
/** 三态下拉（未设置 / 是 / 否）：可选布尔字段在表单里的中间态。 */
export type TriState = 'unset' | 'yes' | 'no';
/** 外观/氛围按"字段名 → 文本"存；字段清单与卡片 appearance 的键一致。 */
export type FieldTextMap = Record<string, string>;

export interface DraftCommon {
  id?: string;
  name: string;
  description: string; // → meta.description（给用户看的一句话）
  tags: string; // 逗号分隔 → meta.tags
  aliases: string; // 逗号分隔 → meta.aliases
  rating: Rating;
  language: string;
  brief: string; // → brief；留空由结构化字段合成
}

export interface SceneConnectionDraft { target: string; direction: 'both' | 'one_way'; how: string; condition: string }
export interface SceneOccupantDraft { target: string; presence: OccupantPresence; when: string; note: string }
export interface ScenePropDraft { itemId: string; note: string }
/** `raw` 保留原卡的类型（数字/布尔/数组）；值文本没改时保存回原值，不把 `3` 变成 `"3"`。 */
export interface StatePairDraft { key: string; value: string; raw?: StateValue }
export interface ItemValueDraft { currency: string; amount: string; tradable: TriState }
export interface ItemUsabilityDraft { condition: string; maxUses: string }
export interface ItemDurabilityDraft { max: string; repairable: TriState; breakEffect: string }
export interface LoreTriggerDraft { constant: boolean; priority: string; probability: string; recursive: boolean; depth: string; conditions: string }

export const SCENE_APPEARANCE_FIELDS = ['summary', 'structure', 'scale', 'materials', 'other'] as const;
export const ATMOSPHERE_FIELDS = ['light', 'sound', 'smell', 'temperature', 'crowd', 'mood', 'other'] as const;
export const ITEM_APPEARANCE_FIELDS = ['summary', 'form', 'material', 'size', 'mark', 'condition_note', 'other'] as const;

export interface SceneDraft extends DraftCommon {
  kind: 'scene'; type: SceneKind; sceneDescription: string; // → scene.description
  appearance: FieldTextMap; atmosphere: FieldTextMap;
  connections: SceneConnectionDraft[]; occupants: SceneOccupantDraft[]; props: ScenePropDraft[];
  events: string; // 一行一条
  defaultState: StatePairDraft[]; isEntry: boolean;
}

export interface ItemDraft extends DraftCommon {
  kind: 'item'; type: ItemKind;
  descriptionText: string; // → item.description
  functionText: string; // → item.function
  rarity: ItemRarity | '';
  value: ItemValueDraft; usability: ItemUsabilityDraft; durability: ItemDurabilityDraft; appearance: FieldTextMap;
}

export interface LoreDraft extends DraftCommon {
  kind: 'lore'; loreKind: LoreKind; content: string; summary: string;
  keys: string; // 逗号分隔 → keys
  secondaryKeys: string; // 逗号分隔 → secondary_keys
  logic: LoreLogic; trigger: LoreTriggerDraft;
}

export type WorldCardDraft = SceneDraft | ItemDraft | LoreDraft;

/** 引用下拉的可选项（来自库里其它卡片）。 */
export interface WorldReferenceOption { id: string; name: string }
export interface WorldReferenceOptions { scenes: WorldReferenceOption[]; characters: WorldReferenceOption[]; items: WorldReferenceOption[] }

// ---------------------------------------------------------------- 文本 ↔ 数组

/** 逗号/顿号/换行分隔：去空白、保序去重（触发词、标签、别名共用）。 */
export function splitKeyList(text: string): string[] {
  return [...new Set(text.split(/[,，、\n]/).map((item) => item.trim()).filter((item) => item !== ''))];
}

/** 一行一条：去空白、丢空行（不去重）。 */
export function splitLineList(text: string): string[] {
  return text.split(/\r?\n/).map((item) => item.trim()).filter((item) => item !== '');
}

export const joinKeyList = (items: readonly string[] | undefined): string => (items ?? []).join(', ');
export const joinLineList = (items: readonly string[] | undefined): string => (items ?? []).join('\n');

function optionalText(text: string): string | undefined {
  const clean = text.trim();
  return clean === '' ? undefined : clean;
}

function maybeText<K extends string>(key: K, text: string): Partial<Record<K, string>> {
  const clean = optionalText(text);
  return clean === undefined ? {} : ({ [key]: clean } as Partial<Record<K, string>>);
}

function maybeNumber(text: string): number | undefined {
  const clean = text.trim();
  if (clean === '') return undefined;
  const value = Number(clean);
  return Number.isFinite(value) ? value : undefined;
}

function stateTextOf(value: StateValue): string {
  if (value === null) return '';
  return Array.isArray(value) ? value.join(', ') : String(value);
}

function pickFields<T extends object>(source: T | undefined, fields: readonly string[]): FieldTextMap {
  const out: FieldTextMap = {};
  const record = source as Readonly<Record<string, unknown>> | undefined;
  for (const key of fields) out[key] = typeof record?.[key] === 'string' ? String(record[key]) : '';
  return out;
}

function nonEmptyFields(fields: FieldTextMap): FieldTextMap | undefined {
  const out: FieldTextMap = {};
  for (const [key, value] of Object.entries(fields)) {
    const clean = optionalText(value);
    if (clean !== undefined) out[key] = clean;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

// ---------------------------------------------------------------- 空草稿

/** 新卡片的初始表单：必填项留空（交给校验器提示），枚举给合理默认值。 */
export function emptyWorldDraft(kind: WorldKind): WorldCardDraft {
  const common: DraftCommon = { name: '', description: '', tags: '', aliases: '', rating: 'general', language: 'zh-CN', brief: '' };
  if (kind === 'scene') {
    return { ...common, kind: 'scene', type: 'physical', sceneDescription: '', appearance: pickFields(undefined, SCENE_APPEARANCE_FIELDS), atmosphere: pickFields(undefined, ATMOSPHERE_FIELDS), connections: [], occupants: [], props: [], events: '', defaultState: [], isEntry: false };
  }
  if (kind === 'item') {
    return { ...common, kind: 'item', type: 'other', descriptionText: '', functionText: '', rarity: '', value: { currency: '', amount: '', tradable: 'unset' }, usability: { condition: '', maxUses: '' }, durability: { max: '', repairable: 'unset', breakEffect: '' }, appearance: pickFields(undefined, ITEM_APPEARANCE_FIELDS) };
  }
  return { ...common, kind: 'lore', loreKind: 'other', content: '', summary: '', keys: '', secondaryKeys: '', logic: 'any', trigger: { constant: false, priority: '5', probability: '100', recursive: true, depth: '', conditions: '' } };
}

// ---------------------------------------------------------------- 卡片 → 草稿

function draftCommonOf(card: WorldCard): DraftCommon {
  return {
    id: card.meta.id, name: card.meta.name, description: card.meta.description,
    tags: joinKeyList(card.meta.tags), aliases: joinKeyList(card.meta.aliases),
    rating: card.meta.rating, language: card.meta.language, brief: card.brief ?? '',
  };
}

export function draftOfCard(card: WorldCard): WorldCardDraft {
  if (card.card_type === 'scene') {
    return {
      ...draftCommonOf(card), kind: 'scene', type: card.type, sceneDescription: card.description,
      appearance: pickFields(card.appearance, SCENE_APPEARANCE_FIELDS),
      atmosphere: pickFields(card.atmosphere, ATMOSPHERE_FIELDS),
      connections: (card.connections ?? []).map((item) => ({ target: item.target, direction: item.direction ?? 'both', how: item.how ?? '', condition: item.condition ?? '' })),
      occupants: (card.occupants ?? []).map((item) => ({ target: item.target, presence: item.presence, when: item.when ?? '', note: item.note ?? '' })),
      props: (card.props ?? []).map((item) => ({ itemId: item.item_id, note: item.note ?? '' })),
      events: joinLineList(card.events),
      defaultState: Object.entries(card.default_state ?? {}).map(([key, value]) => ({ key, value: stateTextOf(value), raw: value })),
      isEntry: card.is_entry === true,
    };
  }
  if (card.card_type === 'item') {
    const value = card.value;
    const usability = card.usability;
    const durability = card.durability;
    return {
      ...draftCommonOf(card), kind: 'item', type: card.type, descriptionText: card.description, functionText: card.function,
      rarity: card.rarity ?? '',
      value: {
        currency: value?.currency ?? '',
        amount: value?.amount === undefined ? '' : String(value.amount),
        tradable: value?.tradable === undefined ? 'unset' : value.tradable ? 'yes' : 'no',
      },
      usability: {
        condition: usability?.condition ?? '',
        maxUses: usability?.max_uses === undefined ? '' : String(usability.max_uses),
      },
      durability: {
        max: durability?.max === undefined ? '' : String(durability.max),
        repairable: durability?.repairable === undefined ? 'unset' : durability.repairable ? 'yes' : 'no',
        breakEffect: durability?.break_effect ?? '',
      },
      appearance: pickFields(card.appearance, ITEM_APPEARANCE_FIELDS),
    };
  }
  const trigger = card.trigger;
  return {
    ...draftCommonOf(card), kind: 'lore', loreKind: card.kind, content: card.content,
    summary: card.summary ?? '', keys: joinKeyList(card.keys), secondaryKeys: joinKeyList(card.secondary_keys),
    logic: card.logic ?? 'any',
    trigger: {
      constant: trigger?.constant === true,
      priority: trigger?.priority === undefined ? '5' : String(trigger.priority),
      probability: trigger?.probability === undefined ? '100' : String(trigger.probability),
      recursive: trigger?.recursive !== false,
      depth: trigger?.depth === undefined ? '' : String(trigger.depth),
      conditions: joinLineList(trigger?.conditions),
    },
  };
}

// ---------------------------------------------------------------- 草稿 → 卡片

/** 只写 owned 里的键；值为 undefined 表示"删除该字段"，其余从 existing 原样保留。 */
function applyOwned<T extends WorldCard>(existing: T | undefined, owned: Record<string, unknown>): T {
  const next: Record<string, unknown> = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(owned)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as T;
}

function commonMeta(existing: WorldCard | undefined, draft: WorldCardDraft): CardMeta {
  const tags = splitKeyList(draft.tags);
  const aliases = splitKeyList(draft.aliases);
  const meta: Record<string, unknown> = {
    ...existing?.meta,
    id: draft.id ?? existing?.meta.id ?? ulid(),
    schema: CARD_SCHEMA[draft.kind],
    name: draft.name.trim(),
    version: existing?.meta.version ?? '1.0.0',
    language: optionalText(draft.language) ?? existing?.meta.language ?? 'zh-CN',
    rating: draft.rating,
    description: draft.description.trim(),
    ...(tags.length === 0 ? {} : { tags }),
    ...(aliases.length === 0 ? {} : { aliases }),
  };
  if (tags.length === 0) delete meta['tags'];
  if (aliases.length === 0) delete meta['aliases'];
  return meta as unknown as CardMeta;
}

function commonOwned(existing: WorldCard | undefined, draft: WorldCardDraft): Record<string, unknown> {
  return { meta: commonMeta(existing, draft), brief: optionalText(draft.brief) };
}

function buildAppearance(previous: CardAppearance | undefined, fields: FieldTextMap): CardAppearance | undefined {
  const next: Record<string, string> = { ...previous };
  for (const [key, value] of Object.entries(fields)) {
    const clean = optionalText(value);
    if (clean === undefined) delete next[key];
    else next[key] = clean;
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

function buildScene(existing: SceneCard | undefined, draft: SceneDraft): SceneCard {
  const connections = draft.connections.flatMap((row, index): SceneConnection[] => {
    const target = row.target.trim();
    if (target === '') return [];
    const transition = existing?.connections?.[index]?.transition;
    return [{ target, direction: row.direction, ...maybeText('how', row.how), ...maybeText('condition', row.condition), ...(transition === undefined ? {} : { transition }) }];
  });
  const occupants = draft.occupants.flatMap((row): SceneOccupant[] => {
    const target = row.target.trim();
    return target === '' ? [] : [{ target, presence: row.presence, ...maybeText('when', row.when), ...maybeText('note', row.note) }];
  });
  const props = draft.props.flatMap((row): SceneProp[] => {
    const itemId = row.itemId.trim();
    return itemId === '' ? [] : [{ item_id: itemId, ...maybeText('note', row.note) }];
  });
  const defaultState: Record<string, StateValue> = {};
  for (const row of draft.defaultState) {
    const key = row.key.trim();
    if (key === '') continue;
    // 值文本没改时写回原类型（数字/布尔/数组），不要因为过了一次表单就变成字符串
    defaultState[key] = row.raw !== undefined && stateTextOf(row.raw) === row.value ? row.raw : row.value;
  }
  const events = splitLineList(draft.events);
  return applyOwned<SceneCard>(existing, {
    ...commonOwned(existing, draft), card_type: 'scene', type: draft.type, description: draft.sceneDescription.trim(),
    appearance: buildAppearance(existing?.appearance, draft.appearance),
    atmosphere: nonEmptyFields(draft.atmosphere),
    connections: connections.length === 0 ? undefined : connections,
    occupants: occupants.length === 0 ? undefined : occupants,
    props: props.length === 0 ? undefined : props,
    events: events.length === 0 ? undefined : events,
    default_state: Object.keys(defaultState).length === 0 ? undefined : defaultState,
    is_entry: draft.isEntry ? true : undefined,
  });
}

type FieldSpec = [key: string, value: string | number | boolean | undefined, kind: 'string' | 'count' | 'boolean'];

/** 在 previous 上增删若干字段，全空则返回 undefined（不写空对象）。 */
function buildOptionalObject<T>(previous: T | undefined, specs: readonly FieldSpec[]): T | undefined {
  const next: Record<string, unknown> = { ...previous };
  for (const [key, value, kind] of specs) {
    if (value === undefined) delete next[key];
    else next[key] = kind === 'count' ? Math.max(0, Math.round(Number(value))) : value;
  }
  return Object.keys(next).length === 0 ? undefined : (next as unknown as T);
}

function buildItemValue(draft: ItemValueDraft): ItemValue | undefined {
  const currency = optionalText(draft.currency);
  const amount = maybeNumber(draft.amount);
  const tradable = draft.tradable === 'unset' ? undefined : draft.tradable === 'yes';
  if (currency === undefined && amount === undefined && tradable === undefined) return undefined;
  return { ...(currency === undefined ? {} : { currency }), ...(amount === undefined ? {} : { amount }), ...(tradable === undefined ? {} : { tradable }) };
}

function buildItem(existing: ItemCard | undefined, draft: ItemDraft): ItemCard {
  const usability = buildOptionalObject<ItemUsability>(existing?.usability, [
    ['condition', optionalText(draft.usability.condition), 'string'],
    ['max_uses', maybeNumber(draft.usability.maxUses), 'count'],
  ]);
  const durability = buildOptionalObject<ItemDurability>(existing?.durability, [
    ['max', maybeNumber(draft.durability.max), 'count'],
    ['break_effect', optionalText(draft.durability.breakEffect), 'string'],
    ['repairable', draft.durability.repairable === 'unset' ? undefined : draft.durability.repairable === 'yes', 'boolean'],
  ]);
  return applyOwned<ItemCard>(existing, {
    ...commonOwned(existing, draft), card_type: 'item', type: draft.type,
    description: draft.descriptionText.trim(), function: draft.functionText.trim(),
    rarity: draft.rarity === '' ? undefined : draft.rarity,
    appearance: buildAppearance(existing?.appearance, draft.appearance),
    value: buildItemValue(draft.value), usability, durability,
  });
}

function buildLore(existing: LoreCard | undefined, draft: LoreDraft): LoreCard {
  const keys = splitKeyList(draft.keys);
  const secondary = splitKeyList(draft.secondaryKeys);
  const conditions = splitLineList(draft.trigger.conditions);
  const depth = maybeNumber(draft.trigger.depth);
  const trigger: LoreTrigger = {
    ...existing?.trigger,
    constant: draft.trigger.constant,
    priority: maybeNumber(draft.trigger.priority) ?? 5,
    probability: maybeNumber(draft.trigger.probability) ?? 100,
    recursive: draft.trigger.recursive,
    ...(depth === undefined ? {} : { depth: Math.max(0, Math.round(depth)) }),
    ...(conditions.length === 0 ? {} : { conditions }),
  };
  return applyOwned<LoreCard>(existing, {
    ...commonOwned(existing, draft), card_type: 'lore', kind: draft.loreKind,
    content: draft.content.trim(), summary: optionalText(draft.summary),
    keys: keys.length === 0 ? undefined : keys,
    secondary_keys: secondary.length === 0 ? undefined : secondary,
    logic: draft.logic, trigger,
  });
}

/** 草稿 → 卡片。`existing` 只为保留表单不编辑的字段；新建时传 undefined。 */
export function buildCard(existing: WorldCard | undefined, draft: WorldCardDraft): WorldCard {
  if (draft.kind === 'scene') return buildScene(existing?.card_type === 'scene' ? existing : undefined, draft);
  if (draft.kind === 'item') return buildItem(existing?.card_type === 'item' ? existing : undefined, draft);
  return buildLore(existing?.card_type === 'lore' ? existing : undefined, draft);
}

/** 引用下拉的可选项：从库里的全部卡片按类型挑（只用 id/name，不复制内容）。 */
export function referenceOptionsOf(cards: readonly CardDocument[]): WorldReferenceOptions {
  const out: WorldReferenceOptions = { scenes: [], characters: [], items: [] };
  for (const card of cards) {
    const option = { id: card.meta.id, name: card.meta.name };
    if (card.card_type === 'scene') out.scenes.push(option);
    else if (card.card_type === 'item') out.items.push(option);
    else if (card.card_type === 'character') out.characters.push(option);
  }
  return out;
}
