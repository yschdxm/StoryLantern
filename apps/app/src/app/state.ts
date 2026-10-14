import type { Repository } from '../data/repository.ts';
import { DataError } from '../data/repository.ts';
import type {
  Character,
  CharacterDraft,
  Lorebook,
  LorebookDraft,
  LoreEntryDraft,
  Message,
  Session,
  SettingsMap,
} from '../data/types.ts';

/**
 * 应用状态：一个极小的可订阅 store。
 *
 * 界面只做两件事：读 `getState()`、调 `actions.*`。所有取数与写库都在这里发生，
 * 因此**逻辑能在 Node 里测**（注入内存仓储即可），组件只负责画。
 */

export type LoadStatus = 'loading' | 'ready' | 'error';

export interface AppState {
  status: LoadStatus;
  error?: string;
  characters: Character[];
  sessions: Session[];
  messages: Message[];
  /** 所有世界书（含未绑定的）；按角色筛选交给 `forCharacter` 这类工具函数。 */
  lorebooks: Lorebook[];
  activeSessionId?: string;
  settings: SettingsMap;
  /** 正在写库的操作名（用于按钮禁用/局部 loading）。 */
  busy?: string;
}

export interface AppActions {
  refresh(): Promise<void>;
  refreshCharacters(): Promise<void>;
  refreshSessions(): Promise<void>;
  loadMessages(sessionId: string): Promise<void>;
  saveCharacter(draft: CharacterDraft): Promise<Character>;
  deleteCharacter(id: string): Promise<void>;
  createSession(characterId: string, title?: string): Promise<Session>;
  renameSession(id: string, title: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  send(sessionId: string, text: string): Promise<void>;
  /** 追加一条消息（导入历史、或把生成结果落库都用它）。 */
  appendMessage(
    sessionId: string,
    role: Message['role'],
    content: string,
    options?: { createdAt?: number; status?: Message['status'] },
  ): Promise<void>;
  updateMessage(id: string, content: string, status?: Message['status']): Promise<void>;
  removeMessage(id: string): Promise<void>;
  setSetting(key: string, value: string): Promise<void>;
  // ---- 世界书 ----
  refreshLorebooks(): Promise<void>;
  saveLorebook(draft: LorebookDraft): Promise<Lorebook>;
  deleteLorebook(id: string): Promise<void>;
  saveLoreEntry(draft: LoreEntryDraft): Promise<Lorebook>;
  removeLoreEntry(lorebookId: string, entryId: string): Promise<void>;
}

export interface AppStore {
  getState(): AppState;
  subscribe(listener: (state: AppState) => void): () => void;
  actions: AppActions;
}

const INITIAL: AppState = {
  status: 'loading',
  characters: [],
  sessions: [],
  messages: [],
  lorebooks: [],
  settings: {},
};

function messageOf(cause: unknown): string {
  if (cause instanceof DataError) return cause.message;
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

export function createAppStore(repository: Repository): AppStore {
  let state: AppState = { ...INITIAL };
  const listeners = new Set<(state: AppState) => void>();

  /**
   * 部分更新。`undefined` 表示**移除**该可选字段（而不是写入 undefined）——
   * 这样调用方可以放心写 `set({ busy: undefined })`，不必到处拼 `...(x === undefined ? {} : ...)`。
   */
  const set = (patch: { [K in keyof AppState]?: AppState[K] | undefined }): void => {
    const next = { ...state } as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    state = next as unknown as AppState;
    for (const listener of listeners) listener(state);
  };

  /** 统一的写操作包装：置 busy、失败转成可见错误、最后清 busy。 */
  const run = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    set({ busy: name, error: undefined });
    try {
      return await action();
    } catch (cause) {
      const message = messageOf(cause);
      set({ error: message, status: state.characters.length === 0 && state.sessions.length === 0 ? 'error' : state.status });
      throw cause;
    } finally {
      set({ busy: undefined });
    }
  };

  const refreshCharacters = async (): Promise<void> => {
    set({ characters: await repository.characters.list() });
  };

  const refreshSessions = async (): Promise<void> => {
    set({ sessions: await repository.sessions.list() });
  };

  const actions: AppActions = {
    async refresh() {
      set({ status: 'loading', error: undefined });
      try {
        const [characters, sessions, lorebooks, settings] = await Promise.all([
          repository.characters.list(),
          repository.sessions.list(),
          repository.lorebooks.list(),
          repository.settings.all(),
        ]);
        set({ characters, sessions, lorebooks, settings, status: 'ready' });
      } catch (cause) {
        set({ status: 'error', error: messageOf(cause) });
      }
    },

    refreshCharacters,
    refreshSessions,

    async refreshLorebooks() {
      set({ lorebooks: await repository.lorebooks.list() });
    },

    async saveLorebook(draft) {
      const book = await run('saveLorebook', () => repository.lorebooks.save(draft));
      await actions.refreshLorebooks();
      return book;
    },

    async deleteLorebook(id) {
      await run('deleteLorebook', async () => {
        await repository.lorebooks.remove(id);
      });
      await actions.refreshLorebooks();
    },

    async saveLoreEntry(draft) {
      const book = await run('saveLoreEntry', () => repository.lorebooks.saveEntry(draft));
      await actions.refreshLorebooks();
      return book;
    },

    async removeLoreEntry(lorebookId, entryId) {
      await run('removeLoreEntry', async () => {
        await repository.lorebooks.removeEntry(lorebookId, entryId);
      });
      await actions.refreshLorebooks();
    },

    async loadMessages(sessionId) {
      const messages = await repository.messages.list(sessionId);
      set({ messages, activeSessionId: sessionId });
    },

    saveCharacter(draft) {
      return run('saveCharacter', async () => {
        const saved = await repository.characters.save(draft);
        await refreshCharacters();
        return saved;
      });
    },

    async deleteCharacter(id) {
      await run('deleteCharacter', async () => {
        await repository.characters.remove(id);
        await Promise.all([refreshCharacters(), refreshSessions()]);
        if (state.activeSessionId !== undefined) {
          const stillThere = state.sessions.some((session) => session.id === state.activeSessionId);
          if (!stillThere) set({ messages: [], activeSessionId: undefined });
        }
      });
    },

    createSession(characterId, title) {
      return run('createSession', async () => {
        const session = await repository.sessions.create(characterId, title);
        // 顺手把新会话的消息装进状态：界面紧接着就会进聊天页，
        // 不这样做会先闪一下"还没有消息"再补上开场白。
        const messages = await repository.messages.list(session.id);
        await refreshSessions();
        set({ messages, activeSessionId: session.id });
        return session;
      });
    },

    async renameSession(id, title) {
      await run('renameSession', async () => {
        await repository.sessions.rename(id, title);
        await refreshSessions();
      });
    },

    async deleteSession(id) {
      await run('deleteSession', async () => {
        await repository.sessions.remove(id);
        await refreshSessions();
        if (state.activeSessionId === id) set({ messages: [], activeSessionId: undefined });
      });
    },

    async send(sessionId, text) {
      const content = text.trim();
      if (content === '') return;
      await run('send', async () => {
        await repository.messages.append(sessionId, 'user', content, 'done');
        await Promise.all([actions.loadMessages(sessionId), refreshSessions()]);
      });
    },

    async appendMessage(sessionId, role, content, options = {}) {
      const message = await repository.messages.append(
        sessionId,
        role,
        content,
        options.status ?? 'done',
        ...(options.createdAt === undefined ? [] : [options.createdAt]),
      );
      if (state.activeSessionId === sessionId) await actions.loadMessages(sessionId);
      // 就地更新会话摘要（条数/最后一条/时间）。
      // 不在这里逐条 refreshSessions：导入上万条历史会打出上万次查询。
      // 批量导入结束时由调用方跑一次 refreshSessions 对齐。
      set({
        sessions: state.sessions.map((session) =>
          session.id === sessionId
            ? { ...session, messageCount: session.messageCount + 1, lastMessage: content, updatedAt: message.createdAt }
            : session,
        ),
      });
    },

    async updateMessage(id, content, status) {
      await run('updateMessage', async () => {
        await repository.messages.update(id, content, status);
        if (state.activeSessionId !== undefined) await actions.loadMessages(state.activeSessionId);
      });
    },

    async removeMessage(id) {
      await run('removeMessage', async () => {
        await repository.messages.remove(id);
        if (state.activeSessionId !== undefined) await actions.loadMessages(state.activeSessionId);
      });
    },

    async setSetting(key, value) {
      await run('setSetting', async () => {
        await repository.settings.set(key, value);
        set({ settings: { ...state.settings, [key]: value } });
      });
    },
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    actions,
  };
}
