import {
  DataError,
  validateCharacterDraft,
  validateLoreEntryDraft,
  validateLorebookDraft,
  validateMemoryDraft,
  validateMessageRole,
  validateSessionTitle,
  type CharacterStore,
  type LorebookStore,
  type MemoryStore,
  type MessageStore,
  type ProbeInfo,
  type Repository,
  type SessionStore,
  type SettingsStore,
} from './repository.ts';
import { pickOpening } from './greeting.ts';
import { createLocalLoreStore } from './local-lore-store.ts';
import { createLocalMemoryStore } from './local-memory-store.ts';
import { createLocalSummaryStore } from './local-summary-store.ts';
import type { Summary, SummaryStore } from './summary-types.ts';
import { createLocalFactStore } from './local-fact-store.ts';
import type { Fact, FactStore } from './fact-types.ts';
import type {
  Character,
  CharacterDraft,
  Lorebook,
  LorebookDraft,
  LoreEntry,
  LoreEntryDraft,
  Memory,
  MemoryDraft,
  Message,
  MessageMeta,
  MessageRole,
  MessageStatus,
  Session,
  SettingsMap,
} from './types.ts';

/**
 * 内存实现：**语义参考**。
 *
 * 它同时是三样东西：
 *  1. 契约测试的参照物（localStorage 版与宿主版都必须给出同样行为）；
 *  2. localStorage 版的底座（把状态序列化出去就是持久化）；
 *  3. 预览/测试用的零依赖仓储。
 *
 * 这里的每条规则都要和 Rust 侧（`apps/shell/src-tauri/src/store.rs`）保持一致——
 * 两边行为不一致时，最难查的 bug 就出现了。
 */

export interface RepositoryState {
  characters: Character[];
  sessions: Session[];
  messages: Message[];
  lorebooks: Lorebook[];
  memories: Memory[];
  summaries: Summary[];
  facts: Fact[];
  settings: SettingsMap;
  sequence: number;
}

export function emptyState(): RepositoryState {
  return { characters: [], sessions: [], messages: [], lorebooks: [], memories: [], summaries: [], facts: [], settings: {}, sequence: 0 };
}

export interface MemoryRepositoryOptions {
  /** 每次写操作后回调，用于持久化（localStorage 版就是靠它落盘）。 */
  onChange?: (state: RepositoryState) => void;
  /** 注入时钟，便于测试。 */
  now?: () => number;
}

export interface MemoryRepository extends Repository {
  snapshot(): RepositoryState;
}

