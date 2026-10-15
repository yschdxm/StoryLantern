import { DataError } from './repository.ts';
import type { Summary, SummaryDraft, SummaryStore } from './summary-types.ts';
import type { RepositoryState } from './memory-repository.ts';

/**
 * 分层摘要的**内存版**仓储（与 `local-memory-store.ts` 同一个位置与角色）。
 *
 * 为什么单独成文件：`memory-repository.ts` 已经贴着门禁的 400 行上限，而这一块是完整可分离的职责。
 *
 * 与宿主版**可见行为一致**：list 只看活着的、save 批量写入、remove 之后 list 里没有。
 * 差别只在表示方式：宿主版删除是**墓碑**（跟着 op 日志走、可同步），内存版直接摘掉数组元素
 * （它本来就是预览/契约参照用的零依赖实现）。对外表现一致即可。
 */
export interface LocalSummaryStoreDeps {
  state: RepositoryState;
  now: () => number;
  commit: () => void;
}

export function createLocalSummaryStore(deps: LocalSummaryStoreDeps): SummaryStore {
  const { state, now, commit } = deps;
  return {
    async list(sessionId) {
      return state.summaries
        .filter((summary) => sessionId === undefined || summary.sessionId === sessionId)
        .map((summary) => ({ ...summary, covers: [...summary.covers] }))
        .sort((a, b) => a.level.localeCompare(b.level) || a.id.localeCompare(b.id));
    },

    async save(sessionId, drafts: readonly SummaryDraft[]) {
      const written: Summary[] = [];
      for (const draft of drafts) {
        if (draft.summaryId === '' || draft.covers.length === 0 || draft.contentHash === '') {
          throw new DataError('invalid-argument', '摘要缺少 id、覆盖范围或内容指纹');
        }
        const record: Summary = {
          id: draft.summaryId,
          sessionId,
          level: draft.level,
          covers: [...draft.covers],
          contentHash: draft.contentHash,
          text: draft.text,
          createdBy: 'model',
          ...(draft.modelId === undefined ? {} : { modelId: draft.modelId }),
          updatedAt: now(),
        };
        const index = state.summaries.findIndex((item) => item.id === record.id);
        if (index >= 0) state.summaries[index] = record;
        else state.summaries.push(record);
        written.push(record);
      }
      if (drafts.length > 0) commit();
      return written;
    },

    async remove(id) {
      const index = state.summaries.findIndex((item) => item.id === id);
      if (index < 0) return false;
      state.summaries.splice(index, 1);
      commit();
      return true;
    },
  };
}
