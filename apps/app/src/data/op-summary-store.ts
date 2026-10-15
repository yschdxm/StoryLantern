import {
  listSummaries,
  summaryDelete,
  summaryUpsert,
  type HlcClock,
  type Materializer,
  type Op,
  type SummaryRecord,
} from '../../../../packages/oplog/src/index.ts';
import { DataError } from './repository.ts';
import type { Summary, SummaryDraft, SummaryStore } from './summary-types.ts';

/**
 * 分层摘要的 op 仓储（与记忆/世界书仓储同构，依赖同样只有四个动作）。
 *
 * 摘要是**内容**：进 op 日志、跟着同步走、可重建——所以它和记忆一样能被别的设备读到，
 * 也能被快照覆盖。写入按批（执行器一次就能给出几十条），避免每条 op 一次事务。
 */
export interface SummaryStoreDeps {
  withReady<T>(action: () => Promise<T>): Promise<T>;
  materializer(): Materializer;
  appendAndApply(ops: Op[]): Promise<void>;
  base(): { deviceId: string; clock: HlcClock };
}

/** 物化记录 → 界面记录（时间取 updatedHlc 的墙钟毫秒）。 */
export function summaryView(record: SummaryRecord): Summary {
  return {
    id: record.id,
    sessionId: record.sessionId,
    level: record.level,
    covers: [...record.covers],
    contentHash: record.contentHash,
    text: record.text,
    createdBy: record.createdBy,
    ...(record.modelId === undefined ? {} : { modelId: record.modelId }),
    ...(record.deleted === undefined ? {} : { deleted: true }),
    updatedAt: record.updatedHlc.t,
  };
}

function validateDraft(draft: SummaryDraft): void {
  if (draft.summaryId === '' || draft.sessionId === '') throw new DataError('invalid-argument', '摘要缺少 id 或会话');
  if (draft.covers.length === 0) throw new DataError('invalid-argument', '摘要必须写明它覆盖了哪些下层内容');
  if (draft.contentHash === '') throw new DataError('invalid-argument', '摘要必须带内容指纹（否则无法判断失效）');
}

export function createSummaryStore(deps: SummaryStoreDeps): SummaryStore {
  return {
    list: (sessionId) =>
      deps.withReady(async () =>
        listSummaries(deps.materializer().state, sessionId)
          .map(summaryView)
          .sort((a, b) => a.level.localeCompare(b.level) || a.id.localeCompare(b.id)),
      ),

    save: (sessionId, drafts) =>
      deps.withReady(async () => {
        if (drafts.length === 0) return [];
        for (const draft of drafts) validateDraft(draft);
        const ops: Op[] = drafts.map((draft) =>
          summaryUpsert(deps.base(), {
            summaryId: draft.summaryId,
            sessionId,
            level: draft.level,
            covers: [...draft.covers],
            contentHash: draft.contentHash,
            text: draft.text,
            createdBy: 'model',
            ...(draft.modelId === undefined ? {} : { modelId: draft.modelId }),
          }),
        );
        await deps.appendAndApply(ops);
        const materializer = deps.materializer();
        return drafts
          .map((draft) => materializer.state.summaries[draft.summaryId])
          .filter((record): record is SummaryRecord => record !== undefined)
          .map(summaryView);
      }),

    remove: (id) =>
      deps.withReady(async () => {
        const existing = deps.materializer().state.summaries[id];
        if (existing === undefined || existing.deleted !== undefined) return false;
        await deps.appendAndApply([summaryDelete(deps.base(), { summaryId: id })]);
        return true;
      }),
  };
}
