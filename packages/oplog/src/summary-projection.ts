import type { Op } from './op.ts';
import type { SummaryLevel } from './summary-ops.ts';
import { cloneHlc, isNewerThanRecord, type ApplyResult } from './materialize-support.ts';
import type { MaterializedState, SummaryRecord } from './state-types.ts';

/**
 * 分层摘要的物化（纯函数）：整体 LWW + 墓碑，与记忆/世界书同一套语义。
 *
 * 摘要没有父实体（不像世界书条目挂在书下面），从它出现的时刻起就是完整的。
 */

interface UpsertPayload {
  sessionId: string;
  level: SummaryLevel;
  covers: string[];
  contentHash: string;
  text: string;
  createdBy: 'user' | 'model';
  modelId?: string;
}

export function applySummaryUpsert(state: MaterializedState, op: Op): ApplyResult {
  const payload = op.payload as UpsertPayload;
  const id = op.entity.id;
  const existing = state.summaries[id];
  if (existing !== undefined && !isNewerThanRecord(op, existing)) return 'duplicate';

  state.summaries[id] = {
    id,
    sessionId: payload.sessionId,
    level: payload.level,
    covers: [...payload.covers],
    contentHash: payload.contentHash,
    text: payload.text,
    createdBy: payload.createdBy,
    ...(payload.modelId === undefined || payload.modelId === '' ? {} : { modelId: payload.modelId }),
    createdHlc: existing === undefined ? cloneHlc(op.hlc) : cloneHlc(existing.createdHlc),
    updatedHlc: cloneHlc(op.hlc),
    opId: op.opId,
  };
  return 'applied';
}

export function applySummaryDelete(state: MaterializedState, op: Op): ApplyResult {
  const id = op.entity.id;
  const existing = state.summaries[id];
  if (existing !== undefined && !isNewerThanRecord(op, existing)) return 'duplicate';

  state.summaries[id] = {
    id,
    sessionId: existing?.sessionId ?? '',
    level: existing?.level ?? 'scene',
    covers: existing?.covers ?? [],
    contentHash: existing?.contentHash ?? '',
    text: existing?.text ?? '',
    createdBy: existing?.createdBy ?? 'user',
    ...(existing?.modelId === undefined ? {} : { modelId: existing.modelId }),
    createdHlc: existing === undefined ? cloneHlc(op.hlc) : cloneHlc(existing.createdHlc),
    updatedHlc: cloneHlc(op.hlc),
    opId: op.opId,
    deleted: { hlc: cloneHlc(op.hlc), opId: op.opId },
  };
  return 'applied';
}

/** 全部活着的摘要（可选按会话、按层级筛）。 */
export function listSummaries(state: MaterializedState, sessionId?: string, level?: SummaryLevel): SummaryRecord[] {
  return Object.values(state.summaries).filter(
    (summary) =>
      summary.deleted === undefined &&
      (sessionId === undefined || summary.sessionId === sessionId) &&
      (level === undefined || summary.level === level),
  );
}