export function createMemoryRepository(
  initial: RepositoryState = emptyState(),
  options: MemoryRepositoryOptions = {},
): MemoryRepository {
  const state: RepositoryState = {
    characters: [...initial.characters],
    sessions: [...initial.sessions],
    messages: [...initial.messages],
    lorebooks: (initial.lorebooks ?? []).map((book) => ({ ...book, entries: book.entries.map((entry) => ({ ...entry })) })),
    memories: (initial.memories ?? []).map((memory) => ({ ...memory, keys: [...memory.keys], sourceMessageIds: [...memory.sourceMessageIds] })),
    summaries: (initial.summaries ?? []).map((summary) => ({ ...summary, covers: [...summary.covers] })),
    facts: (initial.facts ?? []).map((fact) => ({ ...fact, sourceMessageIds: [...fact.sourceMessageIds] })),
    settings: { ...initial.settings },
    sequence: initial.sequence,
  };
  const now = options.now ?? (() => Date.now());
  const commit = (): void => options.onChange?.(state);
  // id 用"前缀 + 自增"的字符串：与宿主侧 ULID 同样是字符串，类型一致；
  // 内存实现不需要跨设备唯一，因此不必生成 ULID。
  const nextId = (prefix: string): string => `${prefix}${(state.sequence += 1)}`;

  const findCharacter = (id: string): Character | undefined => state.characters.find((item) => item.id === id);

  const characters: CharacterStore = {
    async list() {
      return [...state.characters].sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
    },

    async get(id) {
      return findCharacter(id);
    },

    async save(draft: CharacterDraft) {
      const clean = validateCharacterDraft(draft);
      const stamp = now();
      if (draft.id !== undefined) {
        const existing = findCharacter(draft.id);
        if (existing === undefined) throw new DataError('invalid-argument', '找不到该角色');
        Object.assign(existing, clean, { updatedAt: stamp });
        commit();
        return { ...existing };
      }
      const created: Character = {
        id: nextId('c'),
        ...clean,
        createdAt: stamp,
        updatedAt: stamp,
      };
      state.characters.push(created);
      commit();
      return { ...created };
    },

    async remove(id) {
      const before = state.characters.length;
      state.characters = state.characters.filter((item) => item.id !== id);
      const removed = state.characters.length !== before;
      if (removed) {
        const sessionIds = new Set(state.sessions.filter((session) => session.characterId === id).map((session) => session.id));
        state.sessions = state.sessions.filter((session) => session.characterId !== id);
        state.messages = state.messages.filter((message) => !sessionIds.has(message.sessionId));
        commit();
      }
      return removed;
    },
  };

  const buildSession = (session: Session): Session => {
    const character = findCharacter(session.characterId);
    const messages = state.messages.filter((message) => message.sessionId === session.id);
    const last = messages[messages.length - 1];
    return {
      ...session,
      characterName: character?.name ?? '',
      messageCount: messages.length,
      lastMessage: last?.content ?? '',
    };
  };

  const touchSession = (sessionId: string): void => {
    const session = state.sessions.find((item) => item.id === sessionId);
    if (session !== undefined) session.updatedAt = now();
  };

  const sessions: SessionStore = {
    async list() {
      return [...state.sessions]
        .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
        .map(buildSession);
    },

    async create(characterId, title, greetingIndex) {
      const character = findCharacter(characterId);
      if (character === undefined) throw new DataError('invalid-argument', `角色 ${characterId} 不存在`);
      const stamp = now();
      const session: Session = {
        id: nextId('s'),
        title: title === undefined || title.trim() === '' ? character.name : validateSessionTitle(title),
        characterId,
        characterName: character.name,
        createdAt: stamp,
        updatedAt: stamp,
        messageCount: 0,
        lastMessage: '',
      };
      state.sessions.push(session);
      const opening = pickOpening(character, greetingIndex);
      if (opening !== undefined) {
        state.messages.push({
          id: nextId('m'),
          sessionId: session.id,
          role: 'assistant',
          content: opening,
          status: 'done',
          createdAt: stamp,
          candidates: [],
          selectedCandidateId: '',
        });
      }
      commit();
      return buildSession(session);
    },

    async rename(id, title) {
      const clean = validateSessionTitle(title);
      const session = state.sessions.find((item) => item.id === id);
      if (session === undefined) return false;
      session.title = clean;
      session.updatedAt = now();
      commit();
      return true;
    },

    async remove(id) {
      const before = state.sessions.length;
      state.sessions = state.sessions.filter((item) => item.id !== id);
      const removed = state.sessions.length !== before;
      if (removed) {
        state.messages = state.messages.filter((message) => message.sessionId !== id);
        commit();
      }
      return removed;
    },
  };

  const messages: MessageStore = {
    async list(sessionId) {
      // 数组本身按写入顺序排列，不必再排序（id 是字符串，按字典序排会错）
      return state.messages.filter((message) => message.sessionId === sessionId);
    },

    async append(sessionId, role: MessageRole, content: string, status: MessageStatus = 'done', createdAt?: number, meta?: MessageMeta) {
      const safeRole = validateMessageRole(role);
      const message: Message = {
        id: nextId('m'),
        sessionId,
        role: safeRole,
        content,
        status,
        // 导入历史时保留原始时间；0/未传都按"现在"处理
        createdAt: createdAt !== undefined && createdAt > 0 ? createdAt : now(),
        candidates: [],
        selectedCandidateId: '',
        ...(meta === undefined ? {} : { meta }),
      };
      state.messages.push(message);
      touchSession(sessionId);
      commit();
      return { ...message };
    },

    async update(id, content, status: MessageStatus = 'done') {
      const message = state.messages.find((item) => item.id === id);
      if (message === undefined) return false;
      message.content = content;
      message.status = status;
      commit();
      return true;
    },

    /** 追加候选回复（导入 swipes 的落点）：重复与空串都跳过，因此可以安全重放。 */
    async appendMany(sessionId, entries) {
      // 内存实现（测试/预览）逐条走同一个 append，语义与 op 实现一致；真机走 op 实现的批量路径。
      let added = 0;
      for (const entry of entries) {
        const view = await this.append(sessionId, entry.role, entry.content, entry.status ?? 'done', entry.createdAt, entry.meta);
        added += 1;
        if ((entry.candidates ?? []).length > 0) await this.appendCandidates(view.id, entry.candidates ?? []);
      }
      return added;
    },

    async appendCandidates(id, contents) {
      const message = state.messages.find((item) => item.id === id);
      if (message === undefined) return 0;
      let added = 0;
      for (const content of contents) {
        const clean = content.trim();
        if (clean === '') continue;
        if (message.content.trim() === clean) continue;
        if (message.candidates.some((candidate) => candidate.content === clean)) continue;
        message.candidates.push({ id: nextId('c'), content: clean });
        added += 1;
      }
      if (added > 0) commit();
      return added;
    },

    /** 选中某个候选：选中的那条成为显示正文。 */
    async selectCandidate(id, candidateId) {
      const message = state.messages.find((item) => item.id === id);
      if (message === undefined) return false;
      const candidate = message.candidates.find((item) => item.id === candidateId);
      if (candidate === undefined) return false;
      message.selectedCandidateId = candidateId;
      message.content = candidate.content;
      commit();
      return true;
    },

    async remove(id) {
      const before = state.messages.length;
      state.messages = state.messages.filter((item) => item.id !== id);
      if (state.messages.length !== before) {
        commit();
        return true;
      }
      return false;
    },
  };

  const settings: SettingsStore = {
    async get(key) {
      return state.settings[key];
    },
    async set(key, value) {
      state.settings[key] = value;
      commit();
    },
    async all() {
      return { ...state.settings };
    },
  };

  const findBook = (id: string): Lorebook | undefined => state.lorebooks.find((book) => book.id === id);

  /** 与宿主实现同样的规则：书删掉，条目一起消失。 */
  const lorebooks: LorebookStore = createLocalLoreStore({
    state,
    nextId,
    now: () => now(),
    commit,
  });

  const memories: MemoryStore = createLocalMemoryStore({
    state,
    nextId,
    now: () => now(),
    commit,
  });

  const summaries: SummaryStore = createLocalSummaryStore({ state, now: () => now(), commit });
  const facts: FactStore = createLocalFactStore({ state, now: () => now(), commit });

  return {
    kind: 'local',
    characters,
    sessions,
    messages,
    lorebooks,
    memories,
    summaries,
    facts,
    settings,
    async probe(): Promise<ProbeInfo> {
      return {
        path: '（内存/浏览器：没有宿主数据库）',
        journalMode: '—',
        pageSize: 0,
        sqliteVersion: '—',
        writable: true,
        characters: state.characters.length,
        sessions: state.sessions.length,
        messages: state.messages.length,
      };
    },
    snapshot: () => ({
      characters: state.characters.map((item) => ({ ...item })),
      sessions: [...state.sessions],
      messages: [...state.messages],
      lorebooks: state.lorebooks.map(copyBook),
      memories: state.memories.map((memory) => ({ ...memory, keys: [...memory.keys], sourceMessageIds: [...memory.sourceMessageIds] })),
      summaries: state.summaries.map((summary) => ({ ...summary, covers: [...summary.covers] })),
      facts: state.facts.map((fact) => ({ ...fact, sourceMessageIds: [...fact.sourceMessageIds] })),
      settings: { ...state.settings },
      sequence: state.sequence,
    }),
  };
}

/** 世界书是两级结构：返回副本时条目也要复制，避免调用方改到内部状态。 */
function copyBook(book: Lorebook): Lorebook {
  return {
    ...book,
    characterIds: [...book.characterIds],
    entries: book.entries.map((entry) => ({ ...entry, keys: [...entry.keys], secondaryKeys: [...entry.secondaryKeys] })),
  };
}

