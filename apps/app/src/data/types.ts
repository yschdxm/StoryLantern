/**
 * 领域类型。
 *
 * 这些类型是**界面与存储之间的合同**：宿主实现（Rust/SQLite）与浏览器实现（localStorage）
 * 都按它返回，界面因此不需要知道数据存在哪。
 * 字段名用 camelCase（界面语境）；snake_case 只在宿主边界出现，由仓储层转换。
 */

export type MessageRole = 'user' | 'assistant' | 'system';

/** 流式落库时的消息状态；`streaming` 表示还没生成完，`stopped` 表示用户中途停止。 */
export type MessageStatus = 'done' | 'streaming' | 'error' | 'stopped';

/**
 * 生成元数据。类型与 oplog 的 `message.append` payload 共用一份（避免协议/界面两套定义漂移）。
 */
export type {
  MessageCitation,
  MessageMeta,
  MessageRegexStat,
  MessageTiming,
  MessageTokens,
} from '../../../../packages/oplog/src/op.ts';
import type { MessageMeta as MessageMetaType } from '../../../../packages/oplog/src/op.ts';

export interface Character {
  /** ULID：跨设备唯一，因此同步时不冲突（自增整数做不到这件事）。 */
  id: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  exampleDialogue: string;
  /** 角色自带的系统提示；空 = 用设置里的全局提示。 */
  systemPrompt: string;
  /** 备选开场白（第一条在 `firstMessage`）。 */
  alternateGreetings: string[];
  createdAt: number;
  updatedAt: number;
}

/** 新建时 `id` 省略；编辑时带上 id。 */
export interface CharacterDraft {
  id?: string;
  name: string;
  description?: string;
  personality?: string;
  scenario?: string;
  firstMessage?: string;
  exampleDialogue?: string;
  systemPrompt?: string;
  alternateGreetings?: string[];
}

export interface Session {
  id: string;
  title: string;
  characterId: string;
  characterName: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  lastMessage: string;
  /** 分叉来源会话（B17）：非空表示这是从那个会话复制出来的。 */
  forkedFrom?: string;
}

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  /** 当前显示的正文（选了候选时就是那条候选的正文）。 */
  content: string;
  status: MessageStatus;
  createdAt: number;
  /** 同一位置的其它候选回复（SillyTavern 的 swipes 落在这一类上）。 */
  candidates: MessageCandidate[];
  /** 当前选中的候选 id（空串 = 用最初那条正文）。 */
  selectedCandidateId: string;
  /** 生成元数据（模型/思考链/引用/token/耗时）；旧消息没有。 */
  meta?: MessageMetaType;
  /**
   * 正文版本数量与当前版本 id（B15/B16）：列表只带摘要，**不带全量内容**。
   * 打开消息详情时用 `store.actions.messageRevisions(id)` 单独取。
   */
  revisionCount?: number;
  activeRevisionId?: string;
  /** 存在分叉的基线数（`forksOf` 非空时 >0；内容按需取）。 */
  forkCount?: number;
}

/** 一个"同基线多版本"的分叉组（两台设备基于同一版各改一次）。 */
export interface MessageFork {
  baseRevisionId: string | null;
  revisionIds: string[];
}

/** 一条正文版本（编辑/重生成产生的历史版本）。 */
export interface MessageRevision {
  id: string;
  content: string;
  active: boolean;
}

/** 一条候选回复：导入历史时来自 swipes，将来重新生成也会落到这里。 */
export interface MessageCandidate {
  id: string;
  content: string;
}

export type SettingsMap = Record<string, string>;

// ---------------------------------------------------------------- 世界书（lorebook）

/**
 * 世界书条目：一条"关键词 → 设定"。
 *
 * 字段与 SillyTavern 的世界书一一对应（用户已经熟悉那套心智模型），
 * 因此从角色卡导入时不需要猜。扫描语义见 `packages/lore`。
 */
export interface LoreEntry {
  id: string;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  enabled: boolean;
  /** 越小越先注入。 */
  order: number;
  caseSensitive: boolean;
  recursive: boolean;
  /** 只看最近 N 条消息；0 = 用默认深度。 */
  depth: number;
  /** 常量条目：不问关键词，书激活就注入。 */
  constant: boolean;
  /** 条目备注：设定库导出的条目把 provenance 与审阅状态写在这里。 */
  comment: string;
  createdAt: number;
  updatedAt: number;
}

