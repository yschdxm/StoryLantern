import {
  SnapshotBlobError,
  checkpointOp,
  decodeOp,
  stateDigest,
  validateStateSnapshot,
  type CheckpointPayload,
  type Hlc,
  type MaterializedState,
  type Op,
  type StateSnapshot,
} from '../../../../packages/oplog/src/index.ts';
import type { DeviceStore } from './op-ports.ts';
import type { OpLogPort } from './op-types.ts';

/**
 * 设备本地的状态快照：**只加速冷启动，不替代日志**。
 *
 * 启动时若能载入快照，就从 `lastSeq` 之后接着重放；用不了就全量重放，并把**原因**带回来
 * （"快照坏了"和"没有快照"是两件事，界面上要能分辨）。
 *
 * 为什么不放进 op：它会随同步发到每台设备，而内容完全可以从日志重建——
 * 派生数据不该占据事实源的位置（ADR-0002）。日志里留一条 `log.checkpoint` 作为凭据。
 */

export const SNAPSHOT_KEY = 'oplog.snapshot.v1';

/**
 * 启用门槛：日志小于这个规模时**不用**快照。
 *
 * 冷启动的代价模型（宿主 IPC 每次往返都是固定开销）：
 *  - 全量重放：`ceil(条数 / 1000)` 次读；
 *  - 载入快照：1 次读快照 + 1 次读锚点 + 读尾巴。
 * 所以小日志下快照反而**更慢**——真机实测 48 条时是 197 ms vs 全量 37 ms。
 * 门槛取 3000（远超一页），保证快照只在"重放确实要读很多页"时才介入；测试可注入更小的值。
 */
export const SNAPSHOT_MIN_OPS = 3_000;

export interface SnapshotLoadResult {
  /** 可用的快照（含状态）；不可用时为 undefined。 */
  snapshot?: StateSnapshot;
  /** 曾经存在快照但用不了时的原因（用于如实展示，而不是静默退回重放）。 */
  problem?: string;
}

/** 读取并校验快照。任何异常都转成"用不了 + 原因"，绝不让应用起不来。 */
export async function readSnapshot(device: DeviceStore): Promise<SnapshotLoadResult> {
  let raw: string | undefined;
  try {
    raw = await device.get(SNAPSHOT_KEY);
  } catch (cause) {
    return { problem: `读快照失败：${cause instanceof Error ? cause.message : String(cause)}` };
  }
  if (raw === undefined || raw === '') return {};

  try {
    return { snapshot: validateStateSnapshot(JSON.parse(raw)) };
  } catch (cause) {
    const reason = cause instanceof SnapshotBlobError || cause instanceof Error ? cause.message : String(cause);
    return { problem: `快照不可用（${reason}）` };
  }
}

export interface SnapshotSource {
  deviceId: string;
  /** 快照覆盖到的本机日志 seq。 */
  lastSeq: number;
  /** 该 seq 上那条 op 的 id（确认日志还是同一段）。 */
  lastOpId: string;
  opCount: number;
  upToHlc: StateSnapshot['upToHlc'];
}

export async function writeSnapshot(
  device: DeviceStore,
  state: MaterializedState,
  source: SnapshotSource,
  createdAt: number,
): Promise<StateSnapshot> {
  const snapshot: StateSnapshot = {
    v: 1,
    deviceId: source.deviceId,
    createdAt,
    upToHlc: source.upToHlc,
    lastSeq: source.lastSeq,
    lastOpId: source.lastOpId,
    opCount: source.opCount,
    digest: stateDigest(state),
    state,
  };
  await device.set(SNAPSHOT_KEY, JSON.stringify(snapshot));
  return snapshot;
}

export async function clearSnapshot(device: DeviceStore): Promise<void> {
  await device.set(SNAPSHOT_KEY, '');
}

