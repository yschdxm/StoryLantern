import type { MessageRecord, SessionRecord } from './state-types.ts';

/**
 * 会话快照：把某个会话当前的物化状态打包成一个内容寻址文件。
 *
 * 它**只是优化**，不是事实源：
 *  - 快照丢了、坏了、版本不兼容，都可以由 segments 重新重放出来；
 *  - 存在的意义是"换机/首次同步"不必下载几个月的历史段；
 *  - 因此它必须自带签名（否则哑存储可以塞一个伪造快照污染读取方的物化状态）。
 *
 * 水位语义：`watermarks[owner] = N` 表示"owner 设备的第 1..N 号段已被本快照覆盖"，
 * 读取方据此直接跳过这些段，只拉尾巴。
 */
export interface SessionSnapshot {
  v: 1;
  /** 生成这份快照的设备（签名归属）。 */
  deviceId: string;
  /** 该会话的盲化 id（与路径一致）。 */
  blindSessionId: string;
  createdAt: number;
  watermarks: Record<string, number>;
  /**
   * 已被快照覆盖的 opId。
   * 注意：只包含 append/edit/candidate 这类**op 本身**的 id；
   * `revision.select` / `candidate.select` 的结果体现在消息记录里，不单独记 id
   * （重复投递这些 op 是幂等的，不会改变状态）。
   */
  appliedOpIds: string[];
  session?: SessionRecord;
  messages: MessageRecord[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 严格校验：结构不对就整体拒绝，绝不接受"看起来能用"的快照。 */
export function validateSessionSnapshot(value: unknown): SessionSnapshot {
  if (!isRecord(value)) throw new SnapshotError('快照必须是对象');
  if (value.v !== 1) throw new SnapshotError(`不支持的快照版本：${String(value.v)}`);
  if (typeof value.deviceId !== 'string' || value.deviceId === '') throw new SnapshotError('快照缺少 deviceId');
  if (typeof value.blindSessionId !== 'string' || value.blindSessionId === '') {
    throw new SnapshotError('快照缺少 blindSessionId');
  }
  if (typeof value.createdAt !== 'number') throw new SnapshotError('快照缺少 createdAt');
  if (!isRecord(value.watermarks)) throw new SnapshotError('快照缺少 watermarks');
  for (const [owner, seq] of Object.entries(value.watermarks)) {
    if (typeof seq !== 'number' || !Number.isFinite(seq)) throw new SnapshotError(`水位 ${owner} 不是数字`);
  }
  if (!Array.isArray(value.appliedOpIds)) throw new SnapshotError('快照缺少 appliedOpIds');
  if (!Array.isArray(value.messages)) throw new SnapshotError('快照缺少 messages');
  return value as unknown as SessionSnapshot;
}
