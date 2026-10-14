import type { Character, CharacterDraft, Message, MessageRole, MessageStatus, Session, SettingsMap } from './types.ts';

/**
 * 仓储：界面唯一的取数入口。
 *
 * 两个实现必须**行为一致**（同一套契约测试跑两边）：
 *  - `host`：走 wire → Rust/SQLite（桌面与 Android）
 *  - `local`：localStorage（纯浏览器里也能用，离线/演示不丢数据）
 *
 * 为什么不把 SQL 或 fetch 直接写进界面：那样两端会分叉，而"分叉的行为"正是最难查的 bug。
 */
export interface Repository {
  readonly kind: 'host' | 'local';
  readonly characters: CharacterStore;
  readonly sessions: SessionStore;
  readonly messages: MessageStore;
  readonly settings: SettingsStore;
  /** 只读诊断信息（浏览器实现返回 undefined）。 */
  probe?(): Promise<ProbeInfo>;
}

export interface CharacterStore {
  list(): Promise<Character[]>;
  get(id: number): Promise<Character | undefined>;
  save(draft: CharacterDraft): Promise<Character>;
  remove(id: number): Promise<boolean>;
}

export interface SessionStore {
  list(): Promise<Session[]>;
  create(characterId: number, title?: string): Promise<Session>;
  rename(id: number, title: string): Promise<boolean>;
  remove(id: number): Promise<boolean>;
}

export interface MessageStore {
  list(sessionId: number): Promise<Message[]>;
  append(sessionId: number, role: MessageRole, content: string, status?: MessageStatus): Promise<Message>;
  update(id: number, content: string, status?: MessageStatus): Promise<boolean>;
  remove(id: number): Promise<boolean>;
}

export interface SettingsStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  all(): Promise<SettingsMap>;
}

export interface ProbeInfo {
  path: string;
  journalMode: string;
  pageSize: number;
  sqliteVersion: string;
  writable: boolean;
  characters: number;
  sessions: number;
  messages: number;
}

/** 仓储层统一抛这个：`code` 供界面分支，`message` 直接给用户看。 */
export class DataError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DataError';
    this.code = code;
  }
}

/** 角色字段的公共校验：两个实现必须给出同样的错误码与文案。 */
export function validateCharacterDraft(draft: CharacterDraft): Required<Omit<CharacterDraft, 'id'>> {
  const name = (draft.name ?? '').trim();
  if (name === '') throw new DataError('invalid-argument', '角色名不能为空');
  if (name.length > 60) throw new DataError('invalid-argument', '角色名过长（最多 60 字）');
  return {
    name,
    description: (draft.description ?? '').trim(),
    personality: (draft.personality ?? '').trim(),
    scenario: (draft.scenario ?? '').trim(),
    firstMessage: (draft.firstMessage ?? '').trim(),
    exampleDialogue: (draft.exampleDialogue ?? '').trim(),
  };
}

export function validateSessionTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed === '') throw new DataError('invalid-argument', '会话名不能为空');
  return trimmed;
}

export function validateMessageRole(role: string): MessageRole {
  if (role === 'user' || role === 'assistant' || role === 'system') return role;
  throw new DataError('invalid-argument', `未知的消息角色：${role}`);
}

/**
 * 本地端点（局域网/本机）通常不需要 API Key。
 *
 * 这条规则与 Rust 侧 `chat.rs` 的 `is_local_endpoint` 必须一致——否则会出现
 * "宿主愿意调用、界面却还把发送按钮禁着"的不一致。
 */
export function isLocalEndpoint(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes('127.0.0.1') ||
    lower.includes('localhost') ||
    lower.includes('10.0.2.2') ||
    lower.includes('192.168.') ||
    lower.includes('10.0.') ||
    lower.startsWith('http://[') // IPv6 本机
  );
}

/** 模型是否已配置到"可以发话"的程度。 */
export function isModelConfigured(settings: Record<string, string>): boolean {
  const baseUrl = (settings['model.base_url'] ?? '').trim();
  const model = (settings['model.name'] ?? '').trim();
  const apiKey = settings['model.api_key'] ?? '';
  if (baseUrl === '' || model === '') return false;
  return apiKey !== '' || isLocalEndpoint(baseUrl);
}

/** 会话列表/聊天气泡共用的时间显示：刚刚 / 12:05 / 昨天 / 3月8日 */export function formatTime(timestamp: number, now = Date.now()): string {
  if (timestamp <= 0) return '';
  const date = new Date(timestamp);
  const diff = now - timestamp;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const sameDay = new Date(now).toDateString() === date.toDateString();
  if (sameDay) return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const yesterday = new Date(now - 86_400_000);
  if (yesterday.toDateString() === date.toDateString()) return '昨天';
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

/** 会话列表的副标题：最后一条消息压成一行。 */
export function previewOf(text: string, limit = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return '还没有消息';
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}
