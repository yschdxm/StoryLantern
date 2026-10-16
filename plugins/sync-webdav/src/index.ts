import type {
  BackendCapabilities,
  BackendEntry,
  ListResult,
  PutResult,
  SyncBackend,
} from '../../../packages/sync-core/src/backend.ts';

/**
 * WebDAV 后端。
 *
 * 为什么优先 WebDAV 而不是 SMB/FTP：NAS（群晖/威联通）、Nextcloud、坚果云都自带 WebDAV，
 * 而且**移动端只需要填 URL**——SMB 在手机上没法直接挂载，FTP 又没有条件写与范围读。
 *
 * 只依赖全局 `fetch`（Node 18+/浏览器/WebView 都有），因此不需要任何第三方 HTTP 库。
 */

export interface WebDavOptions {
  /** 远端根地址，例如 `https://nas.local:5006/storylantern/`。 */
  baseUrl: string;
  username?: string;
  password?: string;
  /** 也可用 Bearer token（部分服务端提供）。 */
  token?: string;
  /** 注入 fetch 便于测试；默认用全局 fetch。 */
  fetch?: typeof fetch;
  /** 能力覆盖：自动探测失败或服务端行为异常时用。 */
  capabilities?: Partial<BackendCapabilities>;
  /** 单次请求超时（毫秒）。 */
  timeoutMs?: number;
}

const DEFAULT_CAPABILITIES: BackendCapabilities = {
  conditionalPut: true,
  rangeRead: true,
  delete: true,
  listPagination: false,
  watch: false,
};

/** 逐段编码路径，保留 `/`，避免把中文或空格目录名写坏。 */
export function encodeDavPath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/**
 * 把 HTTP 状态变成**可行动**的话 —— 这些依据来自官方文档（见 docs/WEBDAV-PROVIDERS.md）：
 *  - `429`：免费网盘普遍有请求频率上限（坚果云官方：免费版每 30 分钟 ≤600 次、付费 ≤1500 次），
 *    所以要告诉用户"稍后再试"，而不是丢一个光秃秃的状态码；
 *  - `507`：远端配额不足（Nextcloud 在 `OC-Total-Length` 不足时会更快中止）；
 *  - `401/403`：Nextcloud 开了 OIDC/2FA 时**必须用应用密码**（官方文档明确要求）。
 */
export function describeHttp(status: number, what: string): string {
  if (status === 429) return `${what} 被远端限流（HTTP 429）：免费网盘通常有每半小时的请求数上限，稍后再试即可`;
  if (status === 507) return `${what} 失败：远端配额不足（HTTP 507），先清理远端空间`;
  if (status === 401 || status === 403) {
    return `${what} 被拒绝（HTTP ${status}）：检查账号密码；Nextcloud 这类开了双重验证/OIDC 的服务要用**应用密码**`;
  }
  return `${what} 失败：HTTP ${status}`;
}

export function decodeDavPath(path: string): string {
  return path
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
}

function joinUrl(base: string, path: string): string {
  const trimmed = base.endsWith('/') ? base : `${base}/`;
  return `${trimmed}${encodeDavPath(path)}`;
}

