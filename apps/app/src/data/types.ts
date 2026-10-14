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
  id: number;
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
  id?: number;
  name: string;
  description?: string;
  personality?: string;
  scenario?: string;
  firstMessage?: string;
  exampleDialogue?: string;
}

export interface Session {
  id: number;
  title: string;
  characterId: number;
  characterName: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  lastMessage: string;
}

export interface Message {
  id: number;
  sessionId: number;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  createdAt: number;
}

export type SettingsMap = Record<string, string>;

/** 设置键集中在这里，避免界面各处写字符串。 */
export const SETTING_KEYS = {
  providerKind: 'model.provider',
  baseUrl: 'model.base_url',
  apiKey: 'model.api_key',
  model: 'model.name',
  temperature: 'model.temperature',
  maxTokens: 'model.max_tokens',
  systemPrompt: 'chat.system_prompt',
  locale: 'app.locale',
  theme: 'app.theme',
  developerMode: 'app.developer_mode',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];
