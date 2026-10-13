/**
 * 同步后端抽象。
 *
 * 目标后端（网盘同步目录 / WebDAV / S3 / SMB / FTP）只有四个动作：
 * 列目录、下载、上传、删除——没有锁、没有事务，很多连"条件写"都没有。
 * 因此协议层必须做到：**共享文件只写一次、每台设备只写自己命名空间**，
 * 于是并发冲突在传输层被构造性消灭，不需要任何服务端智能。
 */

export interface BackendEntry {
  path: string;
  size: number;
  mtime?: number;
  etag?: string;
}

export interface BackendCapabilities {
  /** 支持 `If-None-Match` 之类的条件写（S3/WebDAV 通常有，FTP/SMB 没有）。 */
  conditionalPut: boolean;
  rangeRead: boolean;
  delete: boolean;
  listPagination: boolean;
  /** 是否有推送通道（只有自建中继/S3 通知才有）。 */
  watch: boolean;
}

export interface ListOptions {
  cursor?: string;
  limit?: number;
}

export interface ListResult {
  entries: BackendEntry[];
  cursor?: string;
}

export interface PutResult {
  ok: boolean;
  /** 目标已存在（配合内容寻址的文件名，等价于"这次写入是多余的"）。 */
  exists?: boolean;
}

export interface SyncBackend {
  readonly id: string;
  readonly capabilities: BackendCapabilities;
  list(prefix: string, options?: ListOptions): Promise<ListResult>;
  get(path: string): Promise<Uint8Array>;
  put(path: string, bytes: Uint8Array, options?: { ifNoneMatch?: boolean }): Promise<PutResult>;
  delete?(path: string): Promise<void>;
}

export interface BackendCallCounters {
  list: number;
  get: number;
  put: number;
  delete: number;
  bytesUploaded: number;
  bytesDownloaded: number;
  /** 每次 list 用到的前缀——用于断言"从不遍历整个目录树"。 */
  listPrefixes: string[];
  /** 全部访问过的路径，用于断言"精确 GET，不 list logs/**"。 */
  paths: string[];
}

export interface InstrumentedBackend {
  backend: SyncBackend;
  counters: BackendCallCounters;
  reset(): void;
}

/** 计数装饰器：同步的请求数/流量/目录遍历行为必须可被测试断言。 */
export function instrumentBackend(backend: SyncBackend): InstrumentedBackend {
  const counters: BackendCallCounters = {
    list: 0,
    get: 0,
    put: 0,
    delete: 0,
    bytesUploaded: 0,
    bytesDownloaded: 0,
    listPrefixes: [],
    paths: [],
  };

  const wrapped: SyncBackend = {
    id: backend.id,
    capabilities: backend.capabilities,
    async list(prefix, options) {
      counters.list += 1;
      counters.listPrefixes.push(prefix);
      const result = await backend.list(prefix, options);
      for (const entry of result.entries) counters.paths.push(entry.path);
      return result;
    },
    async get(path) {
      counters.get += 1;
      counters.paths.push(path);
      const bytes = await backend.get(path);
      counters.bytesDownloaded += bytes.length;
      return bytes;
    },
    async put(path, bytes, options) {
      counters.put += 1;
      counters.paths.push(path);
      counters.bytesUploaded += bytes.length;
      return backend.put(path, bytes, options);
    },
    ...(backend.delete
      ? {
          async delete(path: string) {
            counters.delete += 1;
            counters.paths.push(path);
            await backend.delete?.(path);
          },
        }
      : {}),
  };

  return {
    backend: wrapped,
    counters,
    reset() {
      counters.list = 0;
      counters.get = 0;
      counters.put = 0;
      counters.delete = 0;
      counters.bytesUploaded = 0;
      counters.bytesDownloaded = 0;
      counters.listPrefixes.length = 0;
      counters.paths.length = 0;
    },
  };
}
