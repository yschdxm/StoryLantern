import { DataError, validateCharacterDraft, validateMessageRole, validateSessionTitle, type CharacterStore, type MessageStore, type ProbeInfo, type Repository, type SessionStore, type SettingsStore } from './repository.ts';
import type { Character, CharacterDraft, Message, MessageRole, MessageStatus, Session, SettingsMap } from './types.ts';

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
  settings: SettingsMap;
  sequence: number;
}

export function emptyState(): RepositoryState {
  return { characters: [], sessions: [], messages: [], settings: {}, sequence: 0 };
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
    settings: { ...initial.settings },
    sequence: initial.sequence,
  };
  const now = options.now ?? (() => Date.now());
  const commit = (): void => options.onChange?.(state);
  const nextId = (): number => (state.sequence += 1);

  const findCharacter = (id: number): Character | undefined => state.characters.find((item) => item.id === id);

  const characters: CharacterStore = {
    async list() {
      return [...state.characters].sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
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
        id: nextId(),
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

  const touchSession = (sessionId: number): void => {
    const session = state.sessions.find((item) => item.id === sessionId);
    if (session !== undefined) session.updatedAt = now();
  };

  const sessions: SessionStore = {
    async list() {
      return [...state.sessions]
        .sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id)
        .map(buildSession);
    },

    async create(characterId, title) {
      const character = findCharacter(characterId);
      if (character === undefined) throw new DataError('invalid-argument', `角色 ${characterId} 不存在`);
      const stamp = now();
      const session: Session = {
        id: nextId(),
        title: title === undefined || title.trim() === '' ? character.name : validateSessionTitle(title),
        characterId,
        characterName: character.name,
        createdAt: stamp,
        updatedAt: stamp,
        messageCount: 0,
        lastMessage: '',
      };
      state.sessions.push(session);
      if (character.firstMessage.trim() !== '') {
        state.messages.push({
          id: nextId(),
          sessionId: session.id,
          role: 'assistant',
          content: character.firstMessage.trim(),
          status: 'done',
          createdAt: stamp,
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
      return state.messages.filter((message) => message.sessionId === sessionId).sort((a, b) => a.id - b.id);
    },

    async append(sessionId, role: MessageRole, content: string, status: MessageStatus = 'done') {
      const safeRole = validateMessageRole(role);
      const message: Message = {
        id: nextId(),
        sessionId,
        role: safeRole,
        content,
        status,
        createdAt: now(),
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

  return {
    kind: 'local',
    characters,
    sessions,
    messages,
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
      settings: { ...state.settings },
      sequence: state.sequence,
    }),
  };
}
