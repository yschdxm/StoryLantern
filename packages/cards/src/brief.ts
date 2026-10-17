/**
 * brief 投影：存储丰富，注入精简（`docs/specs/世界资源设计文档.md` 第 3 章）。
 *
 * 这里只产出**语义字段**（`BriefField`），不生成中文文案：文案与本地化归界面层，
 * 由界面按 locale 渲染。值为作者数据或运行时值，本模块只做拼接、换名、排序与截断。
 *
 * 确定性：同输入必同输出 —— 不依赖对象键的插入顺序做输出顺序，需要顺序的地方显式排序。
 * 覆盖机制：`card.brief` 非空时**只**输出一条 `brief`（作者/Agent 写过就以它为准）。
 * `meta.description` 是给用户看的简介，不读。
 */

import type { CardDocument } from './index.ts';
import type { CharacterCard } from './types-character.ts';
import type { ItemCard, LoreCard, SceneCard } from './types-world.ts';

export type BriefFieldKey =
  | 'name' | 'summary' | 'traits' | 'mood' | 'state' | 'boundaries'
  | 'atmosphere' | 'exits' | 'occupants' | 'events'
  | 'holder' | 'condition' | 'function'
  | 'content' | 'brief';

export interface BriefField { key: BriefFieldKey; value: string }

export interface BriefProjection { kind: 'character' | 'scene' | 'item' | 'lore'; fields: BriefField[] }

export interface BriefContext {
  /** 运行时变量（取 mood/state 用）：键是 `character:<id>` 或 `session`。 */
  variables?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** 场景卡的显示名（connections/occupants 里存的是 ID，投影要换成名字）。 */
  scene_names?: ReadonlyMap<string, string>;
  character_names?: ReadonlyMap<string, string>;
  /** 物品实例（取 holder/condition）。 */
  items?: ReadonlyArray<{ item_id: string; holder: string; condition?: Readonly<Record<string, unknown>> }>;
}

/** 氛围的固定输出顺序（`other` 不进 brief：它没有稳定语义，留给完整卡）。 */
const ATMOSPHERE_ORDER = ['light', 'sound', 'smell', 'temperature', 'crowd', 'mood'] as const;

/** 典籍 content 的截断长度（超过则加省略号）。 */
const LORE_CONTENT_MAX = 200;

// ---------------------------------------------------------------- 基础工具

/** 把运行时值转成一行文本；空值/对象不输出（`null` 视为「没有值」而不是字符串 "null"）。 */
function toText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim().length > 0 ? value : undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map((item) => toText(item)).filter((item): item is string => item !== undefined);
    return parts.length > 0 ? parts.join(', ') : undefined;
  }
  return undefined;
}

function nameOf(names: ReadonlyMap<string, string> | undefined, id: string): string | undefined {
  const name = names?.get(id);
  return name !== undefined && name.trim().length > 0 ? name : undefined;
}

/** 只推非空字段：空字段不输出，保证 brief 精简。 */
function pushField(fields: BriefField[], key: BriefFieldKey, value: string | undefined): void {
  if (value !== undefined && value.trim().length > 0) fields.push({ key, value });
}

