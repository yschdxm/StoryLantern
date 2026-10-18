/**
 * 角色卡：结构来源 `docs/specs/角色卡结构设计文档.md`（v0.6）。
 *
 * 三条关键取舍（都已写进 ADR-0011）：
 *  1. **不含场景、不含开场**：它们是会话级的一次性配置（`types-session.ts` 的 `SessionSetup`）。
 *  2. **示例对话结构化**：`examples[]` 可带标签按情境挑选，而不是一整块 `mes_example` 字符串。
 *  3. **状态只放模式、不放值**：`state.schema` 是变量定义；值在会话运行时（`SessionRuntime`）。
 */

import type { CardBase, StateValue } from './types-base.ts';

export interface Relationship {
  /** 关系对象：另一个角色卡的 ID（`asset`/`character:xxx` 这类前缀由引用解析器处理，这里存 ID 本身）。 */
  target: string;
  /** 开放字符串：`enemy` / `ally` / `family` / `mentor` … */
  type: string;
  description?: string;
}

export interface CharacterIdentity {
  name: string;
  aliases?: readonly string[];
  gender?: string;
  /** 允许描述性文字（"看起来二十出头"）。 */
  age?: string;
  species?: string;
  occupation?: string;
  /** 常驻地点：场景卡 ID。 */
  location?: string;
  background: string;
  relationships?: readonly Relationship[];
}

export interface Metamorphosis {
  /** 触发条件表达式源码（例如 `affection >= 70`）；求值器在规则模块。 */
  condition: string;
  change: string;
}

export interface Persona {
  /** 一句话核心人设。 */
  summary: string;
  traits: readonly string[];
  values?: readonly string[];
  goals?: readonly string[];
  fears?: readonly string[];
  taboos?: readonly string[];
  /** `knowledge_boundary` / `ability_boundary` 是防幻觉字段：缺字段是 error，
   *  空字符串只报 warning（`boundary-pending`，导入的旧卡先留空、由作者或 Agent 补全）。 */
  knowledge_boundary: string;
  /** 角色**能做到/做不到**什么（防幻觉；酒馆没有这一层）。 */
  ability_boundary: string;
  default_mood?: string;
  metamorphosis?: readonly Metamorphosis[];
}

export interface Speech {
  style: string;
  tone?: string;
  vocabulary?: readonly string[];
  forbidden_words?: readonly string[];
  /** 不同情绪档位的示例台词（建议 ≥5 条；是 lint 建议，不是 schema 错误）。 */
  example_lines?: readonly string[];
  narration_style?: string;
}

export type ExampleRole = 'user' | 'assistant' | 'system' | 'narrator';

export interface ExampleDialogue {
  id: string;
  tags?: readonly string[];
  /** 使用场景说明（例如"初次见面的冷启动"）。 */
  context?: string;
  messages: readonly { role: ExampleRole; content: string }[];
}

export type StateVarType = 'integer' | 'string' | 'boolean' | 'array';

/**
 * 一个变量的定义（只定义模式，值在会话运行时里）。
 *
 * 例：`{ type:'integer', default:50, min:0, max:100, visible_to_user:true }`。
 */
export interface StateVarDef {
  type: StateVarType;
  default: StateValue;
  min?: number;
  max?: number;
  enum?: readonly StateValue[];
  visible_to_user?: boolean;
  /** 注入提示词的模板，允许 `{{name}}` 与 `{{value}}` 两个占位符。 */
  prompt_render?: string;
}

export interface StateUpdatePolicy {
  allow_llm_patch: boolean;
  require_engine_validation: boolean;
  /** 单回合最大变化量（防数值乱跳）。 */
  max_delta_per_turn?: number;
}

export interface StateSchema {
  schema: Readonly<Record<string, StateVarDef>>;
  update_policy: StateUpdatePolicy;
}

export type RuleEvent = 'before_prompt' | 'before_reply' | 'after_reply' | 'on_state_change';

export type RuleActionType = 'inject_prompt' | 'constraint' | 'set_state' | 'block';

export interface RuleAction {
  type: RuleActionType;
  /** `inject_prompt` / `constraint` / `block` 的文本。 */
  text?: string;
  /** `set_state` 的目标变量名。 */
  state_name?: string;
  /** `set_state` 的表达式源码（例如 `affection + 5`）。 */
  state_expr?: string;
}

export interface CardRule {
  id: string;
  enabled: boolean;
  priority: number;
  when: {
    event: RuleEvent;
    /** 条件表达式源码数组（AND）。 */
    conditions?: readonly string[];
  };
  actions: readonly RuleAction[];
}

/** 角色专属提示片段。**平台通用规则不写在这里**（AI 身份、合规、输出格式由引擎统一管理）。 */
export interface PromptFragments {
  system_extra?: string;
  roleplay_rules?: readonly string[];
  style_guide?: string;
  post_history_instructions?: string;
}

/**
 * 快捷回复（B14）：作者预置一句话，UI 点一下填进输入框（或直接发送）。
 * 只存作者数据，执行/展开在应用层（`data/quick-replies.ts`）。
 */
export interface QuickReply {
  id: string;
  name: string;
  /** 支持 `{{char}}` / `{{user}}` 宏（展开规则与提示词作者文本一致）。 */
  content: string;
  enabled?: boolean;
}

export interface MemoryPolicy {
  short_term_turns?: number;
  summary_threshold_tokens?: number;
  long_term_policy?: string;
  important_event_types?: readonly string[];
}

export interface Presentation {
  /** 指向 `visuals` 中某条作为头像；不填取 `is_primary`。 */
  avatar_ref?: string;
  theme?: Readonly<Record<string, string>>;
  tts?: Readonly<Record<string, string | number | boolean>>;
  /** 需要展示的面板名（`relationship` / `inventory` …）。 */
  ui_panels?: readonly string[];
}

export interface CharacterCard extends CardBase {
  card_type: 'character';
  identity: CharacterIdentity;
  persona: Persona;
  speech: Speech;
  examples?: readonly ExampleDialogue[];
  state?: StateSchema;
  rules?: readonly CardRule[];
  prompts?: PromptFragments;
  /** 快捷回复（ST `quick_replies`）；无 UI 入口时只由导入/导出携带。 */
  quick_replies?: readonly QuickReply[];
  memory?: MemoryPolicy;
  presentation?: Presentation;
}