/** 从 PROPFIND 的 multistatus 里抽出条目。命名空间前缀尽量宽容。 */
export function parseMultistatus(xml: string, basePath: string): BackendEntry[] {
  const entries: BackendEntry[] = [];
  const responseRe = /<(?:\w+:)?response\b[\s\S]*?<\/(?:\w+:)?response>/g;

  for (const block of xml.match(responseRe) ?? []) {
    const href = /<(?:\w+:)?href[^>]*>([\s\S]*?)<\/(?:\w+:)?href>/.exec(block)?.[1];
    if (href === undefined) continue;

    const decoded = decodeDavPath(href.trim());
    const index = decoded.indexOf(basePath);
    if (index < 0) continue;
    const relative = decoded.slice(index + basePath.length).replace(/^\/+/, '');
    if (relative === '') continue;

    const isCollection = /<(?:\w+:)?collection\s*\/>/.test(block) || /<(?:\w+:)?collection\b/.test(block);
    const sizeText = /<(?:\w+:)?getcontentlength[^>]*>(\d+)<\/(?:\w+:)?getcontentlength>/.exec(block)?.[1];
    const etag = /<(?:\w+:)?getetag[^>]*>([\s\S]*?)<\/(?:\w+:)?getetag>/.exec(block)?.[1];
    const modified = /<(?:\w+:)?getlastmodified[^>]*>([\s\S]*?)<\/(?:\w+:)?getlastmodified>/.exec(block)?.[1];

    const entry: BackendEntry = { path: relative, size: sizeText === undefined ? 0 : Number.parseInt(sizeText, 10) };
    if (etag !== undefined) entry.etag = etag.replace(/"/g, '');
    if (modified !== undefined) {
      const parsed = Date.parse(modified);
      if (!Number.isNaN(parsed)) entry.mtime = parsed;
    }
    // 目录条目也返回，调用方按 size/后缀自行过滤；但协议只关心文件，这里直接跳过集合。
    if (isCollection) continue;
    entries.push(entry);
  }

  return entries;
}

export interface WebDavBackend extends SyncBackend {
  readonly baseUrl: string;
  /** 用真实请求探测服务端能力（条件写、delete、范围读）。 */
  probe(): Promise<BackendCapabilities>;
}

export function createWebDavBackend(options: WebDavOptions): WebDavBackend {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('WebDAV 后端需要 fetch（Node 18+ / 浏览器 / WebView 均自带）');

  const base = options.baseUrl;
  const basePath = new URL(base).pathname.replace(/\/+$/, '');
  const capabilities: BackendCapabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
  const timeoutMs = options.timeoutMs ?? 30_000;

  const headers = (extra: Record<string, string> = {}): Record<string, string> => {
    const out: Record<string, string> = { ...extra };
    if (options.token) out.authorization = `Bearer ${options.token}`;
    else if (options.username !== undefined) {
      out.authorization = `Basic ${base64(`${options.username}:${options.password ?? ''}`)}`;
    }
    return out;
  };

  const request = async (method: string, path: string, init: RequestInit = {}): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(joinUrl(base, path), {
        method,
        ...init,
        headers: headers((init.headers as Record<string, string>) ?? {}),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * 逐级建父集合（RFC 4918 要求；普通服务端不会自动建）。
   * `405` 表示该集合已经存在（MKCOL 的标准回应），`301/302` 是某些服务端的重定向习惯，都当成功。
   */
  const ensureParents = async (path: string): Promise<void> => {
    const segments = path.split('/').slice(0, -1);
    let accumulated = '';
    for (const segment of segments) {
      accumulated = accumulated === '' ? segment : `${accumulated}/${segment}`;
      const response = await request('MKCOL', accumulated);
      if (response.status === 401 || response.status === 403 || response.status === 429) {
        throw new Error(describeHttp(response.status, `MKCOL ${accumulated}`));
      }
    }
  };

  const backend: WebDavBackend = {
    id: `webdav:${base}`,
    baseUrl: base,
    capabilities,

    async list(prefix: string): Promise<ListResult> {
      const body = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<d:propfind xmlns:d="DAV:"><d:prop>',
        '<d:getcontentlength/><d:getlastmodified/><d:getetag/><d:resourcetype/>',
        '</d:prop></d:propfind>',
      ].join('');

      // 去掉尾部斜杠：否则拼出来会是 `.../devices//`，不同服务端行为不一致（有的直接 404）。
      const normalized = prefix.replace(/\/+$/, '');

      const response = await request('PROPFIND', normalized, {
        headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
        body,
      });

      // 404 表示这个前缀还不存在（例如首次同步）：当作空目录处理，而不是错误。
      if (response.status === 404) return { entries: [] };
      if (!response.ok && response.status !== 207) {
        throw new Error(describeHttp(response.status, `PROPFIND ${prefix}`));
      }
      return { entries: parseMultistatus(await response.text(), basePath) };
    },

    async get(path: string): Promise<Uint8Array> {
      const response = await request('GET', path);
      if (!response.ok) throw new Error(describeHttp(response.status, `GET ${path}`));
      return new Uint8Array(await response.arrayBuffer());
    },

    async put(path: string, bytes: Uint8Array, putOptions?: { ifNoneMatch?: boolean }): Promise<PutResult> {
      const extra: Record<string, string> = { 'content-type': 'application/octet-stream' };
      if (putOptions?.ifNoneMatch === true) extra['if-none-match'] = '*';

      const send = (): Promise<Response> => request('PUT', path, { headers: extra, body: bytes as unknown as BodyInit });
      let response = await send();

      // 409 = 父集合不存在。**普通 WebDAV 不会替你建父目录**：Nextcloud 直到 32 才有
      // `X-NC-WebDAV-Auto-Mkcol`，而 RFC 4918 本来就要求逐级 MKCOL。
      // （我们在实测的 nginx 上没暴露这个问题，只因为它开了 `create_full_put_path`——
      //  这正说明"只在一个服务端上验过"不等于"对得上协议"。）
      if (response.status === 409) {
        await ensureParents(path);
        response = await send();
        if (response.status === 409) {
          throw new Error(`PUT ${path} 失败：父目录建不起来（HTTP 409）`);
        }
      }

      if (response.status === 412) return { ok: false, exists: true };
      if (response.status === 204 || response.status === 201 || response.ok) return { ok: true };
      if (response.status >= 500 || response.status === 429) throw new Error(describeHttp(response.status, `PUT ${path}`));
      return { ok: false };
    },

    async delete(path: string): Promise<void> {
      const response = await request('DELETE', path);
      if (!response.ok && response.status !== 404) throw new Error(`DELETE ${path} 失败：HTTP ${response.status}`);
    },

    async probe(): Promise<BackendCapabilities> {
      const probePath = `.storylantern-probe-${Math.random().toString(36).slice(2, 10)}.txt`;
      const payload = new Uint8Array([1, 2, 3]);

      const first = await backend.put(probePath, payload, { ifNoneMatch: true });
      capabilities.conditionalPut = false;
      if (first.ok) {
        // 同一个路径再写一次：若服务端有条件写，应当返回 412（exists）
        const second = await backend.put(probePath, payload, { ifNoneMatch: true });
        capabilities.conditionalPut = second.exists === true;
      }

      const range = await request('GET', probePath, { headers: { range: 'bytes=0-0' } });
      capabilities.rangeRead = range.status === 206;

      const removed = await request('DELETE', probePath);
      capabilities.delete = removed.ok || removed.status === 404;

      return { ...capabilities };
    },
  };

  return backend;
}

/** 自带 base64（Node 与浏览器行为一致，不依赖 Buffer/btoa）。 */
function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] as number;
    const b = index + 1 < bytes.length ? (bytes[index + 1] as number) : undefined;
    const c = index + 2 < bytes.length ? (bytes[index + 2] as number) : undefined;
    out += alphabet[a >> 2];
    out += alphabet[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : alphabet[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : alphabet[c & 0x3f];
  }
  return out;
}

/** 作为插件注册：`ctx.set('sync.backend.webdav', ...)`。 */
export function apply(ctx: { set(key: string, value: unknown): unknown }): void {
  ctx.set('sync.backend.webdav', { kind: 'webdav', create: createWebDavBackend });
}
