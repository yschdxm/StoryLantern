import type { Op } from './op.ts';
import { cloneHlc, isNewerThanRecord } from './materialize-support.ts';
import type { MaterializedState, SessionRecord } from './state-types.ts';

/**
 * 会话的物化：创建与改名是同一个 upsert（标题 LWW），删除是与写入共用时间线的墓碑。
 *
 * 读取顺序（"最近活跃"）不在这一层算：那需要看消息的 append HLC，
 * 由上层（应用的仓储）一起算，避免物化器知道"消息与会话的聚合关系"。
 */

export function applySessionUpsert(state: MaterializedState, op: Op): void {
  const payload = op.payload as { title: string; characterId?: string; forkedFrom?: string };
  const id = op.entity.id;
  const existing = state.sessions[id];

  if (existing === undefined) {
    const record: SessionRecord = {
      id,
      title: payload.title,
      titleHlc: cloneHlc(op.hlc),
      titleOpId: op.opId,
      createdHlc: cloneHlc(op.hlc),
    };
    if (payload.characterId !== undefined) record.characterId = payload.characterId;
    if (payload.forkedFrom !== undefined) record.forkedFrom = payload.forkedFrom;
    state.sessions[id] = record;
    return;
  }

  if (!isNewerThanRecord(op, stampOf(existing))) return;
  existing.title = payload.title;
  existing.titleHlc = cloneHlc(op.hlc);
  existing.titleOpId = op.opId;
  if (payload.characterId !== undefined) existing.characterId = payload.characterId;
  delete existing.deleted;
}

export function applySessionDelete(state: MaterializedState, op: Op): void {
  const id = op.entity.id;
  const existing = state.sessions[id];

  if (existing === undefined) {
    // 没见过这个会话也要留墓碑：别的设备可能还持有它的消息，需要它来收敛
    state.sessions[id] = {
      id,
      title: '',
      titleHlc: cloneHlc(op.hlc),
      titleOpId: op.opId,
      createdHlc: cloneHlc(op.hlc),
      deleted: { hlc: cloneHlc(op.hlc), opId: op.opId },
    };
    return;
  }

  if (!isNewerThanRecord(op, stampOf(existing))) return;
  existing.deleted = { hlc: cloneHlc(op.hlc), opId: op.opId };
}

/** 没被删除的会话（顺序由上层按"最近活跃"决定）。 */
export function liveSessions(state: MaterializedState): SessionRecord[] {
  return Object.values(state.sessions).filter((session) => session.deleted === undefined);
}

function stampOf(session: SessionRecord): { updatedHlc: { t: number; c: number }; opId: string; deleted?: { hlc: { t: number; c: number }; opId: string } } {
  // SessionRecord 用 titleHlc/titleOpId 表示"最近一次写入"，这里映射成通用形状
  return session.deleted === undefined
    ? { updatedHlc: session.titleHlc, opId: session.titleOpId }
    : { updatedHlc: session.titleHlc, opId: session.titleOpId, deleted: session.deleted };
}
