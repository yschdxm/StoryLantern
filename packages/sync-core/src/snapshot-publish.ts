import type { Materializer } from '../../oplog/src/materialize.ts';
import type { CryptoPorts } from '../../oplog/src/ports.ts';
import type { SyncBackend } from './backend.ts';
import { snapshotPath } from './paths.ts';
import { encodeSessionSnapshot } from './snapshot-store.ts';
import type { LocalSyncState } from './state.ts';

/**
 * 快照的**发布与 GC**（从 `engine-support.ts` 抽出来，只为守住"每文件 400 行"这条门禁）。
 *
 * 这里只依赖显式传入的上下文，不碰引擎私有字段 —— 因此测试与将来的 relay 都能直接复用。
 *
 * 与"整份 vs 增量"有关的三条规矩都在下面 `buildAndUploadSnapshot` 里写清楚了。
 */

export interface SnapshotContext {
  backend: SyncBackend;
  ports: CryptoPorts;
  deviceId: string;
  state: LocalSyncState;
  now(): number;
}

/**
 * 增量链最长接几段。
 *
 * 为什么要设上限：读取方要把 基准 + 每一段增量 都取下来才能还原；链太长，首次同步的往返次数
 * 与失败面都会变大，而单份增量已经很小了 —— 超过这个长度就发一份整份收口（一次取齐，最省往返）。
 */
const MAX_DELTA_CHAIN = 12;

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

  // 上一份快照的路径（内容寻址，所以从 hash 就能算出来）。
  const previous = hosted.snapshot;
  const previousSnapshotPath = previous === undefined ? undefined : snapshotPath(blindSessionId, previous.hash);

  // 水位 = 各设备在该会话上"已并入"的最高段序号（读取方据此跳过这些段）。
  const watermarks: Record<string, number> = {};
  for (const [key, seq] of Object.entries(ctx.state.cursors)) {
    const [owner, blind] = key.split('|');
    if (blind === blindSessionId && owner !== undefined && seq > 0) {
      watermarks[owner] = Math.max(watermarks[owner] ?? 0, seq);
    }
  }
  watermarks[ctx.deviceId] = Math.max(watermarks[ctx.deviceId] ?? 0, hosted.lastSeq);

  // 发整份还是增量？增量只在"基准确实可用"时才发：
  //  - 老状态没有 createdAt（不知道基准的墙钟水位）→ 整份；
  //  - 这一轮有删除（存活消息数变少）→ 整份（增量不带删除信息）；
  //  - 链已经太长（读取方要串一长串才能还原）→ 整份收口；
  //  - 否则 → 相对上一份的增量：体积只与这段改动成正比，而不是与会话总长成正比。
  const liveCount = materializer.countSessionMessages(sessionId);
  const chainLength = previous?.chainLength ?? 0;
  const wantDelta =
    previous !== undefined &&
    previous.createdAt !== undefined &&
    previous.messageCount !== undefined &&
    liveCount >= previous.messageCount &&
    chainLength < MAX_DELTA_CHAIN;
  const since = wantDelta && previous !== undefined && previous.createdAt !== undefined
    ? { hash: previous.hash, wall: previous.createdAt }
    : undefined;

  const snapshot = materializer.exportSessionSnapshot({
    deviceId: ctx.deviceId,
    blindSessionId,
    sessionId,
    watermarks,
    now: ctx.now(),
    ...(since === undefined ? {} : { since }),
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

  const isDelta = snapshot.v === 2;
  hosted.snapshot = {
    hash: encoded.hash,
    epoch: hosted.epoch,
    watermarks,
    bytes: encoded.bytes.length,
    createdAt: snapshot.createdAt,
    messageCount: liveCount,
    chainLength: isDelta ? chainLength + 1 : 0,
  };
  hosted.segmentsSinceSnapshot = 0;

  // 旧快照清理：尽力而为，删不掉只是多占一点存储，绝不能让整次同步失败。
  //  - 新的是**增量**：基准（以及它自己的基准）**必须留着**，读取方要串起来才能还原 → 什么都不删；
  //  - 新的是**整份**：它已经涵盖并取代这一串 → 把该会话下的其它快照都清掉（也就是"链的 GC"）。
  if (ctx.backend.capabilities.delete && ctx.backend.delete !== undefined) {
    try {
      if (!isDelta) {
        const prefix = `snapshots/${blindSessionId}/`;
        const listed = await ctx.backend.list(prefix);
        for (const entry of listed.entries as unknown as Array<{ path?: string; key?: string }>) {
          const path = entry.path ?? entry.key;
          if (path === undefined || path === encoded.path) continue;
          await ctx.backend.delete(path);
        }
      }
    } catch (error) {
      warnings.push(
        `旧快照清理失败（不影响同步，下次同步还会试）：${previousSnapshotPath ?? '(无)'} —— ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { path: encoded.path, hash: encoded.hash, bytes: encoded.bytes };
}

/**
 * 快照 GC：清掉**墓碑会话**留下的快照。
 *
 * 为什么按墓碑而不是按"当前状态里还有没有这个会话"：某台设备可能还没拉到那个会话的元数据，
 * 按"我现在没有"去删就会误删别人正要用的快照。**墓碑是跟着 op 同步的事实**，各设备一致 ——
 * 按它清是安全的。删不掉只告警，绝不让整次同步失败（快照本来就是可丢弃的优化）。
 */
export async function garbageCollectSnapshots(
  ctx: { backend: SyncBackend },
  blindSessionIds: readonly string[],
  warnings: string[],
): Promise<string[]> {
  if (blindSessionIds.length === 0) return [];
  if (!ctx.backend.capabilities.delete || ctx.backend.delete === undefined) return [];

  let entries: Array<{ path?: string; key?: string }>;
  try {
    const listed = await ctx.backend.list('snapshots/');
    entries = listed.entries as unknown as Array<{ path?: string; key?: string }>;
  } catch (error) {
    warnings.push(`快照 GC 跳过（列目录失败）：${error instanceof Error ? error.message : String(error)}`);
    return [];
  }

  const prefixes = blindSessionIds.map((blind) => `snapshots/${blind}/`);
  const removed: string[] = [];
  for (const entry of entries) {
    const path = entry.path ?? entry.key;
    if (path === undefined || !prefixes.some((prefix) => path.startsWith(prefix))) continue;
    try {
      await ctx.backend.delete(path);
      removed.push(path);
    } catch (error) {
      warnings.push(
        `快照 GC 删除失败（不影响同步）：${path} —— ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return removed;
}
