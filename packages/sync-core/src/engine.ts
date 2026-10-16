import { blindId } from '../../oplog/src/bytes.ts';
import type { HlcClock } from '../../oplog/src/hlc.ts';
import type { Materializer } from '../../oplog/src/materialize.ts';
import type { Op } from '../../oplog/src/op.ts';
import type { CryptoPorts } from '../../oplog/src/ports.ts';
import { packSegment } from '../../oplog/src/segment.ts';
import { instrumentBackend, type BackendCallCounters, type SyncBackend } from './backend.ts';
import { chunkOps } from './chunk.ts';
import {
  buildAndUploadSnapshot,
  garbageCollectSnapshots,
  pruneOwnManifests,
  pullChanges,
  verifyPublishedSegment,
  type PullContext,
  type PullOutcome,
  type SnapshotContext,
} from './engine-support.ts';
import { collectTrash, type CollectResult } from './gc.ts';
import { encodeManifest, sessionIdOf, type Manifest, type SessionRef } from './manifest.ts';
import { manifestPath, segmentPath } from './paths.ts';
import type { DeviceRosterList } from './roster.ts';
import { clone, DEFAULT_GRACE_MS, emptyState, type LocalSyncState } from './state.ts';

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
  /** 一个会话累积多少段之后写一份快照（默认 8；0 表示关闭自动快照）。 */
  snapshotThreshold?: number;
  /** 懒加载：返回 false 的会话本轮不拉（例如用户还没打开过的会话）。 */
  shouldPull?: (blindSessionId: string) => boolean;
  /**
   * 本机签名公钥（十六进制）。发布在设备清单里，供对端**验签**。
   * 不给就等于"暂时不参与验签"：别人收到你的段会因拿不到公钥而拒绝（强模式下的正确行为）。
   */
  publicKey?: string;
  /** 本机协商公钥（P-256，十六进制）；发布在设备清单里，别人用它把内容密钥包给本机。 */
  agreementKey?: string;
  /**
   * 拉到远端 op 后的回调（落进调用方自己的日志）。
   * "日志是唯一事实源"的客户端必须实现它，否则重启后按日志重建会丢掉同步来的数据。
   */
  onOps?: (ops: readonly Op[]) => void | Promise<void>;
  state?: LocalSyncState;
}

export interface SyncResult {
  requests: number;
  listCalls: number;
  downloaded: string[];
  uploaded: string[];
  appliedOps: number;
  orphans: number;
  /** 本轮用快照"补课"的会话数（换机/首次同步时应当 > 0）。 */
  hydratedSessions: number;
  hydratedMessages: number;
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
 *
 * 拉取与快照的实现在 `engine-support.ts`（只依赖显式上下文，便于复用与测试）。
 */
export class SyncEngine {
  readonly #options: SyncEngineOptions;
  #state: LocalSyncState;
  readonly #instrumented;
  #downloaded: string[] = [];
  #uploaded: string[] = [];
  #appliedOps = 0;
  #orphans = 0;
  #hydratedSessions = 0;
  #hydratedMessages = 0;

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
    this.#hydratedSessions = 0;
    this.#hydratedMessages = 0;

    const warnings: string[] = [];
    const counters = this.#instrumented.counters;
    const before = {
      requests: counters.list + counters.get + counters.put + counters.delete,
      uploaded: counters.bytesUploaded,
      downloaded: counters.bytesDownloaded,
    };

