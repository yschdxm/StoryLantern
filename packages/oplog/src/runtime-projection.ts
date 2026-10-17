/**
 * 运行时补丁的物化：只负责"把 op 追加进序列"，不计算当前值。
 *
 * 计算在 `runtime-derive.ts` 里做，原因是收敛性：重放顺序必须是 HLC 全序，
 * 而 op 到达顺序不可控。这里插入时就排好序，读取方拿到的永远是同一条链。
 */

import { compareOpOrder } from './hlc.ts';
import type { RuntimePatchPayload } from '../../cards/src/index.ts';
import type { Op } from './op.ts';
import type { MaterializedState, RuntimePatchRecord } from './state-types.ts';

export function applyRuntimePatch(state: MaterializedState, op: Op): void {
  const payload = op.payload as RuntimePatchPayload;
  if (typeof payload.session_id !== 'string' || payload.session_id === '') return;
  const list = state.runtimePatches[payload.session_id] ?? [];
  if (list.some((record) => record.opId === op.opId)) return;
  list.push({
    sessionId: payload.session_id,
    opId: op.opId,
    deviceId: op.deviceId,
    hlc: { t: op.hlc.t, c: op.hlc.c },
    source: payload.source,
    deltas: payload.deltas,
    ...(payload.caused_by_message_id === undefined ? {} : { causedByMessageId: payload.caused_by_message_id }),
  });
  list.sort((a, b) => compareOpOrder({ hlc: a.hlc, opId: a.opId }, { hlc: b.hlc, opId: b.opId }));
  state.runtimePatches[payload.session_id] = list;
}

/** 某个会话的补丁条数（开发者面板/诊断用）。 */
export function runtimePatchCount(state: MaterializedState, sessionId: string): number {
  return state.runtimePatches[sessionId]?.length ?? 0;
}

export type { RuntimePatchRecord };
