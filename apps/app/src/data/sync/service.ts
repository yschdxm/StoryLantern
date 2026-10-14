import { HlcClock } from '../../../../../packages/oplog/src/index.ts';
import { SyncEngine, type SyncEngineOptions, type SyncResult } from '../../../../../packages/sync-core/src/engine.ts';
import { parseManifestPath, DEVICES_PREFIX } from '../../../../../packages/sync-core/src/paths.ts';
import { DeviceRosterList } from '../../../../../packages/sync-core/src/roster.ts';
import type { SyncBackend } from '../../../../../packages/sync-core/src/backend.ts';
import type { LocalSyncState } from '../../../../../packages/sync-core/src/state.ts';
import { emptyState } from '../../../../../packages/sync-core/src/state.ts';
import type { Op } from '../../../../../packages/oplog/src/op.ts';
import type { SyncDevice } from '../../screens/screen-props.ts';
import type { DeviceStore } from '../op-ports.ts';
import type { OpLogRepository } from '../op-repository.ts';
import { createWebCryptoPorts, deriveSyncKeys, webCryptoAvailable } from './crypto.ts';
import { describeDevice, loadRoster, mergeRoster, saveRoster } from './roster-store.ts';

/**
 * 同步服务：把 op 段推到"哑存储"，再从那儿拉回来。
 *
 * 设计取舍（都写在这里，免得日后有人以为漏了）：
 *  - **共享口令**：两台设备输入同一个同步口令，派生出相同的盲化密钥与加密密钥。
 *    哑存储只看到盲化路径与密文，既不知道会话是谁，也读不出内容。设备名单因此"自动发现"
 *    （能解开的就是自己人）；显式配对（公钥交换）是下一步。
 *  - **不做每设备签名**：AEAD 已保证"改不了、读不出"；签名额外给的是"归属"证明，
 *    等配对流程做好再补。
 *  - **关闭同步侧快照**（`snapshotThreshold: 0`）：那类快照给的是"状态"而不是 op，
 *    而本应用的读模型完全由 op 重建。冷启动加速另有本机快照（见 `op-snapshot.ts`）。
 *  - **设备名单本地持久化**：GC 需要"所有活跃设备都已并入"这个判据，哑存储给不出，
 *    只能在客户端维护；之前每次同步临时重建，导致吊销重启就忘。
 */

export interface SyncStorePort {
  load(): Promise<{ state?: LocalSyncState; enqueuedSeq: number }>;
  save(input: { state: LocalSyncState; enqueuedSeq: number }): Promise<void>;
}

export interface SyncSummary {
  uploaded: number;
  downloaded: number;
  appliedOps: number;
  /** 本次推送出去的本地 op 数。 */
  enqueued: number;
  requests: number;
  warnings: string[];
}

export interface SyncService {
  sync(): Promise<SyncSummary>;
  /** 设备名单（本地持久化 + 远端发现合并后的结果）。 */
  devices(): Promise<SyncDevice[]>;
  /** 吊销设备：它离线期间的新数据将不再保留。本机不能被吊销。 */
  revoke(deviceId: string): Promise<boolean>;
  /** 回收分析/执行；默认只分析（`dryRun = true`）。 */
  collect(dryRun?: boolean): Promise<{ candidates: string[]; moved: string[]; reasons: string[] }>;
}

export interface SyncServiceOptions {
  repository: OpLogRepository;
  backend: SyncBackend;
  deviceId: string;
  secret: string;
  store: SyncStorePort;
  /** 设备本地 kv：设备名单放在这里（吊销必须能跨重启保持）。 */
  device: DeviceStore;
  now?: () => number;
}

export function syncAvailable(): boolean {
  return webCryptoAvailable();
}

export function summarize(result: SyncResult, enqueued: number, imported: number): SyncSummary {
  return {
    uploaded: result.uploaded.length,
    downloaded: result.downloaded.length,
    // 用"真正落到本地日志的 op 数"而不是引擎的计数器：
    // 引擎把 op 应用进的物化器与我们自己的一模一样，所以它的计数是 0（已是重复应用）。
    appliedOps: imported,
    enqueued,
    requests: result.requests,
    warnings: [...result.warnings],
  };
}

/**
 * 旧版本写下的同步进度要丢掉：那时段号是"设备全局"编号，而接收方按每会话
 * `1..lastSeq` 找段，于是每次同步都会报缺段、水位永远不推进。
 *
 * 丢掉**段清单与游标**即可（内容不会重传错，因为段名含内容哈希、同名同内容），
 * 但**保留 manifest 序号**——否则我们会用更小的序号发布清单，
 * 对端会按"疑似回滚"直接忽略（见 engine-support 的回滚检测）。
 */