function truncate(value: string | undefined, max: number): string | undefined {
  const text = toText(value);
  if (text === undefined) return undefined;
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

/** `visible_to_user` 为真的变量，按变量名排序保证确定性；值优先运行时，其次卡里的 default。 */
function visibleState(card: CharacterCard, variables: Readonly<Record<string, unknown>> | undefined): string[] {
  const schema = card.state?.schema;
  if (!schema) return [];
  const parts: string[] = [];
  for (const name of Object.keys(schema).sort()) {
    const definition = schema[name];
    if (!definition || definition.visible_to_user !== true) continue;
    const value = variables && Object.hasOwn(variables, name) ? variables[name] : definition.default;
    const text = toText(value);
    if (text !== undefined) parts.push(`${name}=${text}`);
  }
  return parts;
}

// ---------------------------------------------------------------- 各类型投影

/** 角色：name / summary / traits / mood / boundaries / state。 */
function projectCharacter(card: CharacterCard, context: BriefContext, fields: BriefField[]): void {
  const variables = context.variables?.[`character:${card.meta.id}`];
  pushField(fields, 'name', toText(card.identity.name) ?? toText(card.meta.name));
  pushField(fields, 'summary', toText(card.persona.summary));

  const traits = card.persona.traits.map((trait) => trait.trim()).filter((trait) => trait.length > 0);
  if (traits.length > 0) fields.push({ key: 'traits', value: traits.join(', ') });

  pushField(fields, 'mood', toText(variables?.['mood']));

  const boundaries = [card.persona.knowledge_boundary, card.persona.ability_boundary]
    .map((text) => text.trim()).filter((text) => text.length > 0);
  if (boundaries.length > 0) fields.push({ key: 'boundaries', value: boundaries.join(' / ') });

  const state = visibleState(card, variables);
  if (state.length > 0) fields.push({ key: 'state', value: state.join(', ') });
}

/**
 * 场景：name / summary / atmosphere / exits / occupants / events。
 * summary 只认 `appearance.summary`（作者写的 `brief` 覆盖已在入口处理；不读 `meta.description`）。
 */
function projectScene(card: SceneCard, context: BriefContext, fields: BriefField[]): void {
  pushField(fields, 'name', toText(card.meta.name));
  pushField(fields, 'summary', toText(card.appearance?.['summary']));

  const atmosphere = card.atmosphere;
  if (atmosphere) {
    const parts: string[] = [];
    for (const key of ATMOSPHERE_ORDER) {
      const text = toText(atmosphere[key]);
      if (text !== undefined) parts.push(text);
    }
    if (parts.length > 0) fields.push({ key: 'atmosphere', value: parts.join(' / ') });
  }

  const exits = (card.connections ?? [])
    .map((connection) => nameOf(context.scene_names, connection.target) ?? connection.target)
    .filter((name) => name.length > 0);
  if (exits.length > 0) fields.push({ key: 'exits', value: exits.join(', ') });

  const occupants = (card.occupants ?? []).map((occupant) => {
    const name = nameOf(context.character_names, occupant.target) ?? occupant.target;
    return occupant.presence === 'resident' ? name : `${name}(${occupant.presence})`;
  }).filter((name) => name.length > 0);
  if (occupants.length > 0) fields.push({ key: 'occupants', value: occupants.join(', ') });

  for (const event of card.events ?? []) {
    const text = toText(event);
    if (text !== undefined) fields.push({ key: 'events', value: text });
  }
}

/** 物品：name / function / holder / condition（实例层来自 context.items）。 */
function projectItem(card: ItemCard, context: BriefContext, fields: BriefField[]): void {
  pushField(fields, 'name', toText(card.meta.name));
  pushField(fields, 'function', toText(card.function));

  const instance = context.items?.find((candidate) => candidate.item_id === card.meta.id);
  if (!instance) return;

  // 持有者只在能换成角色/场景显示名时输出；换不到名字说明上下文不完整，宁可不写。
  pushField(fields, 'holder', nameOf(context.character_names, instance.holder) ?? nameOf(context.scene_names, instance.holder));
  const condition = instance.condition;
  if (condition) {
    const parts = Object.keys(condition).sort().flatMap((key) => {
      const text = toText(condition[key]);
      return text === undefined ? [] : [`${key}=${text}`];
    });
    if (parts.length > 0) fields.push({ key: 'condition', value: parts.join(', ') });
  }
}

/** 典籍：name / summary 优先，没有 summary 时用截断后的 content。 */
function projectLore(card: LoreCard, fields: BriefField[]): void {
  pushField(fields, 'name', toText(card.meta.name));
  const summary = toText(card.summary);
  if (summary !== undefined) {
    fields.push({ key: 'summary', value: summary });
    return;
  }
  const content = truncate(card.content, LORE_CONTENT_MAX);
  if (content !== undefined) fields.push({ key: 'content', value: content });
}

// ---------------------------------------------------------------- 入口

export function projectBrief(card: CardDocument, context: BriefContext = {}): BriefProjection {
  if (card.brief !== undefined && card.brief.trim().length > 0) {
    return { kind: card.card_type, fields: [{ key: 'brief', value: card.brief }] };
  }
  const fields: BriefField[] = [];
  switch (card.card_type) {
    case 'character': projectCharacter(card, context, fields); break;
    case 'scene': projectScene(card, context, fields); break;
    case 'item': projectItem(card, context, fields); break;
    case 'lore': projectLore(card, fields); break;
    default: break;
  }
  return { kind: card.card_type, fields };
}
