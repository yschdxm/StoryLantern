import type { MaterializedState, MessageRecord } from './state-types.ts';
import type { SessionSnapshot } from './snapshot.ts';

/**
 * 快照**导出**侧的纯逻辑（从 `materialize.ts` 抽出来，只为守住"每文件 400 行"这条门禁）。
 *
 * 这里只做两件事：从物化状态里挑出该进快照的消息、以及判断"某条消息在某个墙钟之后动过没有"。
 * 不含任何存储/网络行为 —— 发布方（sync-core）负责把结果编码、上传与清理。
 */

/**
 * 这条消息在 wall 之后动过吗（追加、改稿、选候选、改状态、删除都算）。
 *
 * 增量导出用它挑"基准之后动过"的消息 —— 任何一次改动都会推进 HLC，所以按 HLC 墙钟筛是安全的。
 */
export function touchedAfter(message: MessageRecord, wall: number): boolean {
  if (message.appendHlc.t > wall) return true;
  if (message.activeRevision.hlc.t > wall) return true;
  if ((message.statusHlc?.t ?? 0) > wall) return true;
  if ((message.deleted?.hlc.t ?? 0) > wall) return true;
  if ((message.selectedCandidate?.hlc.t ?? 0) > wall) return true;
  if (message.revisions.some((revision) => revision.hlc.t > wall)) return true;
  if (message.candidates.some((candidate) => candidate.hlc.t > wall)) return true;
  return false;
}

/**
 * 某个会话当前有多少条**存活**消息。发布方用它判断"这一轮有没有删除"：
 * 变少就改发整份（增量不带删除信息，这是刻意的取舍 —— 删除很少见，整份最稳）。
 */
export function countSessionMessages(state: MaterializedState, sessionId: string): number {
  return Object.values(state.messages).filter(
    (message) => message.sessionId === sessionId && message.deleted === undefined,
  ).length;
}

/**
 * 导出某个会话的快照（换机/首次同步用）。
 *
 * 给了 `since` 就导出**增量**：只带"基准之后动过"的消息，体积与这段时间的改动成正比，
 * 而不是与会话总长成正比（这才是"字节级增量"的意义）。没给就是整份（v1）。
 *
 * 注意：增量**不保证**涵盖删除（删除靠发布方发现"消息数变少"后改发整份，见 sync-core）。
 */
export function exportSessionSnapshot(
  state: MaterializedState,
  input: {
    deviceId: string;
    blindSessionId: string;
    sessionId: string;
    watermarks: Record<string, number>;
    now?: number;
    since?: { hash: string; wall: number };
  },
): SessionSnapshot {
  const all = Object.values(state.messages).filter((message) => message.sessionId === input.sessionId);
  const since = input.since;
  const messages = since === undefined ? all : all.filter((message) => touchedAfter(message, since.wall));
  const appliedOpIds: string[] = [];
  for (const message of messages) {
    appliedOpIds.push(message.appendOpId);
    for (const revision of message.revisions) appliedOpIds.push(revision.opId);
    for (const candidate of message.candidates) appliedOpIds.push(candidate.opId);
  }

  const session = state.sessions[input.sessionId];
  return {
    v: since === undefined ? 1 : 2,
    ...(since === undefined ? {} : { base: since.hash }),
    deviceId: input.deviceId,
    blindSessionId: input.blindSessionId,
    createdAt: input.now ?? Date.now(),
    watermarks: { ...input.watermarks },
    appliedOpIds,
    ...(session === undefined ? {} : { session }),
    messages,
  };
}
