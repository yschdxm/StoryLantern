import { DataError, validateLoreEntryDraft, validateLorebookDraft, type LorebookStore } from './repository.ts';
import type { Lorebook, LorebookDraft, LoreEntry, LoreEntryDraft } from './types.ts';
import type { RepositoryState } from './memory-repository.ts';

/**
 * 内存/浏览器实现里的世界书仓储（`op-lore-store.ts` 的对应物）。
 *
 * 语义必须与 op 仓储完全一致：书删掉 → 条目一起消失；更新条目时没给的字段沿用原值。
 * 这些规则由同一套契约测试盯着。
 */
export interface LocalLoreDeps {
  state: RepositoryState;
  nextId(prefix: string): string;
  now(): number;
  commit(): void;
}

export function createLocalLoreStore(deps: LocalLoreDeps): LorebookStore {
  const findBook = (id: string): Lorebook | undefined => deps.state.lorebooks.find((book) => book.id === id);

  return {
    async list() {
      return [...deps.state.lorebooks]
        .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
        .map(copyBook);
    },

    async get(id) {
      const book = findBook(id);
      return book === undefined ? undefined : copyBook(book);
    },

    async forCharacter(characterId) {
      return deps.state.lorebooks
        .filter(
          (book) =>
            book.enabled && (book.characterIds.length === 0 || (characterId !== undefined && book.characterIds.includes(characterId))),
        )
        .map(copyBook);
    },

    async save(draft: LorebookDraft) {
      const clean = validateLorebookDraft(draft);
      const stamp = deps.now();
      if (draft.id !== undefined) {
        const existing = findBook(draft.id);
        if (existing === undefined) throw new DataError('invalid-argument', '找不到该世界书');
        Object.assign(existing, clean, { updatedAt: stamp });
        deps.commit();
        return copyBook(existing);
      }
      const created: Lorebook = { id: deps.nextId('l'), ...clean, entries: [], createdAt: stamp, updatedAt: stamp };
      deps.state.lorebooks.push(created);
      deps.commit();
      return copyBook(created);
    },

    async remove(id) {
      const before = deps.state.lorebooks.length;
      deps.state.lorebooks = deps.state.lorebooks.filter((book) => book.id !== id);
      if (deps.state.lorebooks.length === before) return false;
      deps.commit();
      return true;
    },

    async saveEntry(draft: LoreEntryDraft) {
      const book = findBook(draft.lorebookId);
      if (book === undefined) throw new DataError('invalid-argument', '找不到该世界书');
      const stamp = deps.now();
      if (draft.id !== undefined) {
        const existing = book.entries.find((entry) => entry.id === draft.id);
        if (existing === undefined) throw new DataError('invalid-argument', '找不到该条目');
        // 部分更新：没给的字段沿用原值（与 op 仓储同一条规则）
        const clean = validateLoreEntryDraft({
          ...draft,
          keys: draft.keys ?? existing.keys,
          secondaryKeys: draft.secondaryKeys ?? existing.secondaryKeys,
          content: draft.content ?? existing.content,
          enabled: draft.enabled ?? existing.enabled,
          order: draft.order ?? existing.order,
          caseSensitive: draft.caseSensitive ?? existing.caseSensitive,
          recursive: draft.recursive ?? existing.recursive,
          depth: draft.depth ?? existing.depth,
          constant: draft.constant ?? existing.constant,
          comment: draft.comment ?? existing.comment,
        });
        Object.assign(existing, clean, { updatedAt: stamp });
      } else {
        const clean = validateLoreEntryDraft(draft);
        const created: LoreEntry = {
          id: deps.nextId('e'),
          keys: clean.keys,
          secondaryKeys: clean.secondaryKeys,
          content: clean.content,
          enabled: clean.enabled,
          order: clean.order,
          caseSensitive: clean.caseSensitive,
          recursive: clean.recursive,
          depth: clean.depth,
          constant: clean.constant,
          comment: clean.comment,
          createdAt: stamp,
          updatedAt: stamp,
        };
        book.entries.push(created);
      }
      book.updatedAt = stamp;
      deps.commit();
      return copyBook(book);
    },

    async removeEntry(lorebookId, entryId) {
      const book = findBook(lorebookId);
      if (book === undefined) return undefined;
      const before = book.entries.length;
      book.entries = book.entries.filter((entry) => entry.id !== entryId);
      if (book.entries.length === before) return undefined;
      book.updatedAt = deps.now();
      deps.commit();
      return copyBook(book);
    },
  };
}

/** 世界书是两级结构：返回副本时条目也要复制，避免调用方改到内部状态。 */
export function copyBook(book: Lorebook): Lorebook {
  return {
    ...book,
    characterIds: [...book.characterIds],
    entries: book.entries.map((entry) => ({ ...entry, keys: [...entry.keys], secondaryKeys: [...entry.secondaryKeys] })),
  };
}
