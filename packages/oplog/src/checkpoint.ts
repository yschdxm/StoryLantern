import { crc32Hex } from './crc32.ts';
import type { Hlc, HlcClock } from './hlc.ts';
import { createOp, type Op, type StampOptions } from './op.ts';
import { normalizeState } from './materialize-support.ts';
import type { MaterializedState } from './state-types.ts';

/**
 * 冷启动检查点：让"载入快照 + 追平尾巴"取代"从头重放整个日志"。
 *
 * 三条边界（决定了这里为什么长这样）：
 *
 * 1. **日志仍然是唯一事实源。** 快照是**派生数据**（ADR-0002：物化状态可重建），
 *    所以它不进 op 的 payload、不参与同步；日志里只留一条 `log.checkpoint`（很小），
 *    记录"到哪个位置、覆盖多少 op、摘要是什么"——用于审计，也是将来 GC 截断的凭据。
 *    把整份状态塞进 op 会让每个设备都同步一份巨大的重复数据，且一旦生成逻辑有 bug
 *    就会污染所有人的日志。
 *
 * 2. **摘要防的是损坏，不是恶意。** 快照存在设备自己的 kv 里；摘要用 CRC32（零依赖、够快），
 *    用于发现"存坏了/截断了/被写花了"。它不提供密码学保证——持有本机存储的攻击者
 *    本来就已经拿到了这些数据。跨设备的完整性由同步段的加密与内容哈希负责。
 *
 * 3. **恢复顺序不能省。** 快照只覆盖到 `lastSeq`，之后写入的 op 必须继续重放；
 *    另外 `lastOpId` 用来确认"这份快照对应的那段日志还是同一段"
 *    （日志被清空/重建/重新导入后 seq 会重排，此时必须退回全量重放）。
 */

/** 日志里的检查点（很小、可同步、可审计）。 */
export interface CheckpointPayload {
  /** 覆盖到的最后一个 op 的 HLC。 */
  upToHlc: Hlc;
  /** 覆盖到该设备日志的哪一条（本机 seq）。 */
  lastSeq: number;
  /** 该位置那条 op 的 id：用来确认日志还是同一段。 */
  lastOpId: string;
  /** 覆盖的 op 条数。 */
  opCount: number;
  /** 物化状态的摘要（见 `stateDigest`）。 */
  digest: string;
  createdAt: number;
}

export interface CheckpointRecord extends CheckpointPayload {
  opId: string;
  deviceId: string;
}

export function checkpointOp(
  base: { deviceId: string; clock: HlcClock },
  payload: CheckpointPayload,
  stamp: StampOptions = {},
): Op<CheckpointPayload> {
  return createOp({
    ...base,
    ...stamp,
    type: 'log.checkpoint',
    entity: { type: 'log', id: `checkpoint:${payload.lastSeq}` },
    payload,
  });
}

/** 设备本地保存的快照体（不进日志、不参与同步）。 */
export interface StateSnapshot {
  v: 1;
  deviceId: string;
  createdAt: number;
  upToHlc: Hlc;
  lastSeq: number;
  lastOpId: string;
  opCount: number;
  digest: string;
  state: MaterializedState;
}

export class SnapshotBlobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotBlobError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 规范序列化：对象键递归排序，数组保持原序。
 *
 * 摘要只有在序列化**确定**时才有意义（同一个状态在任何设备、任何时刻都必须得到同一个摘要）。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/** 物化状态的摘要：CRC32 + 长度（长度顺手挡住"尾部被截断但前缀一致"这类损坏）。 */
export function stateDigest(state: MaterializedState): string {
  const json = canonicalJson(state);
  const bytes = new TextEncoder().encode(json);
  return `${crc32Hex(bytes)}-${bytes.length}`;
}

/** 严格校验：结构不对就整体拒绝，绝不接受"看起来能用"的快照。 */
export function validateStateSnapshot(value: unknown): StateSnapshot {
  if (!isRecord(value)) throw new SnapshotBlobError('快照必须是对象');
  if (value['v'] !== 1) throw new SnapshotBlobError(`不支持的快照版本：${String(value['v'])}`);
  if (typeof value['deviceId'] !== 'string' || value['deviceId'] === '') throw new SnapshotBlobError('快照缺少 deviceId');
  if (typeof value['digest'] !== 'string' || value['digest'] === '') throw new SnapshotBlobError('快照缺少 digest');
  if (typeof value['lastSeq'] !== 'number' || !Number.isFinite(value['lastSeq'])) throw new SnapshotBlobError('快照缺少 lastSeq');
  if (typeof value['lastOpId'] !== 'string' || value['lastOpId'] === '') throw new SnapshotBlobError('快照缺少 lastOpId');
  if (typeof value['opCount'] !== 'number' || !Number.isFinite(value['opCount'])) throw new SnapshotBlobError('快照缺少 opCount');
  const hlc = value['upToHlc'];
  if (!isRecord(hlc) || typeof hlc['t'] !== 'number' || typeof hlc['c'] !== 'number') {
    throw new SnapshotBlobError('快照缺少 upToHlc');
  }
  const state = value['state'];
  if (
    !isRecord(state) ||
    !isRecord(state['characters']) ||
    !isRecord(state['sessions']) ||
    !isRecord(state['messages']) ||
    !isRecord(state['lorebooks']) ||
    !isRecord(state['memories']) ||
    !isRecord(state['settings'])
  ) {
    throw new SnapshotBlobError('快照里的状态结构不完整');
  }
  const snapshot = value as unknown as StateSnapshot;
  // 自校验：状态被改花/截断时，摘要对不上
  if (stateDigest(snapshot.state) !== snapshot.digest) throw new SnapshotBlobError('快照摘要不匹配（内容已损坏）');
  // 摘要校验必须针对**原始**状态（它就是这样存下来的）；之后再把缺的表补空，
  // 这样"升级前生成、缺卡片模型那几张表"的旧快照仍然可用（normalizeState 只补空，不改已有内容）。
  return { ...snapshot, state: normalizeState(snapshot.state) };
}
