/**
 * 统一卡片基座：四类资源（角色 / 场景 / 物品 / 典籍）共享的底座。
 *
 * 设计来源：`docs/specs/世界资源设计文档.md` 第 2 章、`docs/specs/角色卡结构设计文档.md` 第 1、2 章。
 * 本文件只放**与类型无关的公共结构**；各类型的专属字段见 `types-character.ts` / `types-world.ts`。
 *
 * 与设计文档的差异（有意为之，记录在 `docs/adr/ADR-0011-card-model.md`）：
 *  1. `card_type` 只在**顶层**，`meta` 里不再重复（文档两处都写了，会打架）。
 *  2. `appearance` 统一在**基座**（世界资源文档 2.2）；角色卡文档 3.1 写的 `identity.appearance`
 *     是同一个东西，落到基座后不再嵌套两层。
 *  3. `item.tags` 删除：`meta.tags` 已经承担检索，重复字段只会有两个真相。
 *  4. `visuals[].path` / `meta.cover` 必须是 `asset://<sha256>` 引用：绝对路径跨设备必坏。
 */

/** 顶层卡片类型。数据层按**开放枚举**处理（未知类型不许崩），但本实现只认识这四种。 */
export type CardType = 'character' | 'scene' | 'item' | 'lore';

export const CARD_TYPES: readonly CardType[] = ['character', 'scene', 'item', 'lore'];

export type Rating = 'general' | 'teen' | 'mature';

/** 每类卡片的 schema 版本号。升级结构时 +1，并写迁移函数。 */
export const CARD_SCHEMA: Readonly<Record<CardType, string>> = {
  character: 'rolecard/v1',
  scene: 'scene/v1',
  item: 'item/v1',
  lore: 'lore/v1',
};

/** 世界包不是卡片类型：它是发布单位（卡片的集合）。schema 单独一版。 */
export const PACK_SCHEMA = 'worldpack/v1';

export interface CardMeta {
  /** 稳定 ID：本机新建用 ULID，导入的卡**沿用文件里的 id**（否则跨设备引用全断）。 */
  id: string;
  /** 结构版本，例如 `rolecard/v1`。 */
  schema: string;
  name: string;
  /** 别名（检索用；场景/物品尤其需要）。 */
  aliases?: readonly string[];
  /** 卡版本（语义化版本，作者维护）。 */
  version: string;
  author?: string;
  license?: string;
  /** 主语言，例如 `zh-CN`。 */
  language: string;
  tags?: readonly string[];
  rating: Rating;
  content_warnings?: readonly string[];
  /** 给用户看的简介（不是给模型的；给模型的走 `brief`）。 */
  description: string;
  /** 封面：`asset://<sha256>`。 */
  cover?: string;
  created_at?: number;
  updated_at?: number;
}

/** 视觉资产的公共形状（四类共用）。`caption` 必填：纯文本模型读不了图，它是 LLM 唯一入口。 */
export interface VisualAsset {
  id: string;
  /** 开放字符串：`key_art` / `portrait` / `turnaround` / `outfit` / `detail` / `palette` /
   *  `expression_sheet` / `concept` / `background` / `icon` 等，按卡类型取用。 */
  type: string;
  /**
   * 资产引用：**可选**。有图时必须是 `asset://<sha256>`（卡内不内嵌二进制）；
   * 无图时只写 `caption`（描述优先、图片为锚：资产通道接上之前，纯文字设定也能用）。
   */
  path?: string;
  /** 必填：纯文本模型读不了图，caption 是 LLM 唯一入口。 */
  caption: string;
  tags?: readonly string[];
  view?: 'front' | 'side' | 'back' | 'detail';
  /** 绑定状态/服装的表达式源码（例如 `mood == "温柔"`）；表达式语义见规则模块。 */
  binding?: string;
  /** 差分挂到主资产上。 */
  variant_of?: string;
  /** 绘图一致性描述词。 */
  render_prompt?: string;
  is_primary?: boolean;
  notes?: string;
}

export interface CardRef {
  /** 目标卡片 ID（**不是名字**：名字会重名，ID 不会）。 */
  target: string;
  type: string;
  /** 双向引用由引擎维护反向关系。 */
  bidirectional?: boolean;
  description?: string;
}

/** 作者对「哪些字段可以交给 Agent」的显式授权。 */
export interface AgentPolicy {
  autofill_fields?: readonly string[];
  auto_gen_fields?: readonly string[];
  policy: 'allow' | 'ask' | 'deny';
}

export interface CompatInfo {
  /** 来源格式与版本，例如 `sillytavern/v2`。 */
  imported_from?: string;
  imported_at?: number;
  /** 导入时被丢弃的字段名（只留审计，不存值）。 */
  discarded_fields?: readonly string[];
}

/** 结构化外观：字段名按卡类型不同，值统一是文本（见 `APPEARANCE_FIELDS`）。 */
export type CardAppearance = Readonly<Record<string, string>>;

export const APPEARANCE_FIELDS: Readonly<Record<CardType, readonly string[]>> = {
  character: ['summary', 'body', 'face', 'hair', 'eyes', 'signature', 'voice', 'style', 'other'],
  scene: ['summary', 'structure', 'scale', 'materials', 'other'],
  item: ['summary', 'form', 'material', 'size', 'mark', 'condition_note', 'other'],
  lore: ['summary', 'other'],
};

export interface CardBase {
  card_type: CardType;
  meta: CardMeta;
  /** 给模型看的最简投影；作者不写则由 `projectBrief` 从结构化字段合成（**运行时不调模型**）。 */
  brief?: string;
  appearance?: CardAppearance;
  visuals?: readonly VisualAsset[];
  refs?: readonly CardRef[];
  agent?: AgentPolicy;
  compat?: CompatInfo;
  /** 自定义扩展：键必须带命名空间（`vendor.feature`），避免作者之间打架。 */
  extensions?: Readonly<Record<string, unknown>>;
}

/** 状态值（变量、物品 condition 等共用）。 */
export type StateValue = string | number | boolean | readonly string[] | null;

/** 是否是本实现认识的卡片（未知 `card_type` 走"保留但不解释"）。 */
export function isKnownCardType(value: unknown): value is CardType {
  return value === 'character' || value === 'scene' || value === 'item' || value === 'lore';
}

/** `asset://<sha256>` 的判定：路径必须在资产库里，不允许文件系统绝对路径。 */
export function isAssetRef(value: string): boolean {
  return /^asset:\/\/[0-9a-f]{64}$/.test(value);
}
