import { WireClient, type WireTransport } from '../../../../../packages/wire/src/index.ts';

/**
 * 让 `fetch` 走**宿主**（Rust）而不是 WebView。
 *
 * 为什么：WebView 里对 NAS 发跨源请求会被 CORS 拦（NAS / Nextcloud 普遍不发 CORS 头），
 * 实测表现是 "Failed to fetch"。宿主发请求没有这个限制，顺带还能用系统代理与证书。
 *
 * 只实现 WebDAV 后端真正用到的部分：`status` / `ok` / `text()` / `arrayBuffer()`。
 * 这不是通用 fetch 替代品——够用、且明确，比"假装完整"要诚实。
 */

interface WireHttpResponse {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toBytes(body: unknown): Uint8Array | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return undefined;
}

export function createHostFetch(transport: WireTransport): typeof fetch {
  const client = new WireClient(transport);
  const call = (url: string, init: RequestInit = {}): Promise<Response> => {
    const body = toBytes(init.body);
    const payload = {
      method: (init.method ?? 'GET').toUpperCase(),
      url,
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      ...(body === undefined ? {} : { bodyBase64: encodeBase64(body) }),
    };

    return client
      .call<WireHttpResponse>('http', 'request', payload)
      .then((result) => {
        const bytes = decodeBase64(result.bodyBase64);
        const response = {
          ok: result.status >= 200 && result.status < 300,
          status: result.status,
          statusText: String(result.status),
          headers: {
            get: (name: string) => result.headers[name.toLowerCase()] ?? null,
          },
          async arrayBuffer() {
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
          },
          async text() {
            return new TextDecoder().decode(bytes);
          },
        };
        // 后端只读这几个字段；这里如实说明是"够用的响应对象"
        return response as unknown as Response;
      });
  };

  return call as unknown as typeof fetch;
}
