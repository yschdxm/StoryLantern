import { ulid } from '../../../../packages/oplog/src/index.ts';

/**
 * 请求审计日志（B25）：把每次模型调用**真实发出去的请求**留在本机，供 Inspector 回看最近 N 次。
 *
 * 三条边界：
 *  - **只在本机**：body 含用户上下文，绝不写进同步内容（不落 `setting.set` op），用设备 kv 的
 *    `request.log.*` 键存；换设备不带过去；
 *  - **有界**：最多 20 条（FIFO），单份 body 截断到 64 KiB —— 审计不能把本机存储撑爆；
 *  - **可容错**：一条坏记录不毁掉整份日志（解析时跳过），但 body/url 等字段仍按结构校验。
 */

export interface RequestLogEntry {
  id: string;
  /** 写入时刻（毫秒）。 */
  at: number;
  sessionId: string;
  model: string;
  url: string;
  byteLength: number;
  /** 真实发出去的请求体（可能被截断，见 `bodyTruncated` 说明）。 */
  body: string;
  firstDeltaMs?: number;
  totalMs?: number;
  status: 'ok' | 'error';
}

export interface RequestLogPort {
  /** 最近 N 条，**新的在前**。 */
  list(): Promise<RequestLogEntry[]>;
  append(entry: RequestLogEntry): Promise<void>;
  clear(): Promise<void>;
}

/** 设备 kv 里的键：以 `request.log.` 开头，明确"本机、不同步"。 */
export const REQUEST_LOG_KEY = 'request.log.v1';
export const REQUEST_LOG_LIMIT = 20;
export const REQUEST_LOG_BODY_BYTES = 64 * 1024;
const TRUNCATED_MARK = '\n…[truncated]';

/** 截断标记本身也要算进上限：返回值的 UTF-8 字节数 ≤ maxBytes。 */
export function truncateBody(body: string, maxBytes: number = REQUEST_LOG_BODY_BYTES): string {
  if (maxBytes <= 0) return '';
  const encoder = new TextEncoder();
  const bytes = encoder.encode(body);
  if (bytes.length <= maxBytes) return body;
  const markerBytes = encoder.encode(TRUNCATED_MARK).length;
  const decoder = new TextDecoder();
  let budget = Math.max(0, maxBytes - markerBytes);
  let text = decoder.decode(bytes.subarray(0, budget));
  // 按字节切可能切在 UTF-8 多字节字符中间（解码成 U+FFFD，反而多占字节）；
  // 往前退到能装进上限的字符边界，保证结果真的 ≤ maxBytes。
  while (budget > 0 && encoder.encode(text).length + markerBytes > maxBytes) {
    budget -= 1;
    text = decoder.decode(bytes.subarray(0, budget));
  }
  return `${text}${TRUNCATED_MARK}`;
}

/** 追加并维持 FIFO（新的在前，超限丢最旧的）。纯函数，便于测。 */
export function appendRequestLogEntry(
  entries: readonly RequestLogEntry[],
  entry: RequestLogEntry,
  options: { limit?: number; maxBodyBytes?: number } = {},
): RequestLogEntry[] {
  const limit = options.limit ?? REQUEST_LOG_LIMIT;
  const maxBodyBytes = options.maxBodyBytes ?? REQUEST_LOG_BODY_BYTES;
  if (limit <= 0) return [];
  const normalized: RequestLogEntry = { ...entry, body: truncateBody(entry.body, maxBodyBytes) };
  return [normalized, ...entries].slice(0, limit);
}

/** 生成一条日志（id/时间由这里统一给，调用方只管内容）。 */
export function makeRequestLogEntry(input: {
  sessionId: string;
  model: string;
  url: string;
  byteLength: number;
  body: string;
  status: 'ok' | 'error';
  firstDeltaMs?: number;
  totalMs?: number;
  at?: number;
  id?: string;
}): RequestLogEntry {
  return {
    id: input.id ?? ulid(),
    at: input.at ?? Date.now(),
    sessionId: input.sessionId,
    model: input.model,
    url: input.url,
    byteLength: input.byteLength,
    body: input.body,
    status: input.status,
    ...(input.firstDeltaMs === undefined ? {} : { firstDeltaMs: input.firstDeltaMs }),
    ...(input.totalMs === undefined ? {} : { totalMs: input.totalMs }),
  };
}

function isEntry(value: unknown): value is RequestLogEntry {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['id'] === 'string' &&
    record['id'] !== '' &&
    typeof record['at'] === 'number' &&
    Number.isFinite(record['at']) &&
    typeof record['sessionId'] === 'string' &&
    typeof record['model'] === 'string' &&
    typeof record['url'] === 'string' &&
    typeof record['byteLength'] === 'number' &&
    typeof record['body'] === 'string' &&
    (record['status'] === 'ok' || record['status'] === 'error')
  );
}

/** 解析：坏 JSON / 坏条目都跳过（一条坏记录不该让 Inspector 整个打不开）。 */
export function parseRequestLog(raw: string | undefined): RequestLogEntry[] {
  if (raw === undefined || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isEntry).map((entry) => ({ ...entry, body: truncateBody(entry.body) }));
}

export function serializeRequestLog(entries: readonly RequestLogEntry[]): string {
  return JSON.stringify(entries);
}

/** 设备 kv 的最小形状（与 `DeviceStore` 兼容；不依赖具体实现）。 */
export interface RequestLogKeyValue {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

/**
 * 宿主/设备实现：用设备 kv 存（`request.log.v1`）。
 *
 * 为什么不用 settings：`setting.set` 是**同步内容**（会跟着 op 日志走）。
 * 请求体里是用户原文，只应留在本机。
 */
export function createDeviceRequestLog(device: RequestLogKeyValue): RequestLogPort {
  return {
    async list() {
      return parseRequestLog(await device.get(REQUEST_LOG_KEY));
    },
    async append(entry) {
      const entries = parseRequestLog(await device.get(REQUEST_LOG_KEY));
      await device.set(REQUEST_LOG_KEY, serializeRequestLog(appendRequestLogEntry(entries, entry)));
    },
    async clear() {
      await device.set(REQUEST_LOG_KEY, '');
    },
  };
}

/** 内存实现：测试与"宿主不可用"时仍能工作（不持久化，界面需如实提示）。 */
export function createMemoryRequestLog(initial: readonly RequestLogEntry[] = []): RequestLogPort {
  let entries = [...initial].slice(0, REQUEST_LOG_LIMIT);
  return {
    async list() {
      return entries.map((entry) => ({ ...entry }));
    },
    async append(entry) {
      entries = appendRequestLogEntry(entries, entry);
    },
    async clear() {
      entries = [];
    },
  };
}
