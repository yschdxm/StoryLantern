import type { MessageDraft, Repository } from '../data/repository.ts';
import { forkSessionInRepository } from '../data/session-fork.ts';
import { appendMessageWithMeta } from '../data/message-append.ts';
import { DataError } from '../data/repository.ts';
import type { Summary, SummaryDraft } from '../data/summary-types.ts';
import type { Fact, FactDraft } from '../data/fact-types.ts';
import type {
  Character,
  CharacterDraft,
  Lorebook,
  LorebookDraft,
  LoreEntryDraft,
  Memory,
  MemoryDraft,
  Message, MessageMeta, MessageRevision, MessageFork,
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
  /** 所有长期记忆；同样在这里按角色筛。 */
  memories: Memory[];
  /** 设定库事实（M4）；界面按角色筛。 */
  facts: Fact[];
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
  /** 只读地取某个会话的消息：整理记忆时不该偷偷把用户的当前会话切走。 */
  messagesOf(sessionId: string): Promise<Message[]>;
  saveCharacter(draft: CharacterDraft): Promise<Character>;
  deleteCharacter(id: string): Promise<void>;
  createSession(characterId: string, title?: string, greetingIndex?: number): Promise<Session>;
  renameSession(id: string, title: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  send(sessionId: string, text: string, meta?: MessageMeta): Promise<void>;
  /** 追加一条消息（导入历史、或把生成结果落库都用它）；返回刚写入的那条。 */
  appendMessage(
    sessionId: string,
    role: Message['role'],
    content: string,
    options?: { createdAt?: number; status?: Message['status']; meta?: MessageMeta },
    candidates?: readonly string[],
    meta?: MessageMeta,
  ): Promise<Message>;
  updateMessage(id: string, content: string, status?: Message['status']): Promise<void>;
  /** B15：编辑正文（新版本，旧版保留）。 */ editMessage(id: string, content: string): Promise<boolean>;
  /** B16：切回某个历史版本。 */ selectMessageRevision(id: string, revisionId: string): Promise<boolean>;
  /** B15：某条消息的全部正文版本（内容按需取）。 */ messageRevisions(id: string): Promise<MessageRevision[]>;
  /** B16：分叉组（同基线多版本）。 */ messageForks(id: string): Promise<MessageFork[]>;
  /** B17：分叉会话（复制 setup + 全部消息；runtime 不复制）。 */ forkSession(sessionId: string, options?: { title?: string }): Promise<Session>;
  removeMessage(id: string): Promise<void>;
  setSetting(key: string, value: string): Promise<void>;
  // ---- 世界书 ----
  refreshLorebooks(): Promise<void>;
  saveLorebook(draft: LorebookDraft): Promise<Lorebook>;
  deleteLorebook(id: string): Promise<void>;
  saveLoreEntry(draft: LoreEntryDraft): Promise<Lorebook>;
  removeLoreEntry(lorebookId: string, entryId: string): Promise<void>;
  // ---- 长期记忆 ----
  /** 追加候选回复（导入 swipes 的落点）。 */
  appendCandidates(messageId: string, contents: readonly string[]): Promise<number>;
  /** 批量追加消息（导入历史用）：只发生一次仓储写入。 */
  appendMany(sessionId: string, entries: readonly MessageDraft[]): Promise<number>;
  /** 选中候选：选中的那条成为显示正文。 */
  selectCandidate(messageId: string, candidateId: string): Promise<boolean>;
  refreshMemories(): Promise<void>;
  saveMemory(draft: MemoryDraft): Promise<Memory>;
  /** 某个会话的分层摘要（M4）。 */
  summariesOf(sessionId: string): Promise<Summary[]>;
  /** 一次写入若干条摘要（编排层算出来的目标 + 生成的文本）。 */
  saveSummaries(sessionId: string, drafts: readonly SummaryDraft[]): Promise<Summary[]>;
  /** 设定库（M4）：某个角色能看到的事实（含全局）。 */
  factsOf(characterId?: string): Promise<Fact[]>;
  /** 一次写入若干条事实（抽取的提议、采纳/拒绝都走这里：只是 state 不同）。 */
  saveFacts(drafts: readonly FactDraft[]): Promise<Fact[]>;
  deleteMemory(id: string): Promise<void>;
}
export interface AppStore {
  getState(): AppState;
  subscribe(listener: (state: AppState) => void): () => void;
  actions: AppActions;
  readonly repository: Repository;
}
const INITIAL: AppState = {
  status: 'loading',
  characters: [],
  sessions: [],
  messages: [],
  lorebooks: [],
  memories: [],
  facts: [],
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
        const [characters, sessions, lorebooks, memories, settings] = await Promise.all([
          repository.characters.list(),
          repository.sessions.list(),
          repository.lorebooks.list(),
          repository.memories.list(),
          repository.settings.all(),
        ]);
        set({ characters, sessions, lorebooks, memories, settings, status: 'ready' });
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

    async appendCandidates(messageId, contents) {
      const added = await run('appendCandidates', () => repository.messages.appendCandidates(messageId, contents));
      // 候选落在别的消息上时，界面只关心当前会话：重新读一次就够
      if (added > 0 && state.activeSessionId !== undefined) await actions.loadMessages(state.activeSessionId);
      return added;
    },
    async selectCandidate(messageId, candidateId) {
      const changed = await run('selectCandidate', () => repository.messages.selectCandidate(messageId, candidateId));
      if (changed && state.activeSessionId !== undefined) await actions.loadMessages(state.activeSessionId);
      return changed;
    },
    async refreshMemories() {
      set({ memories: await repository.memories.list(), facts: await repository.facts.list() });
    },
    async summariesOf(sessionId) {
      return run('summariesOf', () => repository.summaries.list(sessionId));
    },
    async saveSummaries(sessionId, drafts) {
      if (drafts.length === 0) return [];
      return run('saveSummaries', () => repository.summaries.save(sessionId, drafts));
    },
    async factsOf(characterId) {
      return run('factsOf', () => repository.facts.list(characterId));
    },
    async saveFacts(drafts) {
      if (drafts.length === 0) return [];
      const written = await run('saveFacts', () => repository.facts.save(drafts));
      // 写完必须刷新切片：界面读的是 state.facts，不刷新就会一直显示空状态（真机上踩过）
      set({ facts: await repository.facts.list() });
      return written;
    },
    async saveMemory(draft) {
      const memory = await run('saveMemory', () => repository.memories.save(draft));
      await actions.refreshMemories();
      return memory;
    },
    async deleteMemory(id) {
      await run('deleteMemory', async () => {
        await repository.memories.remove(id);
      });
      await actions.refreshMemories();
    },
    async loadMessages(sessionId) {
      const messages = await repository.messages.list(sessionId);
      set({ messages, activeSessionId: sessionId });
    },
    messagesOf(sessionId) {
      return repository.messages.list(sessionId);
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
    createSession(characterId, title, greetingIndex) {
      return run('createSession', async () => {
        const session = await repository.sessions.create(characterId, title, greetingIndex);
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
    /** B17：分叉。复制失败时 `run` 会把 DataError 记进状态（界面可见），不静默。 */
    async forkSession(sessionId, options = {}) {
      const session = await run('forkSession', () => forkSessionInRepository(repository, sessionId, options));
      await refreshSessions();
      return session;
    },
    async send(sessionId, text, meta) {
      const content = text.trim();
      if (content === '') return;
      await run('send', async () => {
        await repository.messages.append(sessionId, 'user', content, 'done', undefined, meta);
        await Promise.all([actions.loadMessages(sessionId), refreshSessions()]);
      });
    },
    async appendMany(sessionId, entries) {
      const added = await repository.messages.appendMany(sessionId, entries);
      if (state.activeSessionId === sessionId) await actions.loadMessages(sessionId);
      const last = entries[entries.length - 1];
      if (last !== undefined) {
        // 同样只就地更新摘要：导入上万条不该打出上万次查询（调用方结束时 refreshSessions 对齐一次）
        set({
          sessions: state.sessions.map((session) =>
            session.id === sessionId
              ? {
                  ...session,
                  messageCount: session.messageCount + added,
                  lastMessage: last.content,
                  updatedAt: last.createdAt === undefined || last.createdAt <= 0 ? session.updatedAt : last.createdAt,
                }
              : session,
          ),
        });
      }
      return added;
    },
    async appendMessage(sessionId, role, content, options = {}, _candidates?, meta?) {
      const message = await appendMessageWithMeta(repository.messages, sessionId, role, content, options, meta);
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
      return message;
    },
    async updateMessage(id, content, status) {
      await run('updateMessage', async () => {
        await repository.messages.update(id, content, status);
        if (state.activeSessionId !== undefined) await actions.loadMessages(state.activeSessionId);
      });
    },
    async editMessage(id, content) {
      const changed = await run('editMessage', () => repository.messages.edit(id, content));
      if (changed && state.activeSessionId !== undefined) await actions.loadMessages(state.activeSessionId);
      return changed;
    },
    async selectMessageRevision(id, revisionId) {
      const changed = await run('selectMessageRevision', () => repository.messages.selectRevision(id, revisionId));
      if (changed && state.activeSessionId !== undefined) await actions.loadMessages(state.activeSessionId);
      return changed;
    },
    messageRevisions(id) {
      return run('messageRevisions', () => repository.messages.revisions(id));
    },
    messageForks(id) {
      return run('messageForks', () => repository.messages.forks(id));
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
    repository,
  };
}
