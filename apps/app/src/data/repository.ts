import type {
  Character,
  CharacterDraft,
  LoreEntry,
  LoreEntryDraft,
  Lorebook,
  LorebookDraft,
  Memory,
  MemoryDraft,
  Message,
  MessageRole,
  MessageStatus,
  Session,
  SettingsMap,
} from './types.ts';

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
  readonly lorebooks: LorebookStore;
  readonly memories: MemoryStore;
  readonly settings: SettingsStore;
  /** 只读诊断信息（浏览器实现返回 undefined）。 */
  probe?(): Promise<ProbeInfo>;
}

export interface CharacterStore {
  list(): Promise<Character[]>;
  get(id: string): Promise<Character | undefined>;
  save(draft: CharacterDraft): Promise<Character>;
  remove(id: string): Promise<boolean>;
}

export interface SessionStore {
  list(): Promise<Session[]>;
  create(characterId: string, title?: string): Promise<Session>;
  rename(id: string, title: string): Promise<boolean>;
  remove(id: string): Promise<boolean>;
}

export interface MessageStore {
  list(sessionId: string): Promise<Message[]>;
  /** `createdAt` 用于导入历史记录：不传就用当前时间。 */
  append(sessionId: string, role: MessageRole, content: string, status?: MessageStatus, createdAt?: number): Promise<Message>;
  update(id: string, content: string, status?: MessageStatus): Promise<boolean>;
  remove(id: string): Promise<boolean>;
}

export interface SettingsStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  all(): Promise<SettingsMap>;
}

/**
 * 世界书仓储。两级结构：书（名字/绑定/开关）与条目（关键词/正文/优先级）。
 *
 * 条目为什么单独有方法：将来"lore 自动维护"会逐条增改；
 * 如果只能整本保存，两个功能同时改一本书就会互相覆盖。
 */
export interface LorebookStore {
  list(): Promise<Lorebook[]>;
  get(id: string): Promise<Lorebook | undefined>;
  /** 某角色能用的书：绑定了它的 + 全局的（`characterIds` 为空）。 */
  forCharacter(characterId: string | undefined): Promise<Lorebook[]>;
  save(draft: LorebookDraft): Promise<Lorebook>;
  remove(id: string): Promise<boolean>;
  saveEntry(draft: LoreEntryDraft): Promise<Lorebook>;
  removeEntry(lorebookId: string, entryId: string): Promise<Lorebook | undefined>;
}

/**
 * 长期记忆仓储。记忆是**内容**（跟着同步走），因此和其它内容一样只能通过 op 写入；
 * 这里的接口只负责校验与视图转换。
 */
export interface MemoryStore {
  list(): Promise<Memory[]>;
  /** 某角色能用的记忆：绑定了它的 + 全局的。 */
  forCharacter(characterId: string | undefined): Promise<Memory[]>;
  save(draft: MemoryDraft): Promise<Memory>;
  remove(id: string): Promise<boolean>;
}

/** 记忆正文的公共校验：两个实现必须给出同样的错误码与文案。 */
export function validateMemoryDraft(draft: MemoryDraft): Required<Omit<MemoryDraft, 'id' | 'characterId' | 'sourceSessionId'>> & {
  characterId?: string;
  sourceSessionId?: string;
} {
  const text = (draft.text ?? '').trim();
  if (text === '') throw new DataError('invalid-argument', '记忆内容不能为空');
  if (text.length > 500) throw new DataError('invalid-argument', '记忆内容过长（最多 500 字）');
  const importance = Number.isFinite(draft.importance) ? Number(draft.importance) : 50;
  return {
    text,
    keys: normalizeLoreKeys(draft.keys ?? []),
    importance: Math.max(0, Math.min(100, Math.round(importance))),
    sourceMessageIds: [...new Set(draft.sourceMessageIds ?? [])],
    createdBy: draft.createdBy === 'agent' ? 'agent' : 'user',
    ...(draft.characterId === undefined || draft.characterId === '' ? {} : { characterId: draft.characterId }),
    ...(draft.sourceSessionId === undefined || draft.sourceSessionId === '' ? {} : { sourceSessionId: draft.sourceSessionId }),
  };
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
    systemPrompt: (draft.systemPrompt ?? '').trim(),
    alternateGreetings: (draft.alternateGreetings ?? []).map((item) => item.trim()).filter((item) => item !== ''),
  };
}

export function validateSessionTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed === '') throw new DataError('invalid-argument', '会话名不能为空');
  return trimmed;
}

/** 世界书字段的公共校验：两个实现必须给出同样的错误码与文案。 */
export function validateLorebookDraft(draft: LorebookDraft): Required<Omit<LorebookDraft, 'id'>> {
  const name = (draft.name ?? '').trim();
  if (name === '') throw new DataError('invalid-argument', '世界书名称不能为空');
  if (name.length > 60) throw new DataError('invalid-argument', '世界书名称过长（最多 60 字）');
  return {
    name,
    description: (draft.description ?? '').trim(),
    characterIds: [...new Set(draft.characterIds ?? [])],
    enabled: draft.enabled !== false,
  };
}

/** 关键词：去空白、去重、丢掉空串。 */
export function normalizeLoreKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of keys) {
    const clean = key.trim();
    if (clean === '' || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

export function validateLoreEntryDraft(draft: LoreEntryDraft): Required<Omit<LoreEntryDraft, 'id'>> {
  const keys = normalizeLoreKeys(draft.keys ?? []);
  const constant = draft.constant === true;
  if (keys.length === 0 && !constant) {
    throw new DataError('invalid-argument', '条目至少要有一个关键词（常量条目可以没有）');
  }
  const content = (draft.content ?? '').trim();
  if (content === '') throw new DataError('invalid-argument', '条目正文不能为空');
  return {
    lorebookId: draft.lorebookId,
    keys,
    secondaryKeys: normalizeLoreKeys(draft.secondaryKeys ?? []),
    content,
    enabled: draft.enabled !== false,
    order: Number.isFinite(draft.order) ? Number(draft.order) : 100,
    caseSensitive: draft.caseSensitive === true,
    recursive: draft.recursive !== false,
    depth: Number.isFinite(draft.depth) && Number(draft.depth) > 0 ? Math.floor(Number(draft.depth)) : 0,
    constant,
  };
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
