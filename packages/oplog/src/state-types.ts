import type { Hlc } from './hlc.ts';
import type { MessageAuthor } from './op.ts';
import type { SummaryLevel } from './summary-ops.ts';

/** 物化状态的记录类型。独立成文件，便于 protocol 层（快照/编解码）只依赖类型。 */

export interface RevisionRecord {
  revisionId: string;
  content: string;
  /** null 表示这是消息的首版；否则是它改写的基线版本。 */
  baseRevisionId: string | null;
  hlc: Hlc;
  opId: string;
  deviceId: string;
}

export interface CandidateRecord {
  candidateId: string;
  content: string;
  hlc: Hlc;
  opId: string;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  author: MessageAuthor;
  appendHlc: Hlc;
  appendOpId: string;
  revisions: RevisionRecord[];
  /** 当前正文版本。`explicit` 表示用户显式选过。 */
  activeRevision: { revisionId: string; hlc: Hlc; explicit: boolean };
  candidates: CandidateRecord[];
  selectedCandidate?: { candidateId: string; hlc: Hlc };
  /** 生成失败等状态（append/edit 都会更新，按 HLC 取最新）。 */
  status?: 'done' | 'error';
  statusHlc?: Hlc;
  deleted?: { hlc: Hlc };
}

export interface SessionRecord {
  id: string;
  title: string;
  titleHlc: Hlc;
  /** 标题写入的 opId：HLC 相同时用它决定谁赢（与角色卡同一套规则）。 */
  titleOpId: string;
  /** 会话创建时间（第一次 create 的 HLC），列表显示"创建于"用。 */
  createdHlc: Hlc;
  characterId?: string;
  forkedFrom?: string;
  /** 墓碑：与标题写入共用同一条时间线（见角色卡的同款说明）。 */
  deleted?: { hlc: Hlc; opId: string };
}

/**
 * 角色卡。字段用整体 LWW（`updatedHlc`）：这样"先收到更新、后收到创建"也能收敛，
 * 不需要把更新当成孤儿去等创建——角色卡本来就没有"必须先创建"的不变量。
 */
export interface CharacterRecord {
  id: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  exampleDialogue: string;
  /** 角色自带的系统提示（导入卡片时不再丢掉）。 */
  systemPrompt?: string;
  /** 备选开场白（第一条在 firstMessage 里）。 */
  alternateGreetings?: string[];
  /** 第一次写入的时间：列表里"创建于"用，更新时不变。 */
  createdHlc: Hlc;
  updatedHlc: Hlc;
  opId: string;
  /**
   * 墓碑：删除也是一次带 HLC 的写入。
   * 删除与 upsert **共用同一条时间线**——否则乱序时"更旧的删除"会盖掉"更新的编辑"。
   */
  deleted?: { hlc: Hlc; opId: string };
}

/**
 * 分层摘要（M4）。与记忆/世界书同一套 LWW + 墓碑语义；`covers` 与 `contentHash` 是它与下层内容的连接：
 * 指纹不同就说明下层被改过（见 summary-plan.ts 的失效传播）。
 */
export interface SummaryRecord {
  id: string;
  sessionId: string;
  level: SummaryLevel;
  covers: string[];
  contentHash: string;
  text: string;
  createdBy: 'user' | 'model';
  modelId?: string;
  createdHlc: Hlc;
  updatedHlc: Hlc;
  opId: string;
  deleted?: { hlc: Hlc; opId: string };
}

export interface MaterializedState {
  characters: Record<string, CharacterRecord>;
  sessions: Record<string, SessionRecord>;
  messages: Record<string, MessageRecord>;
  lorebooks: Record<string, LorebookRecord>;
  memories: Record<string, MemoryRecord>;
  summaries: Record<string, SummaryRecord>;
  settings: Record<string, { value: unknown; hlc: Hlc; opId: string }>;
}

/**
 * 长期记忆条目：从旧对话里压出来的一条"值得记住的事"。
 *
 * 为什么它是一条 op 而不是本地缓存：
 *  - 它属于**内容**（跨设备该一致），因此必须进日志、跟着同步走；
 *  - 它是"谁写的"有区别的数据：`createdBy` 区分用户手写与 agent 建议，
 *    后者应当由用户确认后才落地（见 `proposeMemories` 的界面流程）。
 */
export interface MemoryRecord {
  id: string;
  /** 绑定的角色；undefined = 全局（所有角色可用）。 */
  characterId?: string;
  text: string;
  /** 关键词：检索时用（与检索窗口里的消息做匹配）。 */
  keys: string[];
  /** 重要度 0-100：同分时按它排序（越重要越靠前）。 */
  importance: number;
  /** 来源：从哪个会话/哪些消息整理出来的（可追溯，也可用来"回看原文"）。 */
  sourceSessionId?: string;
  sourceMessageIds: string[];
  createdBy: 'user' | 'agent';
  createdHlc: Hlc;
  updatedHlc: Hlc;
  opId: string;
  deleted?: { hlc: Hlc; opId: string };
}

/**
 * 世界书条目。与角色卡同样是 LWW + 墓碑，但**条目独立**：
 * "自动维护"这类功能会逐条增改，整本覆盖写会让并发编辑互相覆盖。
 */
export interface LoreEntryRecord {
  id: string;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  enabled: boolean;
  order: number;
  caseSensitive: boolean;
  recursive: boolean;
  depth: number;
  constant: boolean;
  createdHlc: Hlc;
  updatedHlc: Hlc;
  opId: string;
  deleted?: { hlc: Hlc; opId: string };
}

export interface LorebookRecord {
  id: string;
  name: string;
  description: string;
  /** 绑定到哪些角色；空数组表示全局（所有角色共用）。 */
  characterIds: string[];
  enabled: boolean;
  entries: Record<string, LoreEntryRecord>;
  createdHlc: Hlc;
  updatedHlc: Hlc;
  opId: string;
  deleted?: { hlc: Hlc; opId: string };
}

export interface Snapshot {
  version: 1;
  state: MaterializedState;
  /** 已应用的 opId：投递是 at-least-once，因此幂等必须靠它。 */
  appliedOpIds: string[];
}

export interface ForkGroup {
  baseRevisionId: string | null;
  revisionIds: string[];
}
