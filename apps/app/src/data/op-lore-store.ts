import {
  loreEntryDelete,
  loreEntryUpsert,
  lorebookDelete,
  lorebookUpsert,
  ulid,
  type HlcClock,
  type Materializer,
  type Op,
} from '../../../../packages/oplog/src/index.ts';
import { lorebookView } from './op-views.ts';
import { DataError, validateLoreEntryDraft, validateLorebookDraft, type LorebookStore } from './repository.ts';
import type { LoreEntryDraft, LorebookDraft } from './types.ts';

/**
 * 世界书的 op 仓储（从 `op-repository.ts` 拆出来：那里已经接近行数上限，
 * 而世界书这块还会随"自动维护"继续长大）。
 *
 * 依赖只有四个动作：等就绪、拿物化器、追加 op、拿 base。
 * 这样它不必知道 op 日志存在哪、怎么落盘——那些是 `op-repository.ts` 的事。
 */
export interface LoreStoreDeps {
  withReady<T>(action: () => Promise<T>): Promise<T>;
  materializer(): Materializer;
  appendAndApply(ops: Op[]): Promise<void>;
  base(): { deviceId: string; clock: HlcClock };
}

export function createLoreStore(deps: LoreStoreDeps): LorebookStore {
  return {
    list: () => deps.withReady(async () => deps.materializer().lorebooks().map(lorebookView)),

    get: (id) =>
      deps.withReady(async () => {
        const record = deps.materializer().state.lorebooks[id];
        if (record === undefined || record.deleted !== undefined) return undefined;
        return lorebookView(record);
      }),

    forCharacter: (characterId) =>
      deps.withReady(async () => deps.materializer().lorebooksFor(characterId).map(lorebookView)),

    save: (draft: LorebookDraft) =>
      deps.withReady(async () => {
        const clean = validateLorebookDraft(draft);
        const id = draft.id ?? ulid();
        if (draft.id !== undefined) {
          const existing = deps.materializer().state.lorebooks[draft.id];
          if (existing === undefined || existing.deleted !== undefined) {
            throw new DataError('invalid-argument', '找不到该世界书');
          }
        }
        await deps.appendAndApply([lorebookUpsert(deps.base(), { lorebookId: id, ...clean })]);
        const record = deps.materializer().state.lorebooks[id];
        if (record === undefined) throw new DataError('store-error', '写入后读不到该世界书');
        return lorebookView(record);
      }),

    remove: (id) =>
      deps.withReady(async () => {
        const existing = deps.materializer().state.lorebooks[id];
        if (existing === undefined || existing.deleted !== undefined) return false;
        await deps.appendAndApply([lorebookDelete(deps.base(), { lorebookId: id })]);
        return true;
      }),

    saveEntry: (draft: LoreEntryDraft) =>
      deps.withReady(async () => {
        const book = deps.materializer().state.lorebooks[draft.lorebookId];
        if (book === undefined || book.deleted !== undefined) {
          throw new DataError('invalid-argument', '找不到该世界书');
        }
        const existing = draft.id === undefined ? undefined : book.entries[draft.id];
        if (draft.id !== undefined && (existing === undefined || existing.deleted !== undefined)) {
          throw new DataError('invalid-argument', '找不到该条目');
        }
        // 部分更新：没给的字段沿用原值。否则"只改正文"会因为缺关键词被判无效——
        // 将来的「lore 自动维护」也会这样逐字段调用。
        const clean = validateLoreEntryDraft({
          ...draft,
          keys: draft.keys ?? existing?.keys ?? [],
          secondaryKeys: draft.secondaryKeys ?? existing?.secondaryKeys ?? [],
          content: draft.content ?? existing?.content ?? '',
          enabled: draft.enabled ?? existing?.enabled ?? true,
          order: draft.order ?? existing?.order ?? 100,
          caseSensitive: draft.caseSensitive ?? existing?.caseSensitive ?? false,
          recursive: draft.recursive ?? existing?.recursive ?? true,
          depth: draft.depth ?? existing?.depth ?? 0,
          constant: draft.constant ?? existing?.constant ?? false,
        });
        const entryId = draft.id ?? ulid();
        await deps.appendAndApply([loreEntryUpsert(deps.base(), { entryId, ...clean })]);
        const updated = deps.materializer().state.lorebooks[draft.lorebookId];
        if (updated === undefined) throw new DataError('store-error', '写入后读不到该世界书');
        return lorebookView(updated);
      }),

    removeEntry: (lorebookId, entryId) =>
      deps.withReady(async () => {
        const book = deps.materializer().state.lorebooks[lorebookId];
        if (book === undefined || book.deleted !== undefined) return undefined;
        const entry = book.entries[entryId];
        if (entry === undefined || entry.deleted !== undefined) return undefined;
        await deps.appendAndApply([loreEntryDelete(deps.base(), { lorebookId, entryId })]);
        const updated = deps.materializer().state.lorebooks[lorebookId];
        return updated === undefined ? undefined : lorebookView(updated);
      }),
  };
}