    await this.#publish(materializer, warnings);
    const pull = await pullChanges(this.#pullContext(), materializer);
    this.#mergePullOutcome(pull);
    warnings.push(...pull.warnings);
    // 清单放在**并入之后**发布：它声明的是"我已并入别人到第几段"，GC 的 safeThrough 直接读它。
    // 真机踩到：发布发生在 pull 之前 → 清单里的 ack 永远落后一轮 → 两台设备都已同步，
    // 分析出来的 safeThrough 却一直是 0，回收按钮根本出不来（复现见 apps/app/test/gc-ack-repro.test.ts）。
    await this.#publishManifest(warnings);

    return {
      requests: counters.list + counters.get + counters.put + counters.delete - before.requests,
      listCalls: counters.list,
      downloaded: [...this.#downloaded],
      uploaded: [...this.#uploaded],
      appliedOps: this.#appliedOps,
      orphans: this.#orphans,
      hydratedSessions: this.#hydratedSessions,
      hydratedMessages: this.#hydratedMessages,
      bytesDownloaded: counters.bytesDownloaded - before.downloaded,
      bytesUploaded: counters.bytesUploaded - before.uploaded,
      warnings,
    };
  }

  // ---- 发布 ----

  async #publish(materializer: Materializer, warnings: string[]): Promise<void> {
    const { deviceId, ports } = this.#options;
    const groups = new Map<string, { blind: string; sessionId: string; ops: Op[] }>();

    for (const op of this.#state.outbox) {
      const sessionId = sessionIdOf(op);
      const blind = await this.blindIdOf(sessionId);
      const group = groups.get(blind) ?? { blind, sessionId, ops: [] };
      group.ops.push(op);
      groups.set(blind, group);
    }

    const published = new Set<string>();

    for (const group of groups.values()) {
      for (const chunk of chunkOps(group.ops)) {
        const hosted = this.#state.hosted[group.blind] ?? {
          lastSeq: 0,
          segments: {},
          bytes: 0,
          epoch: 0,
          segmentsSinceSnapshot: 0,
        };
        // 段号必须**按会话**从 1 连续编号：接收方是按 `1..lastSeq` 逐个找段的，
        // 用"设备全局计数器"会让第二个会话的首段号变成 2，于是接收方永远认为
        // 第 1 号段缺失（实测：数据能同步过去，但每次同步都报警告、水位永远不推进）。
        const seq = hosted.lastSeq + 1;
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

        if (this.#options.verifyUploads !== false) {
          const check = await verifyPublishedSegment(
            { backend: this.#instrumented.backend, ports, deviceId },
            path,
            packed.name,
            seq,
            group.blind,
          );
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
        hosted.segmentsSinceSnapshot += 1;
        // 记下发布时间：GC 的宽限期判定靠它（别忘了跟 `collectTrash` 的用法对上）
        hosted.publishedAt = { ...(hosted.publishedAt ?? {}), [String(seq)]: this.#options.now?.() ?? Date.now() };
        this.#state.ack[deviceId] = Math.max(this.#state.ack[deviceId] ?? 0, seq);
        this.#state.cursors[`${deviceId}|${group.blind}`] = seq;
        this.#state.hosted[group.blind] = hosted;
      }

      // 段攒够就顺手写一份快照：这是"换机只下一次"的关键，不需要用户手动操作。
      const threshold = this.#options.snapshotThreshold ?? 8;
      const hostedAfter = this.#state.hosted[group.blind];
      if (hostedAfter && threshold > 0 && hostedAfter.segmentsSinceSnapshot >= threshold) {
        await this.#uploadSnapshot(materializer, group.sessionId, group.blind, warnings);
      }
    }

    // 只有确认发布成功的 op 才离开 outbox。
    // 注意：manifest **不在这里发**——它要写在 pull 之后，否则清单里声明的
    // "我已并入到哪"（ack）会永远落后于实际并入，对端的 GC 就永远算 0。
    this.#state.outbox = this.#state.outbox.filter((op) => !published.has(op.opId));
  }

  /** 手动发布某个会话的快照（用户点"立即压缩"、或换机前准备）。 */
  async publishSnapshot(materializer: Materializer, sessionId: string): Promise<{ path: string; bytes: number } | undefined> {
    const warnings: string[] = [];
    const blind = await this.blindIdOf(sessionId);
    const encoded = await this.#uploadSnapshot(materializer, sessionId, blind, warnings);
    if (!encoded) return undefined;
    // 快照必须写进 manifest，读取方才知道"可以先拉这份快照"。
    await this.#publishManifest(warnings);
    return { path: encoded.path, bytes: encoded.bytes.length };
  }

  async #uploadSnapshot(
    materializer: Materializer,
    sessionId: string,
    blindSessionId: string,
    warnings: string[],
  ): Promise<{ path: string; hash: string; bytes: Uint8Array } | undefined> {
    const encoded = await buildAndUploadSnapshot(
      this.#snapshotContext(),
      materializer,
      sessionId,
      blindSessionId,
      warnings,
    );
    if (encoded) {
      this.#uploaded.push(encoded.path);
      // 顺手 GC：只在"刚发了快照"这条稀有路径上做，不为它增加每次同步的开销。
      // 只清**墓碑会话**的快照（墓碑是同步事实，各设备一致，不会误删别人还要用的）。
      const dead = Object.values(materializer.state.sessions).filter((session) => session.deleted !== undefined);
      if (dead.length > 0) {
        const blinds: string[] = [];
        for (const session of dead) blinds.push(await this.blindIdOf(session.id));
        const removed = await garbageCollectSnapshots({ backend: this.#snapshotContext().backend }, blinds, warnings);
        if (removed.length > 0) warnings.push(`已清理 ${removed.length} 份墓碑会话的快照`);
      }
    }
    return encoded;
  }

  async #publishManifest(warnings: string[]): Promise<void> {
    const { deviceId, ports } = this.#options;
    const publicKey = this.#options.publicKey;
    const agreementKey = this.#options.agreementKey;
    const manifest: Manifest = {
      v: 1,
      deviceId,
      // 有公钥就发布：对端要拿它验签
      ...(publicKey === undefined || publicKey === '' ? {} : { publicKey }),
      ...(agreementKey === undefined || agreementKey === '' ? {} : { agreementKey }),
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
            ...(hosted.snapshot === undefined ? {} : { snapshot: hosted.snapshot }),
          } satisfies SessionRef,
        ]),
      ),
      ack: this.#state.ack,
    };

