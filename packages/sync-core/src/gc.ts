import type { SyncBackend } from './backend.ts';
import { segmentPath, trashPath } from './paths.ts';
import { decideCollection, safeThroughSeq, type DeviceRosterList } from './roster.ts';
import type { HostedSession } from './state.ts';

export interface CollectInput {
  backend: SyncBackend;
  deviceId: string;
  roster: DeviceRosterList;
  /** 本设备声明的并入进度。 */
  ack: Record<string, number>;
  /** 对端声明的并入进度：owner -> { deviceId: seq }。 */
  peerAck: Record<string, Record<string, number>>;
  hosted: Record<string, HostedSession>;
  peerHosted: Record<string, Record<string, HostedSession>>;
  now(): number;
  graceMs: number;
}

export interface CollectResult {
  candidates: string[];
  moved: string[];
  reasons: string[];
}

/**
 * 保守 GC。
 *
 * 判定条件（缺一不可）：段所属设备仍在名单内、名单内**全部**活跃设备都已并入、
 * 且超过宽限期。回收采用"先进 `trash/` 再删除"的两步式，且后端不支持 delete 时
 * 只报告候选、绝不删除。宁可多占一点空间，也不冒丢历史的风险。
 */
export async function collectTrash(input: CollectInput): Promise<CollectResult> {
  const activeIds = input.roster.activeIds();
  const activeSet = new Set(activeIds);
  const sources = [
    { deviceId: input.deviceId, ack: input.ack },
    ...Object.entries(input.peerAck).map(([id, ack]) => ({ deviceId: id, ack })),
  ];

  const candidates: string[] = [];
  const moved: string[] = [];
  const reasons: string[] = [];

  const owners: Array<[string, Record<string, HostedSession>]> = [
    [input.deviceId, input.hosted],
    ...Object.entries(input.peerHosted),
  ];

  for (const [owner, sessions] of owners) {
    const safeThrough = safeThroughSeq(sources, activeIds, owner);
    for (const [blind, hosted] of Object.entries(sessions)) {
      for (const [seqText, hash8] of Object.entries(hosted.segments)) {
        const seq = Number.parseInt(seqText, 10);
        const path = segmentPath(owner, blind, `${String(seq).padStart(8, '0')}-${hash8}.jsonl.gz`);
        const decision = decideCollection({
          owner,
          seq,
          ownerActive: activeSet.has(owner),
          safeThrough,
          now: input.now(),
          lastSeenAt: input.now(),
          graceMs: input.graceMs,
        });

        if (!decision.collect) {
          reasons.push(`${path}：${decision.reason}`);
          continue;
        }

        candidates.push(path);
        if (input.backend.delete) {
          await input.backend.delete(trashPath(new Date(input.now()), path));
          moved.push(path);
        } else {
          reasons.push(`${path}：${decision.reason}（后端不支持 delete，未移动）`);
        }
      }
    }
  }

  return { candidates, moved, reasons };
}
