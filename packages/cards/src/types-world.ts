/**
 * 三类世界资源 + 世界包：`docs/specs/世界资源设计文档.md`（v0.2）。
 *
 * 与设计文档的差异（ADR-0011 记录）：
 *  - `scene.connections[].target` / `occupants[].target` / `props[].item_id` 一律是**卡片 ID**；
 *    解析不到时校验器报 warning（不是 error）：世界包可以分批导入。
 *  - `item.tags` 删除，统一用 `meta.tags`。
 *  - 典籍（lore）保留酒馆世界书的关键词触发：这是唯一适合关键词触发的一类（文档 6.5 的结论）。
 */

import type { CardBase, CardRef, StateValue } from './types-base.ts';
import type { CardRule } from './types-character.ts';

// ---------------------------------------------------------------- 场景簿

export type SceneKind = 'physical' | 'abstract' | 'vehicle' | 'dimension';

/** 结构化氛围：可以被局部更新（下雨了只改 `sound`/`smell`），而不是整段重写。 */
export interface Atmosphere {
  light?: string;
  sound?: string;
  smell?: string;
  temperature?: string;
  crowd?: string;
  mood?: string;
  other?: string;
}

export interface SceneConnection {
  target: string;
  /** 默认 `both`。 */
  direction?: 'both' | 'one_way';
  how?: string;
  /** 前提条件表达式源码（需钥匙、需特定状态）。 */
  condition?: string;
  transition?: string;
}

export type OccupantPresence = 'resident' | 'frequent' | 'occasional' | 'rare';

export interface SceneOccupant {
  target: string;
  presence: OccupantPresence;
  /** 出现条件表达式源码（白天、雨夜、有玩家在时）。 */
  when?: string;
  note?: string;
}

export interface SceneProp {
  item_id: string;
  note?: string;
}

export interface SceneCard extends CardBase {
  card_type: 'scene';
  type: SceneKind;
  /** 供 LLM 的完整描述。 */
  description: string;
  atmosphere?: Atmosphere;
  /** 默认公开状态（天气、时间、张力）。 */
  default_state?: Readonly<Record<string, StateValue>>;
  connections?: readonly SceneConnection[];
  occupants?: readonly SceneOccupant[];
  /** 一句话的轻量事件；复杂的走第二版的 event 卡。 */
  events?: readonly string[];
  props?: readonly SceneProp[];
  /** 是否适合作为会话起始场景。 */
  is_entry?: boolean;
}

// ---------------------------------------------------------------- 物品图鉴

export type ItemKind =
  | 'weapon'
  | 'armor'
  | 'consumable'
  | 'quest'
  | 'tool'
  | 'clothing'
  | 'accessory'
  | 'vehicle'
  | 'key_item'
  | 'material'
  | 'other';

export type ItemRarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'unique';

export interface ItemValue {
  currency?: string;
  amount?: number;
  tradable?: boolean;
}

export interface ItemUsability {
  /** 谁能用（角色 ID 或 `any`）。 */
  holders?: readonly string[];
  condition?: string;
  /** 使用次数上限（不填 = 不限）。 */
  max_uses?: number;
}

export interface ItemDurability {
  max?: number;
  repairable?: boolean;
  /** 损毁后果描述。 */
  break_effect?: string;
}

export interface ItemCard extends CardBase {
  card_type: 'item';
  type: ItemKind;
  description: string;
  /** 效果描述（供 LLM 理解用途）。 */
  function: string;
  /** 物品行为规则（会低语的魔剑），与角色规则共用同一套结构。 */
  behaviors?: readonly CardRule[];
  value?: ItemValue;
  rarity?: ItemRarity;
  usability?: ItemUsability;
  durability?: ItemDurability;
}

/** @deprecated 旧名：物品行为现在就是 `CardRule`（与角色规则同一套结构）。 */
export type CardRuleLike = CardRule;

// ---------------------------------------------------------------- 典籍

export type LoreKind = 'rule' | 'history' | 'faction' | 'race' | 'culture' | 'geography' | 'tech' | 'other';

export type LoreLogic = 'any' | 'all' | 'not';

export interface LoreTrigger {
  /** 常驻：始终注入。 */
  constant?: boolean;
  /** 冲突时高者胜。 */
  priority?: number;
  /** 触发概率 0-100（确定性测试里会被固定为 100）。 */
  probability?: number;
  /** 是否允许二次触发（命中内容再参与匹配）。 */
  recursive?: boolean;
  /** 注入字符预算（单条）。 */
  token_budget?: number;
  /** 深度窗口：注入位置/匹配窗口，语义与旧世界书 `depth` 一致。 */
  depth?: number;
  /** 变量条件表达式源码数组。 */
  conditions?: readonly string[];
}

export interface LoreCard extends CardBase {
  card_type: 'lore';
  kind: LoreKind;
  /** 注入内容，必须能独立成立。 */
  content: string;
  /** 一句话概述（进 brief）。 */
  summary?: string;
  /** 主触发词（子串匹配）。 */
  keys: readonly string[];
  secondary_keys?: readonly string[];
  logic?: LoreLogic;
  trigger?: LoreTrigger;
  /**
   * 条目级启停（缺省 = 启用）：关掉后不参与扫描。
   *
   * 与**库级启停**（`card.library` op）的区别：库级是"这张卡退役/草稿，任何会话都不用"；
   * 这里是"条目先留着，但这一版先别注入"。放在卡片里是因为它属于作者的设定语义，
   * 跟着卡片同步/导出；库级是使用者的库状态，不随卡片导出。
   */
  enabled?: boolean;
}

// ---------------------------------------------------------------- 世界包（发布单位，不是卡片类型）

export interface WorldPackManifest {
  schema: string;
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  language: string;
  tags?: readonly string[];
  /** 包内包含的卡片 ID（不内嵌卡片本体：卡片是独立资产）。 */
  card_ids: readonly string[];
  created_at?: number;
  updated_at?: number;
}

/**
 * 交叉引用的一致性检查：引用目标是"卡片 ID"而不是名字。
 * 返回**无法解析**的引用（调用方决定 warn 还是 block；保存时一般只 warn）。
 */
export function danglingRefs(card: SceneCard | ItemCard | LoreCard | { refs?: readonly CardRef[] }, known: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const ref of card.refs ?? []) {
    if (!known.has(ref.target)) out.push(ref.target);
  }
  return out;
}
