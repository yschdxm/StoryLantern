import type { MessageRecord, SessionRecord } from './state-types.ts';

/**
 * 会话快照：把某个会话当前的物化状态打包成一个内容寻址文件。
 *
 * 它**只是优化**，不是事实源：
 *  - 快照丢了、坏了、版本不兼容，都可以由 segments 重新重放出来；
 *  - 存在的意义是"换机/首次同步"不必下载几个月的历史段；
 *  - 完整性由 AES-GCM（加密时）与内容哈希保证，不提供签名（已删除）。
 *
 * 水位语义：`watermarks[owner] = N` 表示"owner 设备的第 1..N 号段已被本快照覆盖"，
 * 读取方据此直接跳过这些段，只拉尾巴。
 */
export interface SessionSnapshot {
  /**
   * v1 = 整份状态；v2 = 相对 `base` 的**增量**。
   *
   * 为什么用版本号而不是"加个可选字段"：旧读取方（v1）必须**明确拒绝**增量，不能把它当成整份 ——
   * 否则它会把"只有新增几条"当成"整个会话只有这几条"，那是最坏的一类静默数据错。
   * `validateSessionSnapshot` 对非 1/2 一律抛错，所以版本不同即安全。
   */
  v: 1 | 2;
  /** 生成这份快照的设备。 */
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
   * v2 时只含**相对基准新增**的那部分。
   */
  appliedOpIds: string[];
  /** v2：本份增量所基于的快照 hash（读取方据此先把基准取回来）。 */
  base?: string;
  /** v2：相对基准**被删除**的消息 id（删除很少见；发布方一旦发现删除就改发整份，见 engine-support）。 */
  removedMessageIds?: string[];
  session?: SessionRecord;
  /** v2 时只含**新增/变更**的消息。 */
  messages: MessageRecord[];
}

/** 这份快照是不是增量（相对某个基准）。 */
export function isDeltaSnapshot(snapshot: Pick<SessionSnapshot, 'v'>): boolean {
  return snapshot.v === 2;
}

/**
 * 把一条基准链（**基准在前、增量按序在后**）合并成一份等价于"整份"的快照。
 *
 * 纯函数，不碰网络与存储 —— 读取方负责按 hash 把链取全，这里只负责合。
 * 合并规则：消息按 id 覆盖（后出现的赢）、先删后加、opId 取并集、水位按 owner 取**最大值**
 * （水位是"已并入到第几段"，各份之间只能单调前进，绝不能被较旧的值覆盖回去）。
 */
export function mergeSnapshotChain(chain: readonly SessionSnapshot[]): SessionSnapshot {
  const base = chain[0];
  if (base === undefined) throw new SnapshotError('快照链为空');
  if (base.v !== 1) throw new SnapshotError('快照链的第一份必须是整份（v1），否则没有可叠加的基准');
  for (const part of chain.slice(1)) {
    if (part.v !== 2) throw new SnapshotError('快照链中间的增量版本不对（只接受 v2）');
    if (part.blindSessionId !== base.blindSessionId) throw new SnapshotError('快照链里混入了别的会话');
  }

  const messages = new Map<string, MessageRecord>(base.messages.map((message) => [message.id, message]));
  const applied = new Set<string>(base.appliedOpIds);
  const watermarks: Record<string, number> = { ...base.watermarks };
  let session = base.session;

  for (const part of chain.slice(1)) {
    for (const id of part.removedMessageIds ?? []) messages.delete(id);
    for (const message of part.messages) messages.set(message.id, message);
    for (const opId of part.appliedOpIds) applied.add(opId);
    for (const [owner, seq] of Object.entries(part.watermarks)) {
      watermarks[owner] = Math.max(watermarks[owner] ?? 0, seq);
    }
    if (part.session !== undefined) session = part.session;
  }

  const last = chain[chain.length - 1] ?? base;
  return {
    v: 1,
    deviceId: last.deviceId,
    blindSessionId: base.blindSessionId,
    createdAt: last.createdAt,
    watermarks,
    appliedOpIds: [...applied],
    ...(session === undefined ? {} : { session }),
    messages: [...messages.values()],
  };
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
  if (value.v !== 1 && value.v !== 2) throw new SnapshotError(`不支持的快照版本：${String(value.v)}`);
  if (value.v === 2 && (typeof value.base !== 'string' || value.base === '')) {
    throw new SnapshotError('增量快照缺少 base（没有基准就没法还原）');
  }
  if (value.v === 1 && value.base !== undefined) throw new SnapshotError('整份快照不该带 base');
  if (value.removedMessageIds !== undefined && !Array.isArray(value.removedMessageIds)) {
    throw new SnapshotError('removedMessageIds 必须是数组');
  }
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
