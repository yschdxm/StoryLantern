import { compareHlc, type Hlc } from './hlc.ts';
import type { Op } from './op.ts';
import type { CharacterRecord, MaterializedState } from './state-types.ts';

/**
 * 物化的公共零件。
 *
 * 抽出来有两个原因：一是 `materialize.ts` 太大（门禁限制 400 行），
 * 二是这些判定（时间线、空状态）是**跨实体共用**的规则，放一处才不会各写一份。
 */

export function emptyState(): MaterializedState {
  return { characters: {}, sessions: {}, messages: {}, settings: {} };
}

export function cloneHlc(hlc: Hlc): Hlc {
  return { t: hlc.t, c: hlc.c };
}

export function laterThan(a: Hlc, b: Hlc | undefined, tieA: string, tieB: string | undefined): boolean {
  if (!b || !tieB) return true;
  const byHlc = compareHlc(a, b);
  if (byHlc !== 0) return byHlc > 0;
  return tieA > tieB;
}

/**
 * 这次 op 是否比记录里的"最近一次写入"更新。
 * 角色的 upsert 与 delete **共用同一条时间线**，因此墓碑和字段不会互相盖错。
 */
export function isNewerThanRecord(op: Op, record: CharacterRecord): boolean {
  const newest =
    record.deleted !== undefined && laterThan(record.deleted.hlc, record.updatedHlc, record.deleted.opId, record.opId)
      ? { hlc: record.deleted.hlc, opId: record.deleted.opId }
      : { hlc: record.updatedHlc, opId: record.opId };
  return laterThan(op.hlc, newest.hlc, op.opId, newest.opId);
}
