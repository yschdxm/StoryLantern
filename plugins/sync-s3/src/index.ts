import type {
  BackendCapabilities,
  ListOptions,
  ListResult,
  PutResult,
  SyncBackend,
} from '../../../packages/sync-core/src/backend.ts';

/**
 * S3 兼容对象存储后端（MinIO / R2 / B2 / AWS S3 都可）。
 *
 * 为什么单独做一个：S3 是这几类后端里**语义最稳**的（强一致、条件写完善、有分页），
 * 而 WebDAV 各家实现差异很大（条件写/范围读/分页支持不一）。同步协议只要求四个动作
 * （列目录、下载、上传、删除），S3 恰好四个都干净。
 *
 * 零第三方依赖：SigV4 用 WebCrypto 的 SHA-256 + HMAC-SHA256 自己算（与浏览器/Node 同一套 API）。
 * 签名实现对着**官方测试向量**验过（见 `test/s3-signing.test.ts`），不是"自己算自己验"。
 *
 * 路径风格：默认**路径式**（`endpoint/bucket/key`）—— MinIO/R2 都需要它；AWS 两种都支持，
 * 想用虚拟主机式（`bucket.endpoint/key`）就传 `forcePathStyle: false`。
 */

export interface S3Options {
  /** 服务端点，例如 `https://s3.us-east-1.amazonaws.com` 或 `http://127.0.0.1:9000`。 */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** 临时凭证的会话令牌（STS）。 */
  sessionToken?: string;
  /** 默认 true（路径式）。AWS 上想用虚拟主机式就设 false。 */
  forcePathStyle?: boolean;
  /** 注入 fetch 便于测试；默认用全局 fetch。 */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** 能力覆盖：自动探测失败或服务端行为异常时用。 */
  capabilities?: Partial<BackendCapabilities>;
}

export interface S3Backend extends SyncBackend {
  readonly bucket: string;
  readonly endpoint: string;
  /** 用真实请求探测条件写/范围读/delete。 */
  probe(): Promise<BackendCapabilities>;
}

const DEFAULT_CAPABILITIES: BackendCapabilities = {
  conditionalPut: true,
  rangeRead: true,
  delete: true,
  listPagination: true,
  watch: false,
};

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bufferOf(bytes));
  return toHex(new Uint8Array(digest));
}

