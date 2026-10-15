import { factDelete, factUpsert, listFacts, type FactRecord, type HlcClock, type Materializer, type Op } from '../../../../packages/oplog/src/index.ts';
import { DataError } from './repository.ts';
import type { Fact, FactDraft, FactStore } from './fact-types.ts';

/**
 * 设定库的 op 仓储（与记忆/摘要仓储同构，依赖同样只有四个动作）。
 *
 * 事实是**内容**：进 op 日志、跟着同步走、可重建 —— 所以它和记忆一样能被别的设备读到、被快照覆盖。
 * 写入按批（抽取器一次给出若干条），避免每条一次事务。
 */
export interface FactStoreDeps {
  withReady<T>(action: () => Promise<T>): Promise<T>;
  materializer(): Materializer;
  appendAndApply(ops: Op[]): Promise<void>;
  base(): { deviceId: string; clock: HlcClock };
}

/** 物化记录 → 界面记录（时间取 updatedHlc 的墙钟毫秒）。 */
export function factView(record: FactRecord): Fact {
  return {
    id: record.id,
    ...(record.characterId === undefined ? {} : { characterId: record.characterId }),
    subject: record.subject,
    predicate: record.predicate,
    object: record.object,
    text: record.text,
    sourceMessageIds: [...record.sourceMessageIds],
    ...(record.confidence === undefined ? {} : { confidence: record.confidence }),
    state: record.state,
    createdBy: record.createdBy,
    ...(record.modelId === undefined ? {} : { modelId: record.modelId }),
    ...(record.deleted === undefined ? {} : { deleted: true }),
    updatedAt: record.updatedHlc.t,
  };
}

function validateDraft(draft: FactDraft): void {
  if (draft.factId === '') throw new DataError('invalid-argument', '事实缺少 id');
  if (draft.subject.trim() === '' || draft.predicate.trim() === '' || draft.object.trim() === '') {
    throw new DataError('invalid-argument', '事实必须写全"主语 / 谓词 / 宾语"');
  }
  if (draft.sourceMessageIds.length === 0) {
    // 与 op 层同一道门槛：没有源消息的断言不许进库（这里先给出人能读的说明）
    throw new DataError('invalid-argument', '事实必须带来源消息（没有源消息的断言无法核对）');
  }
}

export function createFactStore(deps: FactStoreDeps): FactStore {
  return {
    list: (characterId) =>
      deps.withReady(async () =>
        listFacts(deps.materializer().state, characterId)
          .map(factView)
          .sort((a, b) => a.subject.localeCompare(b.subject) || a.predicate.localeCompare(b.predicate) || a.object.localeCompare(b.object)),
      ),

    save: (drafts) =>
      deps.withReady(async () => {
        if (drafts.length === 0) return [];
        for (const draft of drafts) validateDraft(draft);
        const ops: Op[] = drafts.map((draft) =>
          factUpsert(deps.base(), {
            factId: draft.factId,
            ...(draft.characterId === undefined || draft.characterId === '' ? {} : { characterId: draft.characterId }),
            subject: draft.subject.trim(),
            predicate: draft.predicate.trim(),
            object: draft.object.trim(),
            ...(draft.text === undefined || draft.text === '' ? {} : { text: draft.text }),
            sourceMessageIds: [...draft.sourceMessageIds],
            ...(draft.confidence === undefined ? {} : { confidence: draft.confidence }),
            state: draft.state,
            createdBy: draft.createdBy,
            ...(draft.modelId === undefined || draft.modelId === '' ? {} : { modelId: draft.modelId }),
          }),
        );
        await deps.appendAndApply(ops);
        const materializer = deps.materializer();
        return drafts
          .map((draft) => materializer.state.facts[draft.factId])
          .filter((record): record is FactRecord => record !== undefined)
          .map(factView);
      }),

    remove: (id) =>
      deps.withReady(async () => {
        const existing = deps.materializer().state.facts[id];
        if (existing === undefined || existing.deleted !== undefined) return false;
        await deps.appendAndApply([factDelete(deps.base(), { factId: id })]);
        return true;
      }),
  };
}
