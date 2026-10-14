import { memoryDelete, memoryUpsert, ulid, type HlcClock, type Materializer, type Op } from '../../../../packages/oplog/src/index.ts';
import { memoryView } from './op-views.ts';
import { DataError, validateMemoryDraft, type MemoryStore } from './repository.ts';
import type { MemoryDraft } from './types.ts';

/**
 * 长期记忆的 op 仓储（与世界书仓储同构，因此依赖同样只有四个动作）。
 *
 * 记忆是**内容**：进 op 日志、跟着同步走、可重建。
 * `createdBy` 记录"用户手写"还是"agent 建议后确认"，界面上要能分辨。
 */
export interface MemoryStoreDeps {
  withReady<T>(action: () => Promise<T>): Promise<T>;
  materializer(): Materializer;
  appendAndApply(ops: Op[]): Promise<void>;
  base(): { deviceId: string; clock: HlcClock };
}

export function createMemoryStore(deps: MemoryStoreDeps): MemoryStore {
  return {
    list: () => deps.withReady(async () => deps.materializer().memories().map(memoryView)),

    forCharacter: (characterId) =>
      deps.withReady(async () => deps.materializer().memoriesFor(characterId).map(memoryView)),

    save: (draft: MemoryDraft) =>
      deps.withReady(async () => {
        const clean = validateMemoryDraft(draft);
        const id = draft.id ?? ulid();
        if (draft.id !== undefined) {
          const existing = deps.materializer().state.memories[draft.id];
          if (existing === undefined || existing.deleted !== undefined) {
            throw new DataError('invalid-argument', '找不到该记忆');
          }
        }
        await deps.appendAndApply([memoryUpsert(deps.base(), { memoryId: id, ...clean })]);
        const record = deps.materializer().state.memories[id];
        if (record === undefined) throw new DataError('store-error', '写入后读不到该记忆');
        return memoryView(record);
      }),

    remove: (id) =>
      deps.withReady(async () => {
        const existing = deps.materializer().state.memories[id];
        if (existing === undefined || existing.deleted !== undefined) return false;
        await deps.appendAndApply([memoryDelete(deps.base(), { memoryId: id })]);
        return true;
      }),
  };
}