async function hmacSha256(key: Uint8Array | CryptoKey, data: string): Promise<Uint8Array> {
  const cryptoKey =
    key instanceof Uint8Array
      ? await crypto.subtle.importKey('raw', bufferOf(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      : key;
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
  return new Uint8Array(signature);
}

/** SigV4 的密钥派生链：日期 → 区域 → 服务 → 签名密钥。 */
async function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<CryptoKey> {
  const kDate = await hmacSha256(new TextEncoder().encode(`AWS4${secretAccessKey}`), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, 'aws4_request');
  return crypto.subtle.importKey('raw', bufferOf(kSigning), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/** SigV4 的 URI 编码：保留 `/`，其余按 RFC3986 编码（S3 的 canonical URI 不再二次编码）。 */
export function encodeS3Path(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

export interface SignInput {
  method: string;
  /** 已经过 `encodeS3Path` 的路径（含 bucket，如 `/bucket/key`）。 */
  canonicalUri: string;
  /** 查询串，键值按字典序、值已编码，形如 `list-type=2&prefix=a%2Fb`。 */
  canonicalQuery: string;
  /** 参与签名的头（键必须小写，值已 trim）。 */
  headers: Record<string, string>;
  /** 请求体哈希（空体用 EMPTY_SHA256）。 */
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** `YYYYMMDDTHHMMSSZ`。 */
  amzDate: string;
  sessionToken?: string;
  /** 签名服务名，默认 `s3`（官方测试向量用的是 `service`，为了能直接验它所以留成参数）。 */
  service?: string;
}

/**
 * 算 SigV4 的 Authorization 头。
 *
 * 拆成纯函数是为了能被**官方测试向量**直接验（见 test/s3-signing.test.ts）：
 * 那一组用例给定 method/URI/日期/密钥，期望得到固定的签名。
 */
export async function signS3Request(input: SignInput): Promise<string> {
  const service = input.service ?? 's3';
  const dateStamp = input.amzDate.slice(0, 8);
  const canonicalHeaders = Object.entries(input.headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const signedHeaders = canonicalHeaders.map(([name]) => name).join(';');
  const headerBlock = canonicalHeaders.map(([name, value]) => `${name}:${value}\n`).join('');

  const canonicalRequest = [
    input.method.toUpperCase(),
    input.canonicalUri,
    input.canonicalQuery,
    headerBlock,
    signedHeaders,
    input.payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    input.amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = await deriveSigningKey(input.secretAccessKey, dateStamp, input.region, service);
  const signature = toHex(await hmacSha256(signingKey, stringToSign));

  return (
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`
  );
}

/** 极简 XML 取值：S3 的响应形状很固定，只取需要的标签。 */
function tag(body: string, name: string): string | undefined {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1];
}

function decodeMaybe(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseListObjectsV2(xml: string): { entries: Array<{ key: string; size: number; mtime?: number; etag?: string }>; truncated: boolean; cursor?: string } {
  const entries: Array<{ key: string; size: number; mtime?: number; etag?: string }> = [];
  for (const block of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const body = block[1] ?? '';
    const key = decodeMaybe(tag(body, 'Key'));
    if (key === undefined || key === '') continue;
    const lastModified = tag(body, 'LastModified');
    const parsedTime = lastModified === undefined ? Number.NaN : Date.parse(lastModified);
    const etag = tag(body, 'ETag');
    entries.push({
      key,
      size: Number(tag(body, 'Size') ?? '0'),
      ...(Number.isNaN(parsedTime) ? {} : { mtime: parsedTime }),
      ...(etag === undefined ? {} : { etag: etag.replace(/^"|"$/g, '') }),
    });
  }
  return {
    entries,
    truncated: (tag(xml, 'IsTruncated') ?? 'false').trim() === 'true',
    ...(decodeMaybe(tag(xml, 'NextContinuationToken')) === undefined
      ? {}
      : { cursor: decodeMaybe(tag(xml, 'NextContinuationToken')) as string }),
  };
}

export function createS3Backend(options: S3Options): S3Backend {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('S3 后端需要 fetch（Node 18+ / 浏览器 / WebView 均自带）');

  const capabilities: BackendCapabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pathStyle = options.forcePathStyle ?? true;
  const endpoint = options.endpoint.replace(/\/+$/, '');

  /** 端点里的 host（签名要用 host 头，虚拟主机式要把桶塞进 host）。 */
  const endpointUrl = new URL(endpoint);
  const host = pathStyle ? endpointUrl.host : `${options.bucket}.${endpointUrl.host}`;
  const rootPath = endpointUrl.pathname.replace(/\/+$/, '');

  /** 把对象键变成规范路径（含 bucket 前缀，取决于路径风格）。 */
  function canonicalPath(key: string): string {
    const encodedKey = encodeS3Path(key);
    return pathStyle ? `${rootPath}/${options.bucket}/${encodedKey}` : `${rootPath}/${encodedKey}`;
  }

  function requestUrl(key: string, query: string): string {
    const base = `${endpointUrl.protocol}//${host}${canonicalPath(key)}`;
    return query === '' ? base : `${base}?${query}`;
  }

  function encodeQuery(pairs: Array<[string, string]>): string {
    return pairs
      .map(([name, value]) => [name, value] as const)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
      .join('&');
  }

  async function request(
    method: string,
    key: string,
    init: { headers?: Record<string, string>; body?: Uint8Array; query?: Array<[string, string]> } = {},
  ): Promise<Response> {
    const query = encodeQuery(init.query ?? []);
    const payloadHash = init.body === undefined ? EMPTY_SHA256 : await sha256Hex(init.body);
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...(options.sessionToken === undefined ? {} : { 'x-amz-security-token': options.sessionToken }),
      ...(init.headers ?? {}),
    };

    const authorization = await signS3Request({
      method,
      canonicalUri: canonicalPath(key),
      canonicalQuery: query,
      headers,
      payloadHash,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      region: options.region,
      amzDate,
      ...(options.sessionToken === undefined ? {} : { sessionToken: options.sessionToken }),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(requestUrl(key, query), {
        method,
        headers: { ...headers, authorization },
        ...(init.body === undefined ? {} : { body: init.body as unknown as BodyInit }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  const backend: S3Backend = {
    id: `s3:${endpoint}/${options.bucket}`,
    bucket: options.bucket,
    endpoint,
    capabilities,

    async list(prefix: string, listOptions?: ListOptions): Promise<ListResult> {
      const result = await request('GET', '', {
        query: [
          ['list-type', '2'],
          ['prefix', prefix],
          ['max-keys', String(listOptions?.limit ?? 1000)],
          ['encoding-type', 'url'],
          ...(listOptions?.cursor === undefined ? [] : ([['continuation-token', listOptions.cursor]] as Array<[string, string]>)),
        ],
      });
      if (!result.ok) throw new Error(`S3 列目录 ${prefix} 失败：HTTP ${result.status}`);
      const parsed = parseListObjectsV2(await result.text());
      return {
        entries: parsed.entries.map((entry) => ({
          path: entry.key,
          size: entry.size,
          ...(entry.mtime === undefined ? {} : { mtime: entry.mtime }),
          ...(entry.etag === undefined ? {} : { etag: entry.etag }),
        })),
        ...(parsed.truncated && parsed.cursor !== undefined ? { cursor: parsed.cursor } : {}),
      };
    },

    async get(path: string): Promise<Uint8Array> {
      const response = await request('GET', path);
      if (!response.ok) throw new Error(`S3 GET ${path} 失败：HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },

    async put(path: string, bytes: Uint8Array, putOptions?: { ifNoneMatch?: boolean }): Promise<PutResult> {
      const response = await request('PUT', path, {
        body: bytes,
        headers: {
          'content-type': 'application/octet-stream',
          ...(putOptions?.ifNoneMatch === true ? { 'if-none-match': '*' } : {}),
        },
      });
      // 412（PreconditionFailed）就是"已经有了"——内容寻址下等价于"这次写入多余"，不是错误。
      if (response.status === 412) return { ok: false, exists: true };
      if (response.ok) return { ok: true };
      return { ok: false };
    },

    async delete(path: string): Promise<void> {
      const response = await request('DELETE', path);
      // S3 的 DELETE 幂等：删不存在的对象也返回 204。
      if (!response.ok && response.status !== 404) throw new Error(`S3 DELETE ${path} 失败：HTTP ${response.status}`);
    },

    async probe(): Promise<BackendCapabilities> {
      const probePath = `.storylantern-probe-${Math.random().toString(36).slice(2, 10)}.txt`;
      const payload = new Uint8Array([1, 2, 3]);

      const first = await backend.put(probePath, payload, { ifNoneMatch: true });
      capabilities.conditionalPut = false;
      if (first.ok) {
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

/** 作为插件注册：`ctx.set('sync.backend.s3', ...)`（与 WebDAV 插件同一个入口名，内核按 `apply` 调用）。 */
export function apply(ctx: { set(key: string, value: unknown): unknown }): void {
  ctx.set('sync.backend.s3', { kind: 's3', create: createS3Backend });
}
