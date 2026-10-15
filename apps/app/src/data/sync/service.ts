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
import { detectKeyWrapSupport } from './envelope.ts';
import { createDeviceSigner } from './signer.ts';
import { createWebCryptoKeyWrap, loadOrCreateAgreementKeys } from './envelope.ts';
import { ensureKeyring } from '../../../../../packages/sync-core/src/keyring-store.ts';
import type { CryptoPorts } from '../../../../../packages/oplog/src/index.ts';
import { createPasswordProofPort, createPortsFromContentKey } from './crypto.ts';
import { rotateKeyring } from '../../../../../packages/sync-core/src/keyring-store.ts';
import { publishRecoveryKey } from './recovery-publish.ts';
import { acceptJoinRequests, publishJoinRequest } from './join-flow.ts';
import { describeDevice, loadRoster, mergeRoster, saveRoster } from './roster-store.ts';

/** 同步服务：把 op 段推到"哑存储"，再从那儿拉回来。 */

export interface SyncStorePort {
  load(): Promise<{ state?: LocalSyncState; enqueuedSeq: number }>;
  save(input: { state: LocalSyncState; enqueuedSeq: number }): Promise<void>;
}

/** 本机上次用过的 keyring 世代：换了世代就把同步进度作废、全量重发（段只是传输）。 */
export const SYNC_EPOCH_KEY = 'sync.epoch.v1';

export interface SyncSummary {
  uploaded: number;
  downloaded: number;
  appliedOps: number;
  /** 本次推送出去的本地 op 数。 */
  enqueued: number;
  requests: number;
  warnings: string[];
  /** 有 keyring 但没包给我：加入请求已提交，等一台已授权设备接纳。 */
  waiting?: boolean;
}

export interface SyncService {
  /** 忘记口令时把恢复私钥传进来（只这一次调用用，不落盘）。 */
  sync(recoveryPrivateKey?: string): Promise<SyncSummary>;
  /** 设备名单（本地持久化 + 远端发现合并后的结果）。 */
  devices(): Promise<SyncDevice[]>;
  /** 吊销设备：它离线期间的新数据将不再保留。本机不能被吊销。 */
  revoke(deviceId: string): Promise<boolean>;
  /**
   * **永久禁用（黑名单）**：拒绝它的签名、不认它的加入请求。
   *
   * 注意这条**单独做不到"读不到新内容"**——要配合换代（新数据钥匙只包给留下的设备）才成立；
   * 已经在它手里的旧内容收不回。这两条都写在界面上。
   */
  ban(deviceId: string): Promise<boolean>;
  /** 生成恢复密钥：公钥发布到共享目录；私钥只返回这一次（离线保存，不落地）。 */
  createRecovery(): Promise<{ publicKey: string; privateKey: string }>;
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

/**
 * 从引擎状态里收集对端公钥写进名单。
 *
 * 为什么要落盘：验签发生在**收段**的时候，那时不一定刚好有清单在手边；
 * 而且名单本来就要跨重启保持（吊销状态同理）。
 */
function learnPublicKeys(roster: DeviceRosterList, selfId: string, state: LocalSyncState): number {
  let changed = 0;
  for (const [owner, publicKey] of Object.entries(state.peerPublicKeys ?? {})) {
    if (owner === selfId) continue;
    {
      if (publicKey === '') continue;
      const existing = roster.get(owner);
      if (existing?.publicKey === publicKey) continue;
      roster.add({
        deviceId: owner,
        publicKey,
        addedAt: existing?.addedAt ?? Date.now(),
        ...(existing?.name === undefined ? {} : { name: existing.name }),
        ...(existing?.revokedAt === undefined ? {} : { revokedAt: existing.revokedAt }),
      });
      changed += 1;
    }
  }
  return changed;
}

export async function createSyncService(options: SyncServiceOptions): Promise<SyncService> {
  const now = options.now ?? (() => Date.now());
  // 忘记口令时的一次性恢复私钥：只在本次 sync 调用里生效，不落盘
  let pendingRecoveryKey: string | undefined;
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
    /** 有 keyring 但没包给我：已提交加入请求，等一台已授权设备接纳。 */
    waiting: boolean;
      /** 有 keyring 但拿不到 X25519 协商密钥：加入这条路走不通，必须如实报出来。 */
      joinBlocked: boolean;
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

    // 每台设备自己的"锁和钥匙"：公钥随设备清单发布，供对端验签
    const signer = await createDeviceSigner({ deviceId: options.deviceId, device: options.device, secret: options.secret });

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
    // 协商密钥对（X25519）：收自己那份内容密钥要用它，管理方式与签名密钥一致
    const keyWrapSupported = await detectKeyWrapSupport();
    const agreement = keyWrapSupported
      ? await loadOrCreateAgreementKeys(createWebCryptoKeyWrap(), options.device)
      : undefined;
    if (agreement !== undefined) engineOptions.agreementKey = agreement.publicKey;

    if (signer.publicKeyHex !== '') {
      engineOptions.publicKey = signer.publicKeyHex;
      const self = roster.get(options.deviceId);
      if (self !== undefined && self.publicKey !== signer.publicKeyHex) {
        roster.add({ ...self, publicKey: signer.publicKeyHex });
        await saveRoster(options.device, roster);
      }
    }
    // "一人一把锁"：把内容密钥按名单里每台设备的公钥各包一份，发布到共享目录。
    //
    // 现在只**准备**钥匙（发布 + 打开），还没拿它替换段加密——那一步是格式变更，
    // 要和"读旧数据回退"一起做（见 docs/M2-STATUS.md 的 ⑥ 后半）。
    // 注意：这里**只准备钥匙**（发布 keyring 并打开自己那份），
    // **不**把端口换成内容密钥——那一步会让已有旧段读不出来（段还是用口令派生的钥匙加的密）。
    // 正确的切换要和"解密失败时用旧钥匙回退"一起做，见 docs/M2-STATUS.md 的 ⑥ 后半。
    const keyring =
      agreement === undefined
        ? undefined
        : await ensureKeyring({
            backend: options.backend,
            deviceId: options.deviceId,
            agreement,
            peerAgreementKeys: restored?.peerAgreementKeys ?? {},
            keyWrap: createWebCryptoKeyWrap(),
            roster,
          });
    // **切换**：钥匙包给我过，就改用数据钥匙（不再用口令派生的那把）加密段/清单。
    // **不做"读旧数据回退"**（已定）：换代时把同步进度作废、从本地 op 日志全量重发。
    let state = restored;
    if (keyring?.mine === true) {
      engineOptions.ports = await createPortsFromContentKey(keyring.contentKey, keys.blindKey);
      const seenEpoch = Number((await options.device.get(SYNC_EPOCH_KEY)) ?? '0');
      if (seenEpoch !== keyring.epoch) {
        state = undefined;
        await options.device.set(SYNC_EPOCH_KEY, String(keyring.epoch));
      }
    }
    if (state !== undefined) engineOptions.state = state;

    // 加入流程：能打开 keyring 就替新设备发钥匙；打不开（我不在里面）就写自己的加入请求。
    if (keyring !== undefined && agreement !== undefined) {
      const joinProof = createPasswordProofPort(keys);
      if (keyring.mine) {
        await acceptJoinRequests({
          backend: options.backend,
          device: options.device,
          keyWrap: createWebCryptoKeyWrap(),
          contentKey: keyring.contentKey,
          banned: new Set(roster.bannedIds()),
          joinProof,
          selfId: options.deviceId,
          now,
        });
      } else {
        await publishJoinRequest({
          backend: options.backend,
          deviceId: options.deviceId,
          publicKey: signer.publicKeyHex,
          agreementKey: agreement.publicKey,
          joinProof,
          now,
          ...(pendingRecoveryKey === undefined ? {} : { recoveryPrivateKey: pendingRecoveryKey }),
        });
      }
    }

    if (onOps !== undefined) engineOptions.onOps = onOps;
    const engine = new SyncEngine(engineOptions);

    return { engine, roster, restored, baseCursor, waiting: keyring !== undefined && keyring.mine === false, joinBlocked: agreement === undefined };
  };

