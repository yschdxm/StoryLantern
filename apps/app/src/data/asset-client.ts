/**
 * 本机资产库客户端（图片等二进制）。
 *
 * 两种环境：
 *  - **Tauri**：走宿主 `assets` 服务（内容寻址写入应用私有目录，持久、跨重启）；
 *  - **纯浏览器**：内存 Map（可用但不持久，刷新即失；界面必须如实说明）。
 *
 * 为什么不再往界面传一个 client：资产只被编辑器用，而 `main.tsx` 已经贴着 400 行门禁。
 * 这里用惰性单例，首次使用时自己探测宿主桥（与 main 的探测逻辑同一个来源）。
 *
 * 路径约定：卡片里只存 `asset://<sha256>`；真正的字节在本机库里，同步由同步层的资产索引负责。
 */

import { createTauriBridgeFromGlobal, createTauriTransport, WireClient } from '../../../../packages/wire/src/index.ts';

export type AssetClient = {
  readonly kind: 'host' | 'memory';
  /** 是否可用于读写（两种实现都可用；差别只在持久性）。 */
  readonly available: boolean;
  /** 刷新后是否还在（浏览器内存实现为 false，界面据此提示）。 */
  readonly persistent: boolean;
  put(bytes: Uint8Array): Promise<string>;
  get(hash: string): Promise<Uint8Array | undefined>;
  list(): Promise<string[]>;
  remove(hash: string): Promise<boolean>;
};

const ASSET_REF_PREFIX = 'asset://';

/** 把 sha256 变成一个资产引用。 */
export function assetRefOf(hash: string): string {
  return `${ASSET_REF_PREFIX}${hash}`;
}

/** 从资产引用里取 sha256；不是合法引用返回 undefined（绝对路径等一律不认）。 */
export function hashOfAssetRef(ref: string | undefined): string | undefined {
  if (ref === undefined || !ref.startsWith(ASSET_REF_PREFIX)) return undefined;
  const hash = ref.slice(ASSET_REF_PREFIX.length).toLowerCase();
  return /^[0-9a-f]{64}$/.test(hash) ? hash : undefined;
}

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (const byte of view) out += byte.toString(16).padStart(2, '0');
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return toHex(await crypto.subtle.digest('SHA-256', buffer));
}

/** 宿主实现：每次调用都是一次 wire RPC（图片不常改，量级可接受）。 */
function createHostClient(client: WireClient): AssetClient {
  return {
    kind: 'host',
    available: true,
    persistent: true,
    async put(bytes) {
      const result = await client.call<{ hash: string }>('assets', 'put', toBase64(bytes));
      return result.hash;
    },
    async get(hash) {
      try {
        const result = await client.call<{ data: string }>('assets', 'get', hash);
        return fromBase64(result.data);
      } catch {
        // 资产丢了（被删/拷贝不完整）不该让编辑器崩：按"没有图"处理，由界面提示
        return undefined;
      }
    },
    async list() {
      const result = await client.call<{ hashes: string[] }>('assets', 'list');
      return result.hashes;
    },
    async remove(hash) {
      const result = await client.call<{ removed: boolean }>('assets', 'delete', hash);
      return result.removed;
    },
  };
}

/** 浏览器实现：内存里存（不持久）。保留 sha256 校验语义，便于与宿主实现行为一致。 */
function createMemoryClient(): AssetClient {
  const store = new Map<string, Uint8Array>();
  return {
    kind: 'memory',
    available: true,
    persistent: false,
    async put(bytes) {
      const hash = await sha256Hex(bytes);
      if (!store.has(hash)) store.set(hash, bytes);
      return hash;
    },
    async get(hash) {
      return store.get(hash);
    },
    async list() {
      return [...store.keys()].sort();
    },
    async remove(hash) {
      return store.delete(hash);
    },
  };
}

let singleton: AssetClient | undefined;

/** 惰性单例：第一次真正用到资产时才探测宿主桥。 */
export function getAssetClient(): AssetClient {
  if (singleton !== undefined) return singleton;
  const bridge = createTauriBridgeFromGlobal();
  if (bridge === undefined) {
    singleton = createMemoryClient();
    return singleton;
  }
  singleton = createHostClient(new WireClient(createTauriTransport({ bridge })));
  return singleton;
}

/** 测试/开发用：注入一个实现（例如浏览器里替换成内存实现）。 */
export function setAssetClientForTests(client: AssetClient | undefined): void {
  singleton = client;
}

/** 把资产字节换成可放进 <img src> 的 URL；调用方负责在后面 revoke（见 `revokeAssetUrl`）。 */
export function bytesToObjectUrl(bytes: Uint8Array, mime = 'image/png'): string {
  return URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime }));
}

export function revokeAssetUrl(url: string): void {
  URL.revokeObjectURL(url);
}
