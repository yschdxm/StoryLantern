import { DataError } from './repository.ts';
import type { RepositoryState } from './memory-repository.ts';
import type { Fact, FactDraft, FactStore } from './fact-types.ts';

/**
 * 设定库的**内存版**仓储（与 `local-summary-store.ts` 同一个角色）。
 *
 * 与宿主版**可见行为一致**：list 只看活着的、save 批量写入、remove 之后 list 里没有。
 * 差别只在表示方式：宿主版删除是**墓碑**（跟着 op 日志走），内存版直接摘掉数组元素
 * —— 它本来就是预览/契约参照用的零依赖实现。
 */
export interface LocalFactStoreDeps {
  state: RepositoryState;
  now: () => number;
  commit: () => void;
}

export function createLocalFactStore(deps: LocalFactStoreDeps): FactStore {
  const { state, now, commit } = deps;
  return {
    async list(characterId) {
      return state.facts
        .filter((fact) => characterId === undefined || fact.characterId === undefined || fact.characterId === characterId)
        .map((fact) => ({ ...fact, sourceMessageIds: [...fact.sourceMessageIds] }))
        .sort(
          (a, b) =>
            a.subject.localeCompare(b.subject) || a.predicate.localeCompare(b.predicate) || a.object.localeCompare(b.object),
        );
    },

    async save(drafts: readonly FactDraft[]) {
      const written: Fact[] = [];
      for (const draft of drafts) {
        if (draft.subject.trim() === '' || draft.predicate.trim() === '' || draft.object.trim() === '') {
          throw new DataError('invalid-argument', '事实必须写全"主语 / 谓词 / 宾语"');
        }
        if (draft.sourceMessageIds.length === 0) {
          throw new DataError('invalid-argument', '事实必须带来源消息（没有源消息的断言无法核对）');
        }
        const record: Fact = {
          id: draft.factId,
          ...(draft.characterId === undefined || draft.characterId === '' ? {} : { characterId: draft.characterId }),
          subject: draft.subject.trim(),
          predicate: draft.predicate.trim(),
          object: draft.object.trim(),
          text: draft.text ?? `${draft.subject.trim()}${draft.predicate.trim()}${draft.object.trim()}`,
          sourceMessageIds: [...draft.sourceMessageIds],
          ...(draft.confidence === undefined ? {} : { confidence: draft.confidence }),
          state: draft.state,
          createdBy: draft.createdBy,
          ...(draft.modelId === undefined || draft.modelId === '' ? {} : { modelId: draft.modelId }),
          updatedAt: now(),
        };
        const index = state.facts.findIndex((item) => item.id === record.id);
        if (index >= 0) state.facts[index] = record;
        else state.facts.push(record);
        written.push(record);
      }
      if (drafts.length > 0) commit();
      return written;
    },

    async remove(id) {
      const index = state.facts.findIndex((item) => item.id === id);
      if (index < 0) return false;
      state.facts.splice(index, 1);
      commit();
      return true;
    },
  };
}
