/**
 * 导入器的领域类型。
 *
 * 这一步刻意**不碰仓储、不认识界面**：把"文件字节 → 结构化内容"做干净，
 * 上层（应用）再决定怎么落库。好处是全部逻辑都能用 fixtures 里的真实样本测。
 */

export interface ImportedLorebookEntry {
  keys: string[];
  secondaryKeys: string[];
  content: string;
  /** 条目名（comment/name）。 */
  name: string;
  enabled: boolean;
  constant: boolean;
}

export interface ImportedLorebook {
  name: string;
  description: string;
  entries: ImportedLorebookEntry[];
}

export interface ImportedCharacter {
  kind: 'character';
  /** 来源文件名，用于界面提示与排错。 */
  source: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  exampleDialogue: string;
  /** 卡片自带的 system prompt（空 = 用应用里的全局提示）。 */
  systemPrompt: string;
  /** 备选开场白（第一条仍在 `firstMessage`）。 */
  alternateGreetings: string[];
  /** 卡片规范版本：`chara_card_v2` / `chara_card_v3` / `legacy`。 */
  spec: string;
  lorebook?: ImportedLorebook;
  /** 丢掉了什么、可能影响什么——宁可写清楚，也不静默丢数据。 */
  notes: string[];
}

export interface ImportedChatMessage {
  role: 'user' | 'assistant' | 'system';
  /** 当前选中的那条（SillyTavern 里的 swipe id 指向它）。 */
  content: string;
  /** 同一位置的其它候选回复（SillyTavern 的 swipes）；不再被丢掉。 */
  candidates?: string[];
  createdAt: number;
}

export interface ImportedChat {
  kind: 'chat';
  source: string;
  /** 聊天记录里的角色名（用来找/建对应角色）。 */
  characterName: string;
  title: string;
  messages: ImportedChatMessage[];
  notes: string[];
}

export interface ImportedLorebookFile {
  kind: 'lorebook';
  source: string;
  lorebook: ImportedLorebook;
  notes: string[];
}

export interface ImportedUnknown {
  kind: 'unknown';
  source: string;
  reason: string;
}

export type Imported = ImportedCharacter | ImportedChat | ImportedLorebookFile | ImportedUnknown;

/** 导入失败：`code` 供界面分支，`message` 直接给用户看。 */
export class ImportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asString).filter((item) => item !== '');
  const single = asString(value);
  return single === '' ? [] : [single];
}
