import type {
  BackendCapabilities,
  BackendEntry,
  ListOptions,
  ListResult,
  PutResult,
  SyncBackend,
} from '../../../packages/sync-core/src/backend.ts';

/** 可注入的故障：用来复现 §8.10 的每一种事故场景。 */
export interface MemoryBackendFaults {
  /** 模拟断网：所有访问抛错。 */
  offline: boolean;
  /** 模拟"上传到一半断电"：只写入前 N%。 */
  truncateUploadsAtPercent: number | null;
  /** 模拟存储方篡改：上传时翻转一个字节。 */
  corruptUploads: boolean;
  /** 模拟远端被误删/被 GC：读这些路径时抛 404。 */
  missingPaths: Set<string>;
}

export interface MemoryBackendOptions {
  capabilities?: Partial<BackendCapabilities>;
  faults?: Partial<MemoryBackendFaults>;
}

export interface MemoryBackend extends SyncBackend {
  readonly files: Map<string, Uint8Array>;
  readonly faults: MemoryBackendFaults;
  /** 直接写入（模拟"别的设备/网盘客户端"动过文件）。 */
  seed(path: string, bytes: Uint8Array): void;
  remove(path: string): boolean;
  snapshot(): Map<string, Uint8Array>;
  restore(snapshot: Map<string, Uint8Array>): void;
}

const DEFAULT_CAPABILITIES: BackendCapabilities = {
  conditionalPut: true,
  rangeRead: false,
  delete: true,
  listPagination: false,
  watch: false,
};

/**
 * 内存后端。
 *
 * 语义刻意对齐最弱的哑存储：只有 list / get / put / delete，没有锁、没有事务；
 * `conditionalPut` 可开关，用来验证"即使没有条件写也不会冲突"。
 */
export function createMemoryBackend(options: MemoryBackendOptions = {}): MemoryBackend {
  const files = new Map<string, Uint8Array>();
  const capabilities: BackendCapabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
  const faults: MemoryBackendFaults = {
    offline: false,
    truncateUploadsAtPercent: null,
    corruptUploads: false,
    missingPaths: new Set<string>(),
    ...options.faults,
  };

  const guard = (): void => {
    if (faults.offline) throw new Error('网络不可用（模拟离线）');
  };

  const clone = (bytes: Uint8Array): Uint8Array => Uint8Array.from(bytes);

  return {
    id: 'memory',
    capabilities,
    files,
    faults,

    async list(prefix: string, listOptions?: ListOptions): Promise<ListResult> {
      guard();
      const entries: BackendEntry[] = [];
      for (const [path, bytes] of files) {
        if (!path.startsWith(prefix)) continue;
        entries.push({ path, size: bytes.length });
      }
      entries.sort((a, b) => a.path.localeCompare(b.path));
      const limit = listOptions?.limit ?? entries.length;
      const cursor = listOptions?.cursor === undefined ? 0 : Number.parseInt(listOptions.cursor, 10);
      const page = entries.slice(cursor, cursor + limit);
      const nextCursor = cursor + limit < entries.length ? String(cursor + limit) : undefined;
      return { entries: page, ...(nextCursor === undefined ? {} : { cursor: nextCursor }) };
    },

    async get(path: string): Promise<Uint8Array> {
      guard();
      if (faults.missingPaths.has(path)) throw new Error(`404 ${path}`);
      const bytes = files.get(path);
      if (!bytes) throw new Error(`404 ${path}`);
      return clone(bytes);
    },

    async put(path: string, bytes: Uint8Array, putOptions?: { ifNoneMatch?: boolean }): Promise<PutResult> {
      guard();
      if (putOptions?.ifNoneMatch === true && capabilities.conditionalPut && files.has(path)) {
        return { ok: false, exists: true };
      }

      let payload = clone(bytes);
      if (faults.truncateUploadsAtPercent !== null) {
        const keep = Math.max(1, Math.floor((payload.length * faults.truncateUploadsAtPercent) / 100));
        payload = payload.subarray(0, keep);
      }
      if (faults.corruptUploads && payload.length > 20) {
        payload = clone(payload);
        payload[10] = (payload[10] as number) ^ 0xff;
      }

      files.set(path, payload);
      return { ok: true };
    },

    async delete(path: string): Promise<void> {
      guard();
      files.delete(path);
    },

    seed(path, bytes) {
      files.set(path, clone(bytes));
    },

    remove(path) {
      return files.delete(path);
    },

    snapshot() {
      const copy = new Map<string, Uint8Array>();
      for (const [path, bytes] of files) copy.set(path, clone(bytes));
      return copy;
    },

    restore(snapshot) {
      files.clear();
      for (const [path, bytes] of snapshot) files.set(path, clone(bytes));
    },
  };
}

/** 作为插件注册：`ctx.set('sync.backend.memory', ...)`。 */
export function apply(ctx: { set(key: string, value: unknown): unknown }): void {
  ctx.set('sync.backend.memory', { kind: 'memory', create: createMemoryBackend });
}
