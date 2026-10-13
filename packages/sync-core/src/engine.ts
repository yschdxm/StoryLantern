import { blindId } from '../../oplog/src/bytes.ts';
import type { HlcClock } from '../../oplog/src/hlc.ts';
import type { Materializer } from '../../oplog/src/materialize.ts';
import type { Op } from '../../oplog/src/op.ts';
import type { CryptoPorts } from '../../oplog/src/ports.ts';
import { packSegment, SegmentError, unpackSegment } from '../../oplog/src/segment.ts';
import { instrumentBackend, type BackendCallCounters, type SyncBackend } from './backend.ts';
import { chunkOps } from './chunk.ts';
import { collectTrash, type CollectResult } from './gc.ts';
import { decodeManifest, encodeManifest, sessionIdOf, type Manifest, type SessionRef } from './manifest.ts';
import { DEVICES_PREFIX, parseManifestFileName, segmentPath } from './paths.ts';
import type { DeviceRosterList } from './roster.ts';
import { clone, DEFAULT_GRACE_MS, emptyState, type HostedSession, type LocalSyncState } from './state.ts';

export interface SyncEngineOptions {
  deviceId: string;
  backend: SyncBackend;
  ports: CryptoPorts;
  roster: DeviceRosterList;
  /** 盲化路径用的密钥（配对时下发，永不落到远端）。 */
  blindKey: Uint8Array;
  clock: HlcClock;
  now?: () => number;
  graceMs?: number;
  /** 发布后回读校验（默认开启）。关掉能省一次请求，但半上传会静默变成"以为发出去了"。 */
  verifyUploads?: boolean;
  state?: LocalSyncState;
}

export interface SyncResult {
  requests: number;
  listCalls: number;
  downloaded: string[];
  uploaded: string[];
  appliedOps: number;
  orphans: number;
  bytesDownloaded: number;
  bytesUploaded: number;
  warnings: string[];
}

/**
 * 同步引擎。
 *
 * 两条不变式（测试直接断言）：
 *  1. **不遍历目录树**：发现只列 `devices/**`，段的精确路径由 manifest 给出。
 *  2. **不破坏本地**：远端回滚、缺段、段校验失败时只告警，绝不回退或覆盖本地数据。
 */
export class SyncEngine {
  readonly #options: SyncEngineOptions;
  #state: LocalSyncState;
  readonly #instrumented;
  #downloaded: string[] = [];
  #uploaded: string[] = [];
  #appliedOps = 0;
  #orphans = 0;

  constructor(options: SyncEngineOptions) {
    this.#options = options;
    this.#state = options.state ?? emptyState();
    this.#instrumented = instrumentBackend(options.backend);
  }

  get counters(): BackendCallCounters {
    return this.#instrumented.counters;
  }

  get state(): LocalSyncState {
    return this.#state;
  }

