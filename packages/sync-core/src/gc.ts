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
  /**
   * 只分析、不动手（默认 true）。
   *
   * 为什么默认是"只看不做"：回收是**不可恢复**的动作，而判定依赖"所有活跃设备都已并入"
   * 这个前提。让界面先把"会删哪些、为什么"摊开、由用户确认，再显式传 `dryRun: false`，
   * 比默认就删安全得多。
   */
  dryRun?: boolean;
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
  const dryRun = input.dryRun !== false;
  const activeIds = input.roster.activeIds();
  const activeSet = new Set(activeIds);
  const sources = [
    { deviceId: input.deviceId, ack: input.ack },
    ...Object.entries(input.peerAck).map(([id, ack]) => ({ deviceId: id, ack })),
  ];

  const candidates: string[] = [];
  const moved: string[] = [];
  const reasons: string[] = [];

  const owners: Array<[string, Record<string, HostedSession>, boolean]> = [
    [input.deviceId, input.hosted, true],
    ...Object.entries(input.peerHosted).map(
      ([id, sessions]): [string, Record<string, HostedSession>, boolean] => [id, sessions, false],
    ),
  ];

  for (const [owner, sessions, isOwn] of owners) {
    const safeThrough = safeThroughSeq(sources, activeIds, owner);
    for (const [blind, hosted] of Object.entries(sessions)) {
      for (const [seqText, hash8] of Object.entries(hosted.segments)) {
        const seq = Number.parseInt(seqText, 10);
        const path = segmentPath(owner, blind, `${String(seq).padStart(8, '0')}-${hash8}.jsonl.gz`);

        // 只有**自己发布的段**有可信的发布时间（存在本地状态里）。
        // 对端段的"最后出现时间"没有记录，宁可不回收，也不猜。
        const lastSeenAt = isOwn ? hosted.publishedAt?.[seqText] : undefined;
        if (lastSeenAt === undefined) {
          reasons.push(`${path}：${isOwn ? '本地没有它的发布时间记录' : '对端段的发布时间不在本地记录里'}，保守跳过`);
          continue;
        }

        const decision = decideCollection({
          owner,
          seq,
          ownerActive: activeSet.has(owner),
          safeThrough,
          now: input.now(),
          lastSeenAt,
          graceMs: input.graceMs,
        });

        if (!decision.collect) {
          reasons.push(`${path}：${decision.reason}`);
          continue;
        }

        candidates.push(path);
        if (dryRun) {
          reasons.push(`${path}：${decision.reason}（仅分析）`);
        } else if (input.backend.delete) {
          // 两步式的第一步：**先把段搬进 trash**（读原段 → 写 trash 副本），再删掉原路径。
          // 真机踩到：以前这里只 delete(trashPath(...)) —— 删一个从来没被创建过的路径，
          // 然后照样把 moved 记为成功（假报告）；于是"确认回收"点完，共享目录里什么都没少。
          const trashed = trashPath(new Date(input.now()), path);
          await input.backend.put(trashed, await input.backend.get(path));
          await input.backend.delete(path);
          moved.push(path);
        } else {
          reasons.push(`${path}：${decision.reason}（后端不支持 delete，未移动）`);
        }
      }
    }
  }

  return { candidates, moved, reasons };
}
