import { createMemoryRepository, emptyState, type RepositoryState } from './memory-repository.ts';
import type { Repository } from './repository.ts';

/**
 * 纯浏览器里的持久化：localStorage。
 *
 * 为什么要有它：手机/桌面用宿主 SQLite，但**浏览器打开也应该能用**（PWA、以及开发时直接开页面）。
 * 两个实现共用内存实现那套语义，这里只负责"把状态存下来、下次再读回来"。
 */

export interface KeyValueStore {
  read(key: string): string | undefined;
  write(key: string, value: string): void;
  clear?(): void;
}

const STORAGE_KEY = 'storylantern.state.v1';

/** 内存键值：测试与"localStorage 不可用"时的降级。 */
export function createMemoryKeyValue(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    read: (key) => map.get(key),
    write: (key, value) => void map.set(key, value),
    clear: () => map.clear(),
  };
}

/** 浏览器 localStorage；被禁用/超配额时抛错，由调用方决定降级。 */
export function createBrowserKeyValue(storage: Storage): KeyValueStore {
  return {
    read: (key) => storage.getItem(key) ?? undefined,
    write: (key, value) => storage.setItem(key, value),
    clear: () => storage.removeItem(STORAGE_KEY),
  };
}

/** 读回上次的状态；坏数据（手改、版本不符）一律当作空状态，不让它把应用卡死。 */
export function loadState(store: KeyValueStore): RepositoryState {
  const raw = store.read(STORAGE_KEY);
  if (raw === undefined || raw === '') return emptyState();
  try {
    const parsed = JSON.parse(raw) as Partial<RepositoryState>;
    if (!Array.isArray(parsed.characters) || !Array.isArray(parsed.sessions) || !Array.isArray(parsed.messages)) {
      return emptyState();
    }
    return {
      // 旧版本没有 systemPrompt / alternateGreetings：按空值补齐，别让界面拿到 undefined
      characters: parsed.characters.map((character) => ({
        ...character,
        systemPrompt: character.systemPrompt ?? '',
        alternateGreetings: character.alternateGreetings ?? [],
      })),
      sessions: parsed.sessions,
      messages: parsed.messages,
      // 旧版本没有世界书/记忆：缺字段时按空数组读，不给用户报错
      lorebooks: Array.isArray(parsed.lorebooks) ? parsed.lorebooks : [],
      memories: Array.isArray(parsed.memories) ? parsed.memories : [],
      // 同一套兼容策略：旧数据没有摘要字段时按空数组读
      summaries: Array.isArray(parsed.summaries) ? parsed.summaries : [],
      // 同一套兼容策略：旧数据没有设定库字段时按空数组读
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
      settings: typeof parsed.settings === 'object' && parsed.settings !== null ? parsed.settings : {},
      sequence: typeof parsed.sequence === 'number' ? parsed.sequence : 0,
    };
  } catch {
    return emptyState();
  }
}

export function createLocalRepository(store: KeyValueStore): Repository & { persist(): void } {
  const repository = createMemoryRepository(loadState(store), {
    onChange: (state) => store.write(STORAGE_KEY, JSON.stringify(state)),
  });
  return {
    kind: 'local',
    characters: repository.characters,
    sessions: repository.sessions,
    messages: repository.messages,
    lorebooks: repository.lorebooks,
    memories: repository.memories,
    summaries: repository.summaries,
    facts: repository.facts,
    settings: repository.settings,
    ...(repository.probe === undefined ? {} : { probe: repository.probe }),
    persist: () => store.write(STORAGE_KEY, JSON.stringify(repository.snapshot())),
  };
}
