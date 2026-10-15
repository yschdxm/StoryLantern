import { createLocalOpPorts } from '../src/data/op-ports.ts';
import { createOpLogRepository, type OpLogRepository } from '../src/data/op-repository.ts';
import { createMemoryKeyValue } from '../src/data/local-repository.ts';
import { createSyncService, type SyncService, type SyncStorePort } from '../src/data/sync/service.ts';
import type { SyncBackend, BackendEntry, ListResult, PutResult } from '../../../packages/sync-core/src/backend.ts';
import type { LocalSyncState } from '../../../packages/sync-core/src/state.ts';

/**
 * 两台"设备"通过一个哑存储同步的测试骨架（`sync.test.ts` 与 GC 复现测试共用）。
 *
 * 用的是**真实链路**：op 仓储（日志即事实源）+ 同步引擎 + WebCrypto 加密端口，
 * 只把"远端存储"换成内存实现——所以它验证的是产品代码，不是模型。
 * 抽出来是为了让两个测试看到**同一套**行为，也避免复制一份会漂移的骨架。
 */

/** 内存哑存储：只有列目录/读/写/删，没有锁、没有事务——和网盘目录一个样。 */
export function createMemoryBackend(): SyncBackend {
  const files = new Map<string, Uint8Array>();

  return {
    id: 'memory',
    capabilities: { conditionalPut: true, rangeRead: true, delete: true, listPagination: false, watch: false },
    async list(prefix: string): Promise<ListResult> {
      const entries: BackendEntry[] = [];
      for (const [path, bytes] of files) {
        if (path.startsWith(prefix)) entries.push({ path, size: bytes.length });
      }
      entries.sort((a, b) => a.path.localeCompare(b.path));
      return { entries };
    },
    async get(path: string): Promise<Uint8Array> {
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`404 ${path}`);
      return bytes;
    },
    async put(path: string, bytes: Uint8Array, options?: { ifNoneMatch?: boolean }): Promise<PutResult> {
      if (options?.ifNoneMatch === true && files.has(path)) return { ok: true, exists: true };
      files.set(path, bytes);
      return { ok: true };
    },
    async delete(path: string): Promise<void> {
      files.delete(path);
    },
  };
}

export function createMemorySyncStore(): SyncStorePort {
  let saved: { state?: LocalSyncState; enqueuedSeq: number } = { enqueuedSeq: 0 };
  return {
    async load() {
      return saved;
    },
    async save(input) {
      saved = input;
    },
  };
}

export interface Device {
  name: string;
  repository: OpLogRepository;
  store: SyncStorePort;
  /** 需要看"对端公钥有没有收到"时用它。 */
  service: SyncService;
  sync: () => Promise<{ uploaded: number; downloaded: number; appliedOps: number; warnings: string[] }>;
}

/**
 * 同一后端（= 同一个共享目录）里的设备登记表。
 *
 * 为什么要它：按设计，**新设备加入需要一台已授权设备接纳一轮**
 * （它先写 join 请求，对方验过密码证明后把数据钥匙包给它）。
 * 测试里让 `sync()` 自动补这一轮：发现自己在等待接纳时，先让同目录的其它设备同步一次。
 */
const JOIN_PEERS = new WeakMap<SyncBackend, Device[]>();

/** 这台设备本地同步状态里的 ack/peerAck（GC 判定就看它）。 */
export async function loadSyncState(device: Device): Promise<{ ack: Record<string, number>; peerAck: Record<string, Record<string, number>> }> {
  const saved = await device.store.load();
  const state = saved.state;
  return { ack: state?.ack ?? {}, peerAck: state?.peerAck ?? {} };
}

export async function createDevice(
  name: string,
  backend: SyncBackend,
  secret: string,
  options?: { graceMs?: number },
): Promise<Device> {
  const ports = createLocalOpPorts(createMemoryKeyValue());
  const repository = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: name });
  await repository.ready;
  const store = createMemorySyncStore();
  const service = await createSyncService({
    repository,
    backend,
    deviceId: name,
    secret,
    store,
    device: ports.device,
    ...(options?.graceMs === undefined ? {} : { graceMs: options.graceMs }),
  });
  const device: Device = {
    name,
    repository,
    store,
    service,
    sync: async () => {
      let summary = await service.sync();
      if (summary.warnings.some((warning) => warning.includes('加入请求'))) {
        for (const peer of JOIN_PEERS.get(backend) ?? []) {
          if (peer.name !== name) await peer.sync();
        }
        summary = await service.sync();
      }
      return {
        uploaded: summary.uploaded,
        downloaded: summary.downloaded,
        appliedOps: summary.appliedOps,
        warnings: summary.warnings,
      };
    },
  };
  const peers = JOIN_PEERS.get(backend) ?? [];
  peers.push(device);
  JOIN_PEERS.set(backend, peers);
  return device;
}
