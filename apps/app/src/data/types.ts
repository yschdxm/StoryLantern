/**
 * 领域类型。
 *
 * 这些类型是**界面与存储之间的合同**：宿主实现（Rust/SQLite）与浏览器实现（localStorage）
 * 都按它返回，界面因此不需要知道数据存在哪。
 * 字段名用 camelCase（界面语境）；snake_case 只在宿主边界出现，由仓储层转换。
 */

export type MessageRole = 'user' | 'assistant' | 'system';

/** 流式落库时的消息状态；`streaming` 表示还没生成完。 */
export type MessageStatus = 'done' | 'streaming' | 'error';

export interface Character {
  /** ULID：跨设备唯一，因此同步时不冲突（自增整数做不到这件事）。 */
  id: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  exampleDialogue: string;
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
}

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  createdAt: number;
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
}

/** 设置键集中在这里，避免界面各处写字符串。 */
export const SETTING_KEYS = {
  providerKind: 'model.provider',
  baseUrl: 'model.base_url',
  apiKey: 'model.api_key',
  model: 'model.name',
  temperature: 'model.temperature',
  maxTokens: 'model.max_tokens',
  systemPrompt: 'chat.system_prompt',
  /** 进入上下文的最近消息条数（0/未设 = 默认 40）。 */
  historyLimit: 'chat.history_limit',
  locale: 'app.locale',
  theme: 'app.theme',
  fontScale: 'app.font_scale',
  developerMode: 'app.developer_mode',
  // 同步：**非机密**配置进设置；同步口令与进度在设备本地 kv（见 app-sync.ts 的说明）
  syncKind: 'sync.kind',
  syncUrl: 'sync.url',
  syncUsername: 'sync.username',
  syncPassword: 'sync.password',
  /** 本地文件夹同步的根目录（留空 = 宿主默认）。 */
  syncFolder: 'sync.folder',
  syncLastAt: 'sync.last_at',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];