  return {
    async sync(recoveryPrivateKey?: string): Promise<SyncSummary> {
      pendingRecoveryKey = recoveryPrivateKey;
      let imported = 0;
      const prepared = await prepare(async (ops) => {
        // 拉到的 op 必须先落进本地日志，再应用到内存状态
        const outcome = await options.repository.importOps(ops);
        imported += outcome.appended;
      });
      const { engine, roster, baseCursor, waiting, joinBlocked } = prepared;
      if (waiting) {
        return {
          uploaded: 0,
          downloaded: 0,
          appliedOps: 0,
          enqueued: 0,
          requests: 0,
          warnings: ['已提交加入请求：需要一台已授权设备同步一轮来把数据钥匙包给你。'],
            waiting: true,
        };
      }

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
      const state = engine.exportState();
      await store.save({ state, enqueuedSeq: stats.lastSeq });

      // 对端清单里带着它们的公钥：收进名单并落盘，供以后验签
      if (learnPublicKeys(roster, options.deviceId, state) > 0) await saveRoster(options.device, roster);

      const summary = summarize(result, enqueued, imported);
      if (joinBlocked === true) {
        summary.warnings.push(
          '这台设备的 WebView 不支持 X25519 协商密钥：无法加入共享目录、也无法替新设备发钥匙。请换一台支持该能力的设备。',
        );
      }
      return summary;
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
    /** 永久禁用：写黑名单 + 换代（只包给留下的人）。两步缺一不可：只拉黑挡不住读，只换代它又能输密码拿回钥匙。 */
    async ban(deviceId: string): Promise<boolean> {
      const { roster, restored } = await prepare();
      if (deviceId === options.deviceId) return false;
      if (!roster.ban(deviceId, now())) return false;
      await saveRoster(options.device, roster);

      if (!(await detectKeyWrapSupport())) return true; // 环境不支持 X25519：只拉黑，改不了钥匙
      const agreement = await loadOrCreateAgreementKeys(createWebCryptoKeyWrap(), options.device);
      const peers = restored?.peerAgreementKeys ?? {};
      const kept = roster.list().filter((record) => record.bannedAt === undefined && record.revokedAt === undefined);
      const recipients = [
        { deviceId: options.deviceId, publicKey: agreement.publicKey },
        ...kept
          .filter((record) => record.deviceId !== options.deviceId)
          .flatMap((record) => {
            const publicKey = peers[record.deviceId] ?? '';
            return publicKey === '' ? [] : [{ deviceId: record.deviceId, publicKey }];
          }),
      ];
      try {
        await rotateKeyring({ backend: options.backend, keyWrap: createWebCryptoKeyWrap(), recipients });
      } catch (cause) {
        // 黑名单已经生效（上面已落盘），但**换代失败**——必须让用户看见，
        // 否则他会以为"已经踢干净了"，而对方其实还能用旧钥匙读新内容。
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`已写入黑名单，但换代失败：${reason}。它暂时还能读到新内容；下次同步会自动重试换代。`);
      }
      return true;
    },

    async createRecovery(): Promise<{ publicKey: string; privateKey: string }> {
      return publishRecoveryKey(options.backend, now());
    },
    async collect(dryRun = true) {
      const { engine } = await prepare();
      return engine.collect(dryRun);
    },
  };
}