    const encoded = await encodeManifest(manifest, { ports, encrypt: ports.cipher !== undefined });
    const path = manifestPath(deviceId, encoded.fileName);
    const result = await this.#instrumented.backend.put(path, encoded.bytes, { ifNoneMatch: true });
    if (result.ok || result.exists === true) {
      this.#state.manifestSeq += 1;
      this.#state.manifestCursors[deviceId] = manifest.seq;
      this.#uploaded.push(path);
      await pruneOwnManifests(
        { backend: this.#instrumented.backend, state: this.#state, keep: 2 },
        path,
      );
    } else {
      warnings.push(`manifest 上传失败：${path}`);
    }
  }

  // ---- 保守 GC ----

  /** 回收判定见 `gc.ts`：名单内全部活跃设备确认 + 宽限期 + 先进 trash。默认只分析。 */
  async collect(dryRun = true): Promise<CollectResult> {
    return collectTrash({
      backend: this.#instrumented.backend,
      deviceId: this.#options.deviceId,
      roster: this.#options.roster,
      ack: this.#state.ack,
      peerAck: this.#state.peerAck,
      hosted: this.#state.hosted,
      peerHosted: this.#state.peerHosted,
      now: this.#options.now ?? Date.now,
      graceMs: this.#options.graceMs ?? DEFAULT_GRACE_MS,
      dryRun,
    });
  }

  // ---- 内部上下文 ----

  #pullContext(): PullContext {
    return {
      backend: this.#instrumented.backend,
      ports: this.#options.ports,
      clock: this.#options.clock,
      deviceId: this.#options.deviceId,
      activeDevices: new Set(this.#options.roster.activeIds()),
      state: this.#state,
      ...(this.#options.onOps === undefined ? {} : { onOps: this.#options.onOps }),
      ...(this.#options.shouldPull === undefined ? {} : { shouldPull: this.#options.shouldPull }),
    };
  }

  #snapshotContext(): SnapshotContext {
    return {
      backend: this.#instrumented.backend,
      ports: this.#options.ports,
      deviceId: this.#options.deviceId,
      state: this.#state,
      now: this.#options.now ?? Date.now,
    };
  }

  #mergePullOutcome(outcome: PullOutcome): void {
    this.#appliedOps += outcome.appliedOps;
    this.#orphans += outcome.orphans;
    this.#hydratedSessions += outcome.hydratedSessions;
    this.#hydratedMessages += outcome.hydratedMessages;
    this.#downloaded.push(...outcome.downloaded);
  }
}

