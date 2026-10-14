import { HlcClock } from '../../../../../packages/oplog/src/index.ts';
import { DeviceRosterList } from '../../../../../packages/sync-core/src/roster.ts';
import { SyncEngine, type SyncResult } from '../../../../../packages/sync-core/src/engine.ts';
import { parseManifestPath, DEVICES_PREFIX } from '../../../../../packages/sync-core/src/paths.ts';
import type { SyncBackend } from '../../../../../packages/sync-core/src/backend.ts';
import type { LocalSyncState } from '../../../../../packages/sync-core/src/state.ts';
import { emptyState } from '../../../../../packages/sync-core/src/state.ts';
import { createWebCryptoPorts, deriveSyncKeys, webCryptoAvailable } from './crypto.ts';
import type { OpLogRepository } from '../op-repository.ts';

/**
 * 同步服务：把 op 段推到"哑存储"，再从那儿拉回来。
 *
 * 设计取舍（都写在这里，免得日后有人以为漏了）：
 *  - **共享口令**：两台设备输入同一个同步口令，派生出相同的盲化密钥与加密密钥。
 *    哑存储只看到盲化路径与密文，既不知道会话是谁，也读不出内容。设备名单因此"自动发现"
 *    （能解开的就是自己人），配对流程留到下一步。
 *  - **不做每设备签名**：AEAD 已保证"改不了、读不出"；签名额外给的是"归属"证明，
 *    等配对流程做好再补。
 *  - **关闭快照**（`snapshotThreshold: 0`）：快照给的是"状态"而不是 op，
 *    而本应用的读模型完全由 op 重建——从快照补课会让重启后的重建丢数据。
 *    要真正用快照，得让它以 op 形式落地（下一步）。
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
}

export interface SyncServiceOptions {
  repository: OpLogRepository;
  backend: SyncBackend;
  deviceId: string;
  secret: string;
  store: SyncStorePort;
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

  return {
    async sync(): Promise<SyncSummary> {
      let imported = 0;
      await options.repository.ready;
      const stored = await options.store.load();
      const restored = sanitizeSyncState(stored.state);
      // 状态被判为不可用（旧编号）时，本地 op 要整份重推一遍
      const baseCursor = restored === undefined ? 0 : stored.enqueuedSeq;

      // 设备名单：从远端清单里发现（能解开我们密文的才是自己人）
      const roster = new DeviceRosterList();
      roster.add({ deviceId: options.deviceId, publicKey: '', addedAt: now(), name: '本机' });
      try {
        const listing = await options.backend.list(DEVICES_PREFIX);
        for (const entry of listing.entries) {
          const parsed = parseManifestPath(entry.path);
          if (parsed !== undefined && parsed.deviceId !== options.deviceId) {
            roster.add({ deviceId: parsed.deviceId, publicKey: '', addedAt: now() });
          }
        }
      } catch (cause) {
        // 列目录失败不该让同步崩掉：可能只是远端还没建过目录
        const message = cause instanceof Error ? cause.message : String(cause);
        if (!/404/.test(message)) throw cause;
      }

      const engine = new SyncEngine({
        deviceId: options.deviceId,
        backend: options.backend,
        ports,
        roster,
        blindKey: keys.blindKey,
        clock: new HlcClock({ now }),
        // 见文件头：快照暂不接入，历史靠段同步
        snapshotThreshold: 0,
        ...(restored === undefined ? {} : { state: restored }),
        // 拉到的 op 必须先落进本地日志，再应用到内存状态
        onOps: async (ops) => {
          const outcome = await options.repository.importOps(ops);
          imported += outcome.appended;
        },
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
      await options.store.save({ state: engine.exportState(), enqueuedSeq: stats.lastSeq });

      return summarize(result, enqueued, imported);
    },
  };
}