export interface Lorebook {
  id: string;
  name: string;
  description: string;
  /** 绑定到哪些角色；空表示全局。 */
  characterIds: string[];
  enabled: boolean;
  entries: LoreEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface LorebookDraft {
  id?: string;
  name: string;
  description?: string;
  characterIds?: string[];
  enabled?: boolean;
}

export interface LoreEntryDraft {
  lorebookId: string;
  id?: string;
  keys?: string[];
  secondaryKeys?: string[];
  content?: string;
  enabled?: boolean;
  order?: number;
  caseSensitive?: boolean;
  recursive?: boolean;
  depth?: number;
  constant?: boolean;
  comment?: string;
}

// ---------------------------------------------------------------- 长期记忆

/**
 * 一条长期记忆：从旧对话里压出来的"值得记住的事"。
 *
 * 和其它内容一样是 op（跨设备一致）；`createdBy` 区分用户手写与 agent 建议——
 * 后者必须先经用户确认才落地（"agent 只做整理，不写正文"）。
 */
export interface Memory {
  id: string;
  /** 绑定的角色；空字符串 = 全局。 */
  characterId: string;
  text: string;
  keys: string[];
  /** 重要度 0-100：检索同分时按它排。 */
  importance: number;
  sourceSessionId: string;
  sourceMessageIds: string[];
  createdBy: 'user' | 'agent';
  createdAt: number;
  updatedAt: number;
}

export interface MemoryDraft {
  id?: string;
  characterId?: string;
  text: string;
  keys?: string[];
  importance?: number;
  sourceSessionId?: string;
  sourceMessageIds?: string[];
  createdBy?: 'user' | 'agent';
}

/** 设置键集中在这里，避免界面各处写字符串。 */
export const SETTING_KEYS = {
  providerKind: 'model.provider',
  baseUrl: 'model.base_url',
  apiKey: 'model.api_key',
  /** 向量来源：地址/模型/密钥都独立于聊天（文本常走 DeepSeek 官方，向量走 moark）。 */
  embeddingBaseUrl: 'embedding.base_url',
  embeddingApiKey: 'embedding.api_key',
  embeddingModel: 'embedding.model',
  /** rerank 模型（交叉编码器，如 Qwen3-Reranker-8B）：留空 = 不做精排。 */
  rerankModel: 'model.rerank_model',
  /** 上一次聊天按向量挑摘要的结果（只用于可观测；不含密钥）。 */
  vectorOutcome: 'debug.vector.outcome',
  model: 'model.name',
  temperature: 'model.temperature',
  maxTokens: 'model.max_tokens',
  /** 多模型路由的配置元数据（JSON 数组；**不含密钥**，密钥在宿主侧的 model.profile.<id>.api_key）。 */
  modelProfiles: 'model.profiles',
  systemPrompt: 'chat.system_prompt',
  /** 进入上下文的最近消息条数（0/未设 = 默认 40）。 */
  historyLimit: 'chat.history_limit',
  /** 引用模式：'on' = 历史编号并要求模型标注来源；默认 off（普通角色扮演不出现 [16]）。 */
  cite: 'chat.cite',
  /** 世界书扫描深度：只在最近 N 条消息里找关键词（1–20，未设 = 4）。 */
  loreScanDepth: 'chat.lore_scan_depth',
  /** 真实用量回传：'off' = 不请求 stream_options.include_usage，改用估算；默认 on。 */
  streamUsage: 'chat.stream_usage',
  locale: 'app.locale',
  theme: 'app.theme',
  fontScale: 'app.font_scale',
  developerMode: 'app.developer_mode',
  // 用量与成本（M4 判据 3）：价格表是 JSON 数组 [{modelId,promptPer1k,completionPer1k}]，
  // 预算单位是美元；两者留空都表示"不设"。用量本身按 usage.device.<设备>.<日期> 记（见 usage-store.ts）
  usagePrices: 'usage.prices',
  usageBudgetUsd: 'usage.budget_usd',
  // 同步：**非机密**配置进设置；同步口令与进度在设备本地 kv（见 app-sync.ts 的说明）
  syncKind: 'sync.kind',
  syncUrl: 'sync.url',
  syncUsername: 'sync.username',
  syncPassword: 'sync.password',
  /** 本地文件夹同步的根目录（留空 = 宿主默认）。 */
  syncFolder: 'sync.folder',
  /** 'on' = 文件夹同步走系统选择器选中的目录（Android SAF）。 */
  syncFolderSaf: 'sync.folder.saf',
  // S3 兼容后端（MinIO / R2 / B2 / AWS）：这些都是**非机密**标识，secretAccessKey 不进设置（宿主会对 secret 类键回掩码）
  syncS3Endpoint: 'sync.s3.endpoint',
  syncS3Bucket: 'sync.s3.bucket',
  syncS3Region: 'sync.s3.region',
  syncS3AccessKeyId: 'sync.s3.accessKeyId',
  /** GC 宽限期（天）：留空 = 默认 30 天。做成可调是为了让人能在真机上真的验证一次回收。 */
  syncGcGraceDays: 'sync.gc.graceDays',
  syncLastAt: 'sync.last_at',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];
