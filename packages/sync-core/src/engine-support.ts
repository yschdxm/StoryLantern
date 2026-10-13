import type { HlcClock } from '../../oplog/src/hlc.ts';
import type { Materializer } from '../../oplog/src/materialize.ts';
import type { Op } from '../../oplog/src/op.ts';
import type { CryptoPorts } from '../../oplog/src/ports.ts';
import { SegmentError, unpackSegment } from '../../oplog/src/segment.ts';
import type { SyncBackend } from './backend.ts';
import { decodeManifest, type Manifest, type SessionRef } from './manifest.ts';
import { DEVICES_PREFIX, parseManifestPath, segmentPath, snapshotPath } from './paths.ts';
import { decodeSessionSnapshot, encodeSessionSnapshot } from './snapshot-store.ts';
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
    const bytes = await ctx.backend.get(path);
    outcome.downloaded.push(path);
    const snapshot = await decodeSessionSnapshot(bytes, {
      ports: ctx.ports,
      expect: { blindSessionId: ref.blindSessionId, deviceId: owner },
    });
    const restored = materializer.restoreSessionSnapshot(snapshot);
    outcome.hydratedSessions += 1;
    outcome.hydratedMessages += restored.restoredMessages;

    // 应用水位：这些段已包含在快照里，不再下载。
    for (const [watermarkOwner, seq] of Object.entries(snapshot.watermarks)) {
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

export interface SnapshotContext {
  backend: SyncBackend;
  ports: CryptoPorts;
  deviceId: string;
  state: LocalSyncState;
  now(): number;
}

export interface UploadedSnapshot {
  path: string;
  hash: string;
  bytes: Uint8Array;
}

/** 生成并上传一个会话快照；失败只告警（下次同步会再试）。 */
export async function buildAndUploadSnapshot(
  ctx: SnapshotContext,
  materializer: Materializer,
  sessionId: string,
  blindSessionId: string,
  warnings: string[],
): Promise<UploadedSnapshot | undefined> {
  const hosted = ctx.state.hosted[blindSessionId];
  if (!hosted) return undefined;

  // 水位 = 各设备在该会话上"已并入"的最高段序号（读取方据此跳过这些段）。
  const watermarks: Record<string, number> = {};
  for (const [key, seq] of Object.entries(ctx.state.cursors)) {
    const [owner, blind] = key.split('|');
    if (blind === blindSessionId && owner !== undefined && seq > 0) {
      watermarks[owner] = Math.max(watermarks[owner] ?? 0, seq);
    }
  }
  watermarks[ctx.deviceId] = Math.max(watermarks[ctx.deviceId] ?? 0, hosted.lastSeq);

  const snapshot = materializer.exportSessionSnapshot({
    deviceId: ctx.deviceId,
    blindSessionId,
    sessionId,
    watermarks,
    now: ctx.now(),
  });

  const encoded = await encodeSessionSnapshot(snapshot, {
    ports: ctx.ports,
    encrypt: ctx.ports.cipher !== undefined,
  });
  const result = await ctx.backend.put(encoded.path, encoded.bytes, { ifNoneMatch: true });
  if (!result.ok && result.exists !== true) {
    warnings.push(`快照上传失败：${encoded.path}`);
    return undefined;
  }

  hosted.snapshot = { hash: encoded.hash, epoch: hosted.epoch, watermarks, bytes: encoded.bytes.length };
  hosted.segmentsSinceSnapshot = 0;
  return { path: encoded.path, hash: encoded.hash, bytes: encoded.bytes };
}

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
