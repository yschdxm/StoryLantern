import type { HlcClock } from '../../oplog/src/hlc.ts';
import type { Materializer } from '../../oplog/src/materialize.ts';
import type { Op } from '../../oplog/src/op.ts';
import type { CryptoPorts } from '../../oplog/src/ports.ts';
import { SegmentError, unpackSegment } from '../../oplog/src/segment.ts';
import type { SyncBackend } from './backend.ts';
import { decodeManifest, type Manifest, type SessionRef } from './manifest.ts';
import { DEVICES_PREFIX, parseManifestPath, segmentPath, snapshotPath } from './paths.ts';
import { decodeSessionSnapshot, encodeSessionSnapshot } from './snapshot-store.ts';
import { mergeSnapshotChain, type SessionSnapshot } from '../../oplog/src/index.ts';
import type { LocalSyncState } from './state.ts';

/**
 * 引擎的"重活"部分：拉取与快照。
 *
 * 拆出来的原因有两个：单文件行数门禁；以及这两块逻辑只依赖显式传入的上下文，
 * 不需要碰引擎的私有字段，测试与将来的 relay 也能直接复用。
 */

// ---------------------------------------------------------------- 拉取

export interface PullContext {
  backend: SyncBackend;
  ports: CryptoPorts;
  clock: HlcClock;
  deviceId: string;
  activeDevices: Set<string>;
  state: LocalSyncState;
  /**
   * 拉到远端 op 后的回调。**给"日志是唯一事实源"的客户端用**：
   * 它需要把这些 op 追加进自己的日志（否则重启后按日志重建会丢掉这批数据）。
   */
  onOps?: (ops: readonly Op[]) => void | Promise<void>;
  /** 懒加载：返回 false 的会话本轮不拉（例如用户没打开过的会话）。 */
  shouldPull?: (blindSessionId: string) => boolean;
}

export interface PullOutcome {
  appliedOps: number;
  orphans: number;
  hydratedSessions: number;
  hydratedMessages: number;
  downloaded: string[];
  warnings: string[];
  /**
   * 最近一次用快照补课时，链上一共取了几份（≥2 说明走的是**增量**：基准 + 若干段）。
   * 记下来是为了让"增量到底有没有生效"可观测，而不是只能靠体积猜。
   */
  snapshotChainLength?: number;
}