/**
 * 启动时的准备：读取快照 + 确认它对应的那段日志还在。
 *
 * 两件事必须都成立才敢用快照：
 *  1. 快照本身没坏（摘要自校验）；
 *  2. 快照记录的锚点（`lastSeq` 上的那条 op）与当前日志一致——
 *     日志被重建、清空或重新导入后 seq 会重排，此时**必须**退回全量重放，否则会丢数据。
 */
export async function prepareSnapshot(
  device: DeviceStore | undefined,
  ops: OpLogPort,
  minOps: number = SNAPSHOT_MIN_OPS,
): Promise<SnapshotLoadResult> {
  if (device === undefined) return { problem: '没有设备本地存储，快照不可用' };
  const loaded = await readSnapshot(device);
  const snapshot = loaded.snapshot;
  if (snapshot === undefined) return loaded;
  // 门槛判断用快照自己记的条数：一次多余的往返都不花
  if (snapshot.opCount < minOps) {
    return { problem: `日志还小（快照覆盖 ${snapshot.opCount} 条 < ${minOps}），全量重放更快` };
  }

  const anchor = await ops.list(Math.max(0, snapshot.lastSeq - 1), 1);
  const row = anchor.rows.find((item) => item.seq === snapshot.lastSeq);
  if (row === undefined) return { problem: '快照的位置已经不在日志里（日志被重建过）' };
  if (row.opId !== snapshot.lastOpId) return { problem: '快照与当前日志对不上（该位置不是同一条 op）' };
  return { snapshot };
}

export interface SnapshotResult {
  upToHlc: Hlc;
  opCount: number;
  digest: string;
  lastSeq: number;
}

/**
 * 生成快照：日志里留一条检查点（可审计、也是将来截断的凭据），状态写在本机 kv。
 *
 * **不截断日志**：日志仍是唯一事实源，快照只让下次冷启动少重放一段。
 */
export async function buildSnapshot(input: {
  device: DeviceStore;
  ops: OpLogPort;
  deviceId: string;
  state: MaterializedState;
  now: () => number;
  /** 启用门槛；默认 `SNAPSHOT_MIN_OPS`。 */
  minOps?: number;
  appendCheckpoint: (payload: CheckpointPayload) => Promise<void>;
}): Promise<SnapshotResult> {
  const stats = await input.ops.stats();
  if (stats.lastSeq === 0) throw new Error('日志还是空的，暂时不需要快照');
  const minOps = input.minOps ?? SNAPSHOT_MIN_OPS;
  if (stats.count < minOps) {
    throw new Error(`日志还小（${stats.count} 条 < ${minOps}），现在还不需要快照：全量重放更快`);
  }
  const anchor = await input.ops.list(stats.lastSeq - 1, 1);
  const lastRow = anchor.rows.find((row) => row.seq === stats.lastSeq);
  if (lastRow === undefined) throw new Error('日志位置读不到，暂不生成快照');
  const upToHlc = decodeOp(lastRow.line).hlc;

  await input.appendCheckpoint({
    upToHlc,
    lastSeq: stats.lastSeq,
    lastOpId: lastRow.opId,
    opCount: stats.count,
    digest: stateDigest(input.state),
    createdAt: input.now(),
  });

  // 检查点本身也是一条 op：快照覆盖到它为止，下次启动从它之后追平
  const after = await input.ops.stats();
  const tailAnchor = await input.ops.list(after.lastSeq - 1, 1);
  const tailRow = tailAnchor.rows.find((row) => row.seq === after.lastSeq);
  const snapshot = await writeSnapshot(
    input.device,
    input.state,
    {
      deviceId: input.deviceId,
      lastSeq: after.lastSeq,
      lastOpId: tailRow?.opId ?? lastRow.opId,
      opCount: after.count,
      upToHlc,
    },
    input.now(),
  );
  return { upToHlc: snapshot.upToHlc, opCount: snapshot.opCount, digest: snapshot.digest, lastSeq: snapshot.lastSeq };
}