export function sanitizeSyncState(state: LocalSyncState | undefined): LocalSyncState | undefined {
  if (state === undefined) return undefined;
  const broken = Object.values(state.hosted ?? {}).some((hosted) => {
    const seqs = Object.keys(hosted.segments ?? {})
      .map(Number)
      .sort((left, right) => left - right);
    return seqs.some((seq, index) => seq !== index + 1) || hosted.lastSeq !== seqs.length;
  });
  if (!broken) return state;

  const fresh = emptyState();
  return {
    ...fresh,
    manifestSeq: state.manifestSeq ?? fresh.manifestSeq,
    manifestCursors: state.manifestCursors ?? {},
    manifestPaths: state.manifestPaths ?? [],
  };
}

export async function createSyncService(options: SyncServiceOptions): Promise<SyncService> {
  const now = options.now ?? (() => Date.now());
  const keys = await deriveSyncKeys(options.secret);
  const ports = createWebCryptoPorts(keys);

  /** 设备本地 kv：名单与同步状态都放这里。 */
  const store: SyncServiceOptions['store'] = options.store;

  /**
   * 每次进入同步/回收都要先做的一步：读本机状态、发现远端设备、合并名单、造引擎。
   *
   * 抽出来是因为 `collect()` 也需要**同一份** `ack/peerAck/hosted`——
   * 如果回收用另一套上下文，判定依据就与实际同步状态不一致了。
   */
  const prepare = async (onOps?: (ops: readonly Op[]) => Promise<void>): Promise<{
    engine: SyncEngine;
    roster: DeviceRosterList;
    restored: LocalSyncState | undefined;
    baseCursor: number;
  }> => {
    await options.repository.ready;
    const stored = await store.load();
    const restored = sanitizeSyncState(stored.state);
    // 状态被判为不可用（旧编号）时，本地 op 要整份重推一遍
    const baseCursor = restored === undefined ? 0 : stored.enqueuedSeq;

    // 远端发现：能解开我们密文并发布设备清单的，才是自己人
    const discovered: { deviceId: string }[] = [];
    try {
      const listing = await options.backend.list(DEVICES_PREFIX);
      for (const entry of listing.entries) {
        const parsed = parseManifestPath(entry.path);
        if (parsed !== undefined && parsed.deviceId !== options.deviceId) discovered.push({ deviceId: parsed.deviceId });
      }
    } catch (cause) {
      // 列目录失败不该让同步崩掉：可能只是远端还没建过目录
      const message = cause instanceof Error ? cause.message : String(cause);
      if (!/404/.test(message)) throw cause;
    }

    // 本地名单（含吊销） + 这次发现的设备；本机永远在里面且不被吊销
    const persisted = await loadRoster(options.device);
    const { roster } = mergeRoster(persisted, discovered, { selfId: options.deviceId, now: now() });
    await saveRoster(options.device, roster);

    const engineOptions: SyncEngineOptions = {
      deviceId: options.deviceId,
      backend: options.backend,
      ports,
      roster,
      blindKey: keys.blindKey,
      clock: new HlcClock({ now }),
      // 见文件头：同步侧快照暂不接入，历史靠段同步
      snapshotThreshold: 0,
    };
    if (restored !== undefined) engineOptions.state = restored;
    if (onOps !== undefined) engineOptions.onOps = onOps;
    const engine = new SyncEngine(engineOptions);

    return { engine, roster, restored, baseCursor };
  };

  return {
    async sync(): Promise<SyncSummary> {
      let imported = 0;
      const { engine, baseCursor } = await prepare(async (ops) => {
        // 拉到的 op 必须先落进本地日志，再应用到内存状态
        const outcome = await options.repository.importOps(ops);
        imported += outcome.appended;
      });

      // 把本地"还没推过"的 op 放进 outbox
      let cursor = baseCursor;
      let enqueued = 0;
      for (;;) {
        const page = await options.repository.exportOps(cursor);
        if (page.ops.length === 0) break;
        for (const op of page.ops) engine.enqueue(op);
        enqueued += page.ops.length;
        cursor = page.lastSeq;
        if (page.ops.length < 1_000) break;
      }

      // 引擎需要**同一份**物化状态：它会把拉到的 op 应用进去
      const result = await engine.sync(options.repository.currentMaterializer());

      // 游标推进到日志末尾：刚拉进来的远端 op 不该再被推回去
      const stats = await options.repository.logStats();
      await store.save({ state: engine.exportState(), enqueuedSeq: stats.lastSeq });

      return summarize(result, enqueued, imported);
    },

    async devices(): Promise<SyncDevice[]> {
      // 顺带做一次远端发现：否则"还没同步过"时名单是空的，用户会以为没有设备。
      // 发现结果写进本地名单（与吊销状态合并，不会把已吊销的复活）。
      const { roster } = await prepare();
      return roster.list().map((record) => describeDevice(record, options.deviceId));
    },

    async revoke(deviceId: string): Promise<boolean> {
      if (deviceId === options.deviceId) return false;
      const roster = await loadRoster(options.device);
      const changed = roster.revoke(deviceId, now());
      if (changed) await saveRoster(options.device, roster);
      return changed;
    },

    async collect(dryRun = true) {
      const { engine } = await prepare();
      return engine.collect(dryRun);
    },
  };
}
