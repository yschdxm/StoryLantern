import type { Op } from '../../oplog/src/op.ts';

export interface HostedSession {
  lastSeq: number;
  segments: Record<string, string>;
  bytes: number;
  epoch: number;
  /** 自上次快照以来发布的段数：达到阈值就写一份新快照，换取更便宜的首次同步。 */
  segmentsSinceSnapshot: number;
  /**
   * 每一号段的发布时间（seq -> 毫秒）。
   *
   * 为什么必须记：GC 的宽限期要判"这段存在多久了"。之前判定里把"最后出现时间"当成 `now`，
   * 于是宽限期永远满足不了——回收逻辑等于死的。
   */
  publishedAt?: Record<string, number>;
  /** 最近一次发布的会话快照。 */
  snapshot?: {
    hash: string;
    epoch: number;
    watermarks: Record<string, number>;
    bytes: number;
  };
}

/** 引擎的持久化状态：整块可序列化，因此"同步进度"本身也能被备份/迁移。 */
export interface LocalSyncState {
  v: 1;
  /**
   * 历史字段：段号已经改成**每会话**从 1 编号（见 `HostedSession.lastSeq`），
   * 这个设备级计数器不再使用，保留只是让旧状态能被安全读入。
   */
  seq: number;
  manifestSeq: number;
  outbox: Op[];
  /** `${deviceId}|${blindSessionId}` -> 已**连续**消费到的段序号。 */
  cursors: Record<string, number>;
  /** 已成功应用过的段序号（可能有缺口，用于避免重复下载同时保证缺口会被重试）。 */
  appliedSeqs: Record<string, number[]>;
  /** 本设备为每个会话发布的段清单。 */
  hosted: Record<string, HostedSession>;
  /** 对端 manifest 里的段清单：owner -> blindSessionId -> 清单。 */
  peerHosted: Record<string, Record<string, HostedSession>>;
  /** 各设备最高 manifest 序号（回滚检测）。 */
  manifestCursors: Record<string, number>;
  /** 本设备已发布的 manifest 路径（新的在前；只用于清理自己的旧版本）。 */
  manifestPaths: string[];
  /** 本设备声明"已并入 deviceId 的第几号段"。 */
  ack: Record<string, number>;
  /** 对端 manifest 里的 ack：owner -> { deviceId: seq }。 */
  peerAck: Record<string, Record<string, number>>;
}

export function emptyState(): LocalSyncState {
  return {
    v: 1,
    seq: 1,
    manifestSeq: 1,
    outbox: [],
    cursors: {},
    appliedSeqs: {},
    hosted: {},
    peerHosted: {},
    manifestCursors: {},
    manifestPaths: [],
    ack: {},
    peerAck: {},
  };
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export const DEFAULT_GRACE_MS = 30 * 24 * 3600 * 1000;