/** 只列 `devices/`，按 manifest 精确 GET 缺失段；从不遍历 `logs/` 目录树。 */
export async function pullChanges(ctx: PullContext, materializer: Materializer): Promise<PullOutcome> {
  const outcome: PullOutcome = {
    appliedOps: 0,
    orphans: 0,
    hydratedSessions: 0,
    hydratedMessages: 0,
    downloaded: [],
    warnings: [],
  };

  const listing = await ctx.backend.list(DEVICES_PREFIX);
  const versionsByDevice = new Map<string, { seq: number; path: string }[]>();

  for (const entry of listing.entries) {
    const parsed = parseManifestPath(entry.path);
    if (!parsed) continue;
    if (parsed.deviceId === ctx.deviceId) continue;
    if (!ctx.activeDevices.has(parsed.deviceId)) {
      outcome.warnings.push(`忽略名单外设备 ${parsed.deviceId} 的 manifest`);
      continue;
    }
    const list = versionsByDevice.get(parsed.deviceId) ?? [];
    list.push({ seq: parsed.seq, path: entry.path });
    versionsByDevice.set(parsed.deviceId, list);
  }

  for (const [owner, versions] of versionsByDevice) {
    versions.sort((a, b) => a.seq - b.seq);
    const latest = versions[versions.length - 1];
    if (!latest) continue;

    const seen = ctx.state.manifestCursors[owner] ?? 0;
    if (latest.seq < seen) {
      outcome.warnings.push(
        `设备 ${owner} 的 manifest 序号回退（本地见过 ${seen}，远端最新 ${latest.seq}）——疑似被回滚/还原，本次忽略`,
      );
      continue;
    }

    let manifest: Manifest;
    try {
      const bytes = await ctx.backend.get(latest.path);
      manifest = await decodeManifest(bytes, { ports: ctx.ports, expectDeviceId: owner });
    } catch (error) {
      outcome.warnings.push(`manifest 不可用（${owner}）：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    ctx.state.manifestCursors[owner] = manifest.seq;
    ctx.state.peerAck[owner] = manifest.ack;
    // 对端公布的签名公钥：以后验签要靠它（强模式拿不到公钥就只能拒绝）
    if (manifest.publicKey !== undefined && manifest.publicKey !== '') {
      ctx.state.peerPublicKeys[owner] = manifest.publicKey;
    }
    if (manifest.agreementKey !== undefined && manifest.agreementKey !== '') {
      ctx.state.peerAgreementKeys[owner] = manifest.agreementKey;
    }
    ctx.state.peerHosted[owner] = Object.fromEntries(
      Object.entries(manifest.sessions).map(([blind, ref]) => [
        blind,
        {
          lastSeq: ref.lastSeq,
          segments: ref.segments,
          bytes: ref.bytes,
          epoch: ref.epoch,
          segmentsSinceSnapshot: 0,
          ...(ref.snapshot === undefined ? {} : { snapshot: ref.snapshot }),
        },
      ]),
    );

    for (const ref of Object.values(manifest.sessions)) {
      if (ctx.shouldPull && !ctx.shouldPull(ref.blindSessionId)) continue;
      await pullSession(ctx, materializer, outcome, owner, ref);
    }
  }

  return outcome;
}

async function pullSession(
  ctx: PullContext,
  materializer: Materializer,
  outcome: PullOutcome,
  owner: string,
  ref: SessionRef,
): Promise<void> {
  const key = `${owner}|${ref.blindSessionId}`;

  // 首次同步（本地还没有这个会话的任何进度）时优先用快照"补课"：
  // 一份快照通常顶掉几十个历史段，这是换机成本的主要来源。
  if ((ctx.state.cursors[key] ?? 0) === 0 && ref.snapshot !== undefined) {
    await hydrateFromSnapshot(ctx, materializer, outcome, owner, ref);
  }

  const from = ctx.state.cursors[key] ?? 0;
  const appliedSeqs = new Set(ctx.state.appliedSeqs[key] ?? []);

  for (let seq = from + 1; seq <= ref.lastSeq; seq += 1) {
    // 已成功过的段（只是因为前面有缺口而没推进水位）直接跳过，避免重复下载。
    if (appliedSeqs.has(seq)) continue;

    const hash8 = ref.segments[String(seq)];
    if (!hash8) {
      outcome.warnings.push(`设备 ${owner} 的会话 ${ref.blindSessionId} 缺少第 ${seq} 号段（可能已被 GC 或尚未上传）`);
      continue;
    }
    const fileName = `${String(seq).padStart(8, '0')}-${hash8}.jsonl.gz`;
    const path = segmentPath(owner, ref.blindSessionId, fileName);

    let ops: Op[];
    try {
      const bytes = await ctx.backend.get(path);
      outcome.downloaded.push(path);
      const unpacked = await unpackSegment(bytes, {
        ports: ctx.ports,
        fileName,
        expect: { deviceId: owner, seq, blindSessionId: ref.blindSessionId },
      });
      ops = unpacked.ops;
    } catch (error) {
      const code = error instanceof SegmentError ? error.code : 'unknown';
      outcome.warnings.push(`段被拒绝（${code}）：${path}${error instanceof Error ? ` —— ${error.message}` : ''}`);
      // 失败的段绝不推进水位：它会作为"缺口"在下一次同步被重试，而不是被当成已消费而永久丢失。
      continue;
    }

    for (const op of ops) ctx.clock.merge(op.hlc, owner);
    // 先把 op 交给调用方落进它自己的日志，再应用到内存状态。
    // 顺序反了的话，中间崩溃会留下"状态有、日志没有"的裂缝（重启重建就丢数据）。
    if (ctx.onOps !== undefined) await ctx.onOps(ops);
    const applied = materializer.applyAll(ops);
    outcome.appliedOps += applied.applied;
    outcome.orphans += applied.orphans;
    appliedSeqs.add(seq);
    ctx.state.ack[owner] = Math.max(ctx.state.ack[owner] ?? 0, seq);
  }

  // 水位只推进到第一个缺口之前，因此缺口一定会被重试。
  let cursor = from;
  while (appliedSeqs.has(cursor + 1)) cursor += 1;
  if (cursor > 0) ctx.state.cursors[key] = cursor;
  if (appliedSeqs.size > 0) ctx.state.appliedSeqs[key] = [...appliedSeqs].sort((a, b) => a - b);
}

/** 用对方的会话快照补课；失败只告警（快照是优化，不是事实源）。 */
export async function hydrateFromSnapshot(
  ctx: PullContext,
  materializer: Materializer,
  outcome: PullOutcome,
  owner: string,
  ref: SessionRef,
): Promise<void> {
  const snapshotRef = ref.snapshot;
  if (!snapshotRef) return;

  const path = snapshotPath(ref.blindSessionId, snapshotRef.hash);
  try {
    // 增量快照要先把它依赖的基准取回来：**基准在前、增量按序在后**，最后合并成一份整份状态。
    // 任何一环取不到（被 GC 掉了、基线设备没发上来）、或链深得离谱，都在这里抛错 ——
    // 于是走下面的兜底：**不应用水位**、告警"退回逐段重放"，由段自己把状态补齐（快照只是优化）。
    const chain: SessionSnapshot[] = [];
    let currentPath = path;
    let hops = 0;
    for (;;) {
      const bytes = await ctx.backend.get(currentPath);
      outcome.downloaded.push(currentPath);
      const decoded = await decodeSessionSnapshot(bytes, {
        ports: ctx.ports,
        expect: { blindSessionId: ref.blindSessionId, deviceId: owner },
      });
      chain.unshift(decoded);
      if (decoded.v !== 2) break;
      if (decoded.base === undefined) throw new Error('增量快照缺少 base');
      hops += 1;
      if (hops > MAX_CHAIN_HOPS) throw new Error(`增量链过长（超过 ${MAX_CHAIN_HOPS} 段），改走逐段重放`);
      currentPath = snapshotPath(ref.blindSessionId, decoded.base);
    }
    const merged = mergeSnapshotChain(chain);
    const restored = materializer.restoreSessionSnapshot(merged);
    outcome.hydratedSessions += 1;
    outcome.hydratedMessages += restored.restoredMessages;
    if (chain.length > 1) outcome.snapshotChainLength = chain.length;

    // 应用水位：这些段已包含在快照里，不再下载。
    for (const [watermarkOwner, seq] of Object.entries(merged.watermarks)) {
      const watermarkKey = `${watermarkOwner}|${ref.blindSessionId}`;
      if (seq > (ctx.state.cursors[watermarkKey] ?? 0)) ctx.state.cursors[watermarkKey] = seq;
      ctx.state.ack[watermarkOwner] = Math.max(ctx.state.ack[watermarkOwner] ?? 0, seq);
    }
  } catch (error) {
    outcome.warnings.push(
      `快照不可用（退回逐段重放）：${path} —— ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ---------------------------------------------------------------- 快照发布

/**
 * 快照的发布与 GC 搬到了 `snapshot-publish.ts`（只为守住"每文件 400 行"这条门禁）；
 * 这里保持对外导出不变，调用方（engine.ts）不用改。
 */
export {
  buildAndUploadSnapshot,
  garbageCollectSnapshots,
  type SnapshotContext,
  type UploadedSnapshot,
} from './snapshot-publish.ts';

/**
 * 读取方最多沿基准链走多深。
 *
 * 为什么还要一个（比写入方那个更大的）上限：链是**对方**写上去的，读取方不能假设它一定合理 ——
 * 遇到环或超长链要能停下来退回逐段重放，而不是把首次同步卡死。
 */
const MAX_CHAIN_HOPS = 64;

// ---------------------------------------------------------------- 发布校验与清理

/** 发布后回读校验：半上传/被吃字节的写入不能算"已发布"。 */
export async function verifyPublishedSegment(
  ctx: { backend: SyncBackend; ports: CryptoPorts; deviceId: string },
  path: string,
  fileName: string,
  seq: number,
  blindSessionId: string,
): Promise<{ ok: boolean; reason: string }> {
  try {
    const bytes = await ctx.backend.get(path);
    await unpackSegment(bytes, {
      ports: ctx.ports,
      fileName,
      expect: { deviceId: ctx.deviceId, seq, blindSessionId },
    });
    return { ok: true, reason: '' };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** 只清理自己命名空间里的旧 manifest：仅影响发现入口，事实源在 segments 里。 */
export async function pruneOwnManifests(
  ctx: { backend: SyncBackend; state: LocalSyncState; keep: number },
  justPublished: string,
): Promise<void> {
  const previous = ctx.state.manifestPaths.filter((path) => path !== justPublished);
  ctx.state.manifestPaths = [justPublished, ...previous].slice(0, ctx.keep);
  const stale = previous.slice(ctx.keep - 1);
  if (stale.length === 0 || !ctx.backend.delete) return;
  for (const path of stale) {
    try {
      await ctx.backend.delete(path);
    } catch {
      // 清理失败不影响同步正确性：下次同步会再试。
    }
  }
}
