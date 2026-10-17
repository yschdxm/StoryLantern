/**
 * 会话层：开局配置、运行时补丁、兼容草稿。
 *
 * 关键决定（ADR-0011）：
 *  - 角色/世界是**资产层**（长期、可复用）；会话是**一次性现实**（处境、开场、变量值、物品实例）。
 *  - 变量值与物品实例不放卡片：它们只以 `runtime.patch` 的**补丁序列**存在 op 日志里，
 *    读取时按 HLC 全序重放出当前值。这样并发补丁不会互相覆盖（LWW 字段覆盖会丢增量）。
 *  - 开场结果**不另存一份**：它就是已经落进日志的 `message.append`；
 *    `setup` 只存"怎么开场"（模式/指定者/用户输入），避免两个真相。
 */

import type { StateValue } from './types-base.ts';
import type { OpeningMode, Tone } from './types-enums.ts';

/**
 * 这一局加载的资源池（"注册"的落地形态）。
 *
 * 为什么不给每张卡维护"全局注册 / 会话注册"两份名单：卡片大多应**按类型自动激活**
 * （在场角色 / 当前场景 / 持有物品 / 关键词命中的典籍），手工名单只会腐烂（新增卡忘了挂）。
 * 所以这里只描述**资源池**（加载了哪些包/单卡），"哪张卡参与"由 `activation.ts` 按类型算；
 * 用户要手动干预时用 `overrides`，只记例外。
 */
export interface SessionMounts {
  /** 世界包 ID（包里的卡片进入资源池）。 */
  pack_ids?: readonly string[];
  /** 直接挂载的单卡（不属于任何包，或只想用其中一张）。 */
  card_ids?: readonly string[];
}

/** 开局配置：创建会话时产生，随会话销毁；不属于角色卡，也不属于世界包。 */
export interface SessionSetup {
  /** 会话成员（角色卡 ID，≥1；多个即群聊）。 */
  characters: readonly string[];
  /**
   * 这一局的资源池；**不填 = 全库可用**（轻量用法：只有一个库，不想维护挂载表）。
   * 填了就只在这些包/单卡里激活（多世界包隔离）。
   */
  mounts?: SessionMounts;
  /** 这一局的例外开关：卡片 id -> 是否参与（只存与默认不同的项）。 */
  overrides?: Readonly<Record<string, boolean>>;
  /** @deprecated 旧字段：等价于 `mounts.pack_ids`；保留是为了让已写入的 setup 还能被读。 */
  world_pack_ids?: readonly string[];
  /** 当前舞台（场景卡 ID）；不填 = 自由场景，由 premise 决定。 */
  scene_id?: string;
  /** 时代/地点倾向，例如「低魔中世纪边境」。 */
  setting?: string;
  /** 用户在这一局里是谁。 */
  user_role?: string;
  /** 这一局的处境与切入点（原 `scenario` 里真正属于"这一局"的部分）。 */
  premise: string;
  tone?: Tone;
  /** 覆盖角色卡变量默认值：characterId -> 变量名 -> 值。 */
  init_state?: Readonly<Record<string, Readonly<Record<string, StateValue>>>>;
  suggested_actions?: readonly string[];
  opening_mode: OpeningMode;
  /** `designated` 模式下指定开口的角色。 */
  opening_speaker?: string;
  /** `designated` 的指定文本 / `self` 的用户手写内容。 */
  opening_input?: string;
  /** 处境从哪来（审计用）。 */
  origin: 'card' | 'world' | 'user' | 'generated';
}

/** 物品实例：会话级；定义在图鉴（`ItemCard`），实例在这里。 */
export interface ItemInstance {
  instance_id: string;
  item_id: string;
  /** 持有者：角色卡 ID 或场景卡 ID（放在场景里）。 */
  holder: string;
  /** 当前状态（耐久、充能、诅咒…）。 */
  condition?: Readonly<Record<string, StateValue>>;
  /** 对定义的**本地修改**（只改实例，不碰图鉴）。 */
  changes?: readonly ItemChange[];
  acquired_at?: number;
  notes?: string;
}

export interface ItemChange {
  at?: number;
  field: string;
  from?: StateValue;
  to?: StateValue;
  reason?: string;
}

/** 一次运行时要应用的增量。数据层只存"发生了什么"，当前值由重放派生。 */
export type RuntimeDelta =
  | {
      kind: 'state';
      scope: { kind: 'character'; id: string } | { kind: 'session' };
      name: string;
      op: 'add' | 'replace' | 'remove';
      value?: StateValue;
    }
  | { kind: 'item'; action: 'grant'; instance: ItemInstance }
  | {
      kind: 'item';
      action: 'update';
      instance_id: string;
      holder?: string;
      condition?: Readonly<Record<string, StateValue>>;
      changes?: readonly ItemChange[];
      notes?: string;
    }
  | { kind: 'item'; action: 'consume'; instance_id: string }
  | { kind: 'scene'; scene_id: string; state?: Readonly<Record<string, StateValue>> };

export interface RuntimePatchPayload {
  session_id: string;
  source: 'user' | 'llm' | 'engine';
  deltas: readonly RuntimeDelta[];
  /** 可追溯：这条补丁由哪条消息触发。 */
  caused_by_message_id?: string;
}

/** 运行时状态（派生，不落盘）：`variables` 的键是 `character:<id>` 或 `session`。 */
export interface SessionRuntime {
  variables: Readonly<Record<string, Readonly<Record<string, StateValue>>>>;
  items: Readonly<Record<string, ItemInstance>>;
  current_scene_id?: string;
  scene_state: Readonly<Record<string, Readonly<Record<string, StateValue>>>>;
}

/** 兼容草稿：酒馆里「我们有、设计里没有」的成品文本先存这里，避免导入即丢数据。 */
export interface CompatStashEntry {
  schema: 'stash/v1';
  id: string;
  character_id: string;
  kind: 'scenario' | 'opening' | 'other';
  text: string;
  /** 来源，例如 `sillytavern/v2:first_mes`。 */
  source?: string;
  created_at: number;
}