  exportState(): LocalSyncState {
    return clone(this.#state);
  }

  importState(state: LocalSyncState): void {
    this.#state = clone(state);
  }

  blindIdOf(sessionId: string): Promise<string> {
    return blindId(this.#options.blindKey, sessionId, this.#options.ports.digest);
  }

  /** 本地产生一个 op：进 outbox，下次 `sync()` 打包发布。 */
  enqueue(op: Op): void {
    this.#state.outbox.push(op);
  }

  async sync(materializer: Materializer): Promise<SyncResult> {
    this.#downloaded = [];
    this.#uploaded = [];
    this.#appliedOps = 0;
    this.#orphans = 0;
    const warnings: string[] = [];
    const counters = this.#instrumented.counters;
    const before = {
      requests: counters.list + counters.get + counters.put + counters.delete,
      uploaded: counters.bytesUploaded,
      downloaded: counters.bytesDownloaded,
    };

    await this.#publish(warnings);
    await this.#pull(materializer, warnings);

    return {
      requests: counters.list + counters.get + counters.put + counters.delete - before.requests,
      listCalls: counters.list,
      downloaded: [...this.#downloaded],
      uploaded: [...this.#uploaded],
      appliedOps: this.#appliedOps,
      orphans: this.#orphans,
      bytesDownloaded: counters.bytesDownloaded - before.downloaded,
      bytesUploaded: counters.bytesUploaded - before.uploaded,
      warnings,
    };
  }

  // ---- 发布 ----

  async #publish(warnings: string[]): Promise<void> {
    const { deviceId, ports } = this.#options;
    const groups = new Map<string, { blind: string; ops: Op[] }>();

    for (const op of this.#state.outbox) {
      const blind = await this.blindIdOf(sessionIdOf(op));
      const group = groups.get(blind) ?? { blind, ops: [] };
      group.ops.push(op);
      groups.set(blind, group);
    }

    const published = new Set<string>();

    for (const group of groups.values()) {
      for (const chunk of chunkOps(group.ops)) {
        // 序号无论成败都推进：失败重试若复用同名，会撞上"已存在的坏文件"而永远卡住。
        const seq = this.#state.seq;
        this.#state.seq += 1;

        const hosted = this.#state.hosted[group.blind] ?? { lastSeq: 0, segments: {}, bytes: 0, epoch: 0 };
        const packed = await packSegment({
          ops: chunk,
          deviceId,
          seq,
          blindSessionId: group.blind,
          epoch: hosted.epoch,
          ports,
          encrypt: ports.cipher !== undefined,
        });
        const path = segmentPath(deviceId, group.blind, packed.name);
        const result = await this.#instrumented.backend.put(path, packed.bytes, { ifNoneMatch: true });
        if (!result.ok && result.exists !== true) {
          warnings.push(`段上传失败：${path}`);
          continue;
        }

        // 发布必须以"回读校验通过"为准：半上传/被吃字节的写入不能算发布成功，
        // 否则本地会误以为远端已有该段而永远不再重传。
        if (this.#options.verifyUploads !== false) {
          const check = await this.#verifyPublished(path, packed.name, seq, group.blind);
          if (!check.ok) {
            warnings.push(`发布校验失败：${path} —— ${check.reason}（已保留待重传）`);
            if (this.#instrumented.backend.delete) await this.#instrumented.backend.delete(path);
            continue;
          }
        }

        this.#uploaded.push(path);
        for (const op of chunk) published.add(op.opId);
        hosted.lastSeq = seq;
        hosted.segments[String(seq)] = packed.blobHash.slice(0, 8);
        hosted.bytes += packed.bytes.length;
        this.#state.ack[deviceId] = Math.max(this.#state.ack[deviceId] ?? 0, seq);
        this.#state.cursors[`${deviceId}|${group.blind}`] = seq;
        this.#state.hosted[group.blind] = hosted;
      }
    }

    // 只有确认发布成功的 op 才离开 outbox。
    this.#state.outbox = this.#state.outbox.filter((op) => !published.has(op.opId));
    await this.#publishManifest(warnings);
  }

  async #publishManifest(warnings: string[]): Promise<void> {
    const { deviceId, ports } = this.#options;
    const manifest: Manifest = {
      v: 1,
      deviceId,
      seq: this.#state.manifestSeq,
      epoch: 0,
      updatedAt: this.#options.now?.() ?? Date.now(),
      sessions: Object.fromEntries(
        Object.entries(this.#state.hosted).map(([blind, hosted]) => [
          blind,
          {
            blindSessionId: blind,
            lastSeq: hosted.lastSeq,
            segments: hosted.segments,
            epoch: hosted.epoch,
            bytes: hosted.bytes,
          } satisfies SessionRef,
        ]),
      ),
      ack: this.#state.ack,
    };

    const encoded = await encodeManifest(manifest, { ports, encrypt: ports.cipher !== undefined });
    const path = `${DEVICES_PREFIX}${deviceId}/manifest/${encoded.fileName}`;
    const result = await this.#instrumented.backend.put(path, encoded.bytes, { ifNoneMatch: true });
    if (result.ok || result.exists === true) {
      this.#state.manifestSeq += 1;
      this.#state.manifestCursors[deviceId] = manifest.seq;
      this.#uploaded.push(path);
    } else {
      warnings.push(`manifest 上传失败：${path}`);
    }
  }

  async #verifyPublished(
    path: string,
    fileName: string,
    seq: number,
    blindSessionId: string,
  ): Promise<{ ok: boolean; reason: string }> {
    const { deviceId, ports } = this.#options;
    try {
      const bytes = await this.#instrumented.backend.get(path);
      await unpackSegment(bytes, { ports, fileName, expect: { deviceId, seq, blindSessionId } });
      return { ok: true, reason: '' };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  // ---- 拉取 ----

  async #pull(materializer: Materializer, warnings: string[]): Promise<void> {
    const { deviceId, ports, roster } = this.#options;
    const active = new Set(roster.activeIds());

    // 只列 devices/：整个同步过程从不触碰 logs/ 目录树。
    const listing = await this.#instrumented.backend.list(DEVICES_PREFIX);

    const versionsByDevice = new Map<string, { seq: number; path: string }[]>();
    for (const entry of listing.entries) {
      const parts = entry.path.split('/');
      if (parts.length !== 4 || parts[0] !== 'devices' || parts[2] !== 'manifest') continue;
      const owner = parts[1] as string;
      const parsed = parseManifestFileName(parts[3] as string);
      if (!parsed) continue;
      if (owner === deviceId) continue;
      if (!active.has(owner)) {
        warnings.push(`忽略名单外设备 ${owner} 的 manifest`);
        continue;
      }
      const list = versionsByDevice.get(owner) ?? [];
      list.push({ seq: parsed.seq, path: entry.path });
      versionsByDevice.set(owner, list);
    }

    for (const [owner, versions] of versionsByDevice) {
      versions.sort((a, b) => a.seq - b.seq);
      const latest = versions[versions.length - 1];
      if (!latest) continue;

      const seen = this.#state.manifestCursors[owner] ?? 0;
      if (latest.seq < seen) {
        warnings.push(
          `设备 ${owner} 的 manifest 序号回退（本地见过 ${seen}，远端最新 ${latest.seq}）——疑似被回滚/还原，本次忽略`,
        );
        continue;
      }

      let manifest: Manifest;
      try {
        const bytes = await this.#instrumented.backend.get(latest.path);
        manifest = await decodeManifest(bytes, { ports, expectDeviceId: owner });
      } catch (error) {
        warnings.push(`manifest 不可用（${owner}）：${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      this.#state.manifestCursors[owner] = manifest.seq;
      this.#state.peerAck[owner] = manifest.ack;
      this.#state.peerHosted[owner] = Object.fromEntries(
        Object.entries(manifest.sessions).map(([blind, ref]) => [
          blind,
          { lastSeq: ref.lastSeq, segments: ref.segments, bytes: ref.bytes, epoch: ref.epoch },
        ]),
      );

      for (const ref of Object.values(manifest.sessions)) {
        await this.#pullSession(materializer, warnings, owner, ref);
      }
    }
  }

  async #pullSession(materializer: Materializer, warnings: string[], owner: string, ref: SessionRef): Promise<void> {
    const { ports, clock } = this.#options;
    const key = `${owner}|${ref.blindSessionId}`;
    const from = this.#state.cursors[key] ?? 0;
    const appliedSeqs = new Set(this.#state.appliedSeqs[key] ?? []);

    for (let seq = from + 1; seq <= ref.lastSeq; seq += 1) {
      // 已成功过的段（只是因为前面有缺口而没推进水位）直接跳过，避免重复下载。
      if (appliedSeqs.has(seq)) continue;

      const hash8 = ref.segments[String(seq)];
      if (!hash8) {
        warnings.push(`设备 ${owner} 的会话 ${ref.blindSessionId} 缺少第 ${seq} 号段（可能已被 GC 或尚未上传）`);
        continue;
      }
      const fileName = `${String(seq).padStart(8, '0')}-${hash8}.jsonl.gz`;
      const path = segmentPath(owner, ref.blindSessionId, fileName);

      let ops: Op[];
      try {
        const bytes = await this.#instrumented.backend.get(path);
        this.#downloaded.push(path);
        const unpacked = await unpackSegment(bytes, {
          ports,
          fileName,
          expect: { deviceId: owner, seq, blindSessionId: ref.blindSessionId },
        });
        ops = unpacked.ops;
      } catch (error) {
        const code = error instanceof SegmentError ? error.code : 'unknown';
        warnings.push(`段被拒绝（${code}）：${path}${error instanceof Error ? ` —— ${error.message}` : ''}`);
        // 失败的段绝不推进水位：它会作为"缺口"在下一次同步被重试，
        // 而不是被当成已消费而永久丢失。
        continue;
      }

      for (const op of ops) clock.merge(op.hlc, owner);
      const applied = materializer.applyAll(ops);
      this.#appliedOps += applied.applied;
      this.#orphans += applied.orphans;
      appliedSeqs.add(seq);
      this.#state.ack[owner] = Math.max(this.#state.ack[owner] ?? 0, seq);
    }

    // 水位只推进到第一个缺口之前，因此缺口一定会被重试。
    let cursor = from;
    while (appliedSeqs.has(cursor + 1)) cursor += 1;
    if (cursor > 0) this.#state.cursors[key] = cursor;
    if (appliedSeqs.size > 0) this.#state.appliedSeqs[key] = [...appliedSeqs].sort((a, b) => a - b);
  }

  // ---- 保守 GC ----

  /** 回收判定见 `gc.ts`：名单内全部活跃设备确认 + 宽限期 + 先进 trash。 */
  async collect(): Promise<CollectResult> {
    const hosted: Record<string, HostedSession> = this.#state.hosted;
    return collectTrash({
      backend: this.#instrumented.backend,
      deviceId: this.#options.deviceId,
      roster: this.#options.roster,
      ack: this.#state.ack,
      peerAck: this.#state.peerAck,
      hosted,
      peerHosted: this.#state.peerHosted,
      now: this.#options.now ?? Date.now,
      graceMs: this.#options.graceMs ?? DEFAULT_GRACE_MS,
    });
  }
}
