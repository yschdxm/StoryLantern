import { compareOpOrder } from './hlc.ts';
import { cloneHlc, laterThan, type ApplyResult } from './materialize-support.ts';
import type { MessageAuthor, MessageMeta, Op } from './op.ts';
import type { MaterializedState, MessageRecord } from './state-types.ts';

/**
 * 消息与设置的物化（纯函数）。
 *
 * 消息是这套协议里最复杂的一块：正文有版本（revision）、有多候选（candidate）、
 * 还有"用户显式选过哪一版"。规则集中在这里，别处不再判"谁赢"。
 */

export function applyMessageAppend(state: MaterializedState, op: Op): ApplyResult {
  const payload = op.payload as {
    sessionId: string;
    messageId: string;
    author: MessageAuthor;
    content: string;
    status?: 'done' | 'error' | 'stopped';
    meta?: MessageMeta;
  };
  const existing = state.messages[payload.messageId];
  const revisionId = `${payload.messageId}:r0`;

  if (existing === undefined) {
    const record: MessageRecord = {
      id: payload.messageId,
      sessionId: payload.sessionId,
      author: payload.author,
      appendHlc: cloneHlc(op.hlc),
      appendOpId: op.opId,
      revisions: [
        {
          revisionId,
          content: payload.content,
          baseRevisionId: null,
          hlc: cloneHlc(op.hlc),
          opId: op.opId,
          deviceId: op.deviceId,
        },
      ],
      activeRevision: { revisionId, hlc: cloneHlc(op.hlc), explicit: false },
      candidates: [],
      ...(payload.status === undefined ? {} : { status: payload.status, statusHlc: cloneHlc(op.hlc) }),
      ...(payload.meta === undefined ? {} : { meta: payload.meta }),
    };
    state.messages[payload.messageId] = record;
    return 'applied';
  }

  // 同一个 messageId 被两个设备各写一次（只可能来自克隆的设备数据）：保留首版语义，补上缺的版本
  if (existing.meta === undefined && payload.meta !== undefined) existing.meta = payload.meta;
  if (!existing.revisions.some((revision) => revision.revisionId === revisionId)) {
    existing.revisions.push({
      revisionId,
      content: payload.content,
      baseRevisionId: null,
      hlc: cloneHlc(op.hlc),
      opId: op.opId,
      deviceId: op.deviceId,
    });
  }
  if (compareOpOrder({ hlc: op.hlc, opId: op.opId }, { hlc: existing.appendHlc, opId: existing.appendOpId }) < 0) {
    existing.appendHlc = cloneHlc(op.hlc);
    existing.appendOpId = op.opId;
  }
  return 'applied';
}

export function applyMessageEdit(state: MaterializedState, op: Op): ApplyResult {
  const payload = op.payload as {
    messageId: string;
    revisionId: string;
    baseRevisionId: string;
    content: string;
    status?: 'done' | 'error' | 'stopped';
  };
  const message = state.messages[payload.messageId];
  if (message === undefined) return 'orphan';

  if (!message.revisions.some((revision) => revision.revisionId === payload.revisionId)) {
    message.revisions.push({
      revisionId: payload.revisionId,
      content: payload.content,
      baseRevisionId: payload.baseRevisionId,
      hlc: cloneHlc(op.hlc),
      opId: op.opId,
      deviceId: op.deviceId,
    });
  }

  // 状态与正文各走各的"最新者赢"，避免乱序时状态回退
  if (payload.status !== undefined && (message.statusHlc === undefined || laterThan(op.hlc, message.statusHlc, op.opId, undefined))) {
    message.status = payload.status;
    message.statusHlc = cloneHlc(op.hlc);
  }

  const active = message.activeRevision;
  const newer = laterThan(op.hlc, active.hlc, op.opId, undefined);
  // 显式选择过的版本可以压过更早的编辑；但更新的编辑一定生效（用户刚改完就该看到）
  if (active.explicit && !newer) return 'applied';
  if (newer) {
    message.activeRevision = { revisionId: payload.revisionId, hlc: cloneHlc(op.hlc), explicit: false };
  }
  return 'applied';
}

export function applyRevisionSelect(state: MaterializedState, op: Op): ApplyResult {
  const payload = op.payload as { messageId: string; revisionId: string };
  const message = state.messages[payload.messageId];
  if (message === undefined) return 'orphan';
  if (!message.revisions.some((revision) => revision.revisionId === payload.revisionId)) return 'orphan';
  if (!laterThan(op.hlc, message.activeRevision.hlc, op.opId, undefined)) return 'applied';
  message.activeRevision = { revisionId: payload.revisionId, hlc: cloneHlc(op.hlc), explicit: true };
  return 'applied';
}

export function applyCandidateAppend(state: MaterializedState, op: Op): ApplyResult {
  const payload = op.payload as { messageId: string; candidateId: string; content: string };
  const message = state.messages[payload.messageId];
  if (message === undefined) return 'orphan';
  if (message.candidates.some((candidate) => candidate.candidateId === payload.candidateId)) return 'applied';
  message.candidates.push({
    candidateId: payload.candidateId,
    content: payload.content,
    hlc: cloneHlc(op.hlc),
    opId: op.opId,
  });
  return 'applied';
}

export function applyCandidateSelect(state: MaterializedState, op: Op): ApplyResult {
  const payload = op.payload as { messageId: string; candidateId: string };
  const message = state.messages[payload.messageId];
  if (message === undefined) return 'orphan';
  if (!message.candidates.some((candidate) => candidate.candidateId === payload.candidateId)) return 'orphan';
  const current = message.selectedCandidate;
  if (current !== undefined && !laterThan(op.hlc, current.hlc, op.opId, undefined)) return 'applied';
  message.selectedCandidate = { candidateId: payload.candidateId, hlc: cloneHlc(op.hlc) };
  return 'applied';
}

export function applyMessageDelete(state: MaterializedState, op: Op): ApplyResult {
  const payload = op.payload as { messageId: string };
  const message = state.messages[payload.messageId];
  if (message === undefined) return 'orphan';
  if (message.deleted !== undefined && !laterThan(op.hlc, message.deleted.hlc, op.opId, undefined)) return 'applied';
  message.deleted = { hlc: cloneHlc(op.hlc) };
  return 'applied';
}

export function applySettingSet(state: MaterializedState, op: Op): ApplyResult {
  const payload = op.payload as { key: string; value: unknown };
  const existing = state.settings[payload.key];
  if (existing !== undefined && !laterThan(op.hlc, existing.hlc, op.opId, existing.opId)) return 'applied';
  state.settings[payload.key] = { value: payload.value, hlc: cloneHlc(op.hlc), opId: op.opId };
  return 'applied';
}
