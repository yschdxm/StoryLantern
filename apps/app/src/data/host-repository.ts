import { WireClient, WireError, type WireTransport } from '../../../../packages/wire/src/index.ts';
import { DataError, type CharacterStore, type MessageStore, type ProbeInfo, type Repository, type SessionStore, type SettingsStore } from './repository.ts';
import { validateCharacterDraft, validateMessageRole, validateSessionTitle } from './repository.ts';
import type { Character, CharacterDraft, Message, MessageRole, MessageStatus, Session, SettingsMap } from './types.ts';

/**
 * 宿主实现：走 wire → Rust/SQLite（桌面与 Android）。
 *
 * 职责只有一个：**在协议与界面之间做翻译**，并且不藏错——
 * 宿主的错误码原样传上来（`DataError.code`），界面才能给出有意义的提示。
 * 校验在前端也做一遍（快速失败、文案一致），宿主侧仍然独立校验（不信任客户端）。
 */

interface RawCharacter {
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

function toDataError(cause: unknown): DataError {
  if (cause instanceof DataError) return cause;
  if (cause instanceof WireError) return new DataError(cause.code, cause.message);
  return new DataError('unknown', cause instanceof Error ? cause.message : String(cause));
}

export function createHostRepository(transport: WireTransport): Repository {
  const client = new WireClient(transport);

  const call = async <T>(service: string, method: string, ...args: unknown[]): Promise<T> => {
    try {
      return await client.call<T>(service, method, ...args);
    } catch (cause) {
      throw toDataError(cause);
    }
  };

  const characters: CharacterStore = {
    list: () => call<Character[]>('characters', 'list'),

    async get(id) {
      const character = await call<Character | null>('characters', 'get', id);
      return character ?? undefined;
    },

    async save(draft: CharacterDraft) {
      // 前端也校验一遍：文案与宿主一致，且不必为一个空名字跑一趟 IPC
      const clean = validateCharacterDraft(draft);
      const payload = {
        ...(draft.id === undefined ? {} : { id: draft.id }),
        name: clean.name,
        description: clean.description,
        personality: clean.personality,
        scenario: clean.scenario,
        firstMessage: clean.firstMessage,
        exampleDialogue: clean.exampleDialogue,
      };
      return call<RawCharacter>('characters', 'save', payload);
    },

    async remove(id) {
      const result = await call<{ removed: boolean }>('characters', 'delete', id);
      return result.removed;
    },
  };

  const sessions: SessionStore = {
    list: () => call<Session[]>('sessions', 'list'),

    async create(characterId, title) {
      const clean = title === undefined || title.trim() === '' ? '' : validateSessionTitle(title);
      return call<Session>('sessions', 'create', characterId, clean);
    },

    async rename(id, title) {
      const clean = validateSessionTitle(title);
      const result = await call<{ renamed: boolean }>('sessions', 'rename', id, clean);
      return result.renamed;
    },

    async remove(id) {
      const result = await call<{ removed: boolean }>('sessions', 'delete', id);
      return result.removed;
    },
  };

  const messages: MessageStore = {
    list: (sessionId) => call<Message[]>('messages', 'list', sessionId),

    async append(sessionId, role: MessageRole, content: string, status: MessageStatus = 'done') {
      const safeRole = validateMessageRole(role);
      return call<Message>('messages', 'append', sessionId, safeRole, content, status);
    },

    async update(id, content, status: MessageStatus = 'done') {
      const result = await call<{ updated: boolean }>('messages', 'update', id, content, status);
      return result.updated;
    },

    async remove(id) {
      const result = await call<{ removed: boolean }>('messages', 'delete', id);
      return result.removed;
    },
  };

  const settings: SettingsStore = {
    async get(key) {
      const result = await call<{ value: string | null }>('settings', 'get', key);
      return result.value ?? undefined;
    },
    async set(key, value) {
      await call<{ saved: boolean }>('settings', 'set', key, value);
    },
    all: () => call<SettingsMap>('settings', 'all'),
  };

  return {
    kind: 'host',
    characters,
    sessions,
    messages,
    settings,
    probe: () => call<ProbeInfo>('store', 'probe'),
  };
}
