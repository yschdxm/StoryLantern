import { DataError, validateMemoryDraft, type MemoryStore } from './repository.ts';
import type { Memory, MemoryDraft } from './types.ts';
import type { RepositoryState } from './memory-repository.ts';

/**
 * 内存/浏览器实现里的长期记忆仓储。
 *
 * 单独一个文件：`memory-repository.ts` 已经接近行数上限，而"语义参考实现"的每一块
 * 都应当像 op 仓储那样能单独阅读（`op-memory-store.ts` 是它的对应物）。
 */
export interface LocalMemoryDeps {
  state: RepositoryState;
  nextId(prefix: string): string;
  now(): number;
  commit(): void;
}

export function createLocalMemoryStore(deps: LocalMemoryDeps): MemoryStore {
  const copy = (memory: Memory): Memory => ({
    ...memory,
    keys: [...memory.keys],
    sourceMessageIds: [...memory.sourceMessageIds],
  });

  return {
    async list() {
      return [...deps.state.memories]
        .sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt)
        .map(copy);
    },

    async forCharacter(characterId) {
      return (await this.list()).filter((memory) => memory.characterId === '' || memory.characterId === (characterId ?? ''));
    },

    async save(draft: MemoryDraft) {
      const clean = validateMemoryDraft(draft);
      const stamp = deps.now();
      if (draft.id !== undefined) {
        const existing = deps.state.memories.find((memory) => memory.id === draft.id);
        if (existing === undefined) throw new DataError('invalid-argument', '找不到该记忆');
        Object.assign(existing, {
          text: clean.text,
          keys: clean.keys,
          importance: clean.importance,
          characterId: clean.characterId ?? '',
          sourceSessionId: clean.sourceSessionId ?? '',
          sourceMessageIds: clean.sourceMessageIds,
          createdBy: clean.createdBy,
          updatedAt: stamp,
        });
        deps.commit();
        return copy(existing);
      }
      const created: Memory = {
        id: deps.nextId('mem'),
        characterId: clean.characterId ?? '',
        text: clean.text,
        keys: clean.keys,
        importance: clean.importance,
        sourceSessionId: clean.sourceSessionId ?? '',
        sourceMessageIds: clean.sourceMessageIds,
        createdBy: clean.createdBy,
        createdAt: stamp,
        updatedAt: stamp,
      };
      deps.state.memories.push(created);
      deps.commit();
      return copy(created);
    },

    async remove(id) {
      const before = deps.state.memories.length;
      deps.state.memories = deps.state.memories.filter((memory) => memory.id !== id);
      if (deps.state.memories.length === before) return false;
      deps.commit();
      return true;
    },
  };
}
