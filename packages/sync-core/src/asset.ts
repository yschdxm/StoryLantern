import { concatBytes, toHex } from '../../oplog/src/bytes.ts';
import type { CryptoPorts } from '../../oplog/src/ports.ts';
import type { SyncBackend } from './backend.ts';
import { assetPath } from './paths.ts';

/**
 * 资产库：头像/立绘/背景/附件等二进制走内容寻址，**op 里只存哈希**。
 *
 * 两条设计取舍：
 *  1. **命名用密文哈希**（开启加密时）。若用明文哈希命名，就会出现"同名不同字节"
 *     （同一张图每次加密的密文不同），破坏"同名 ⇒ 同字节"这条全局不变式；
 *     代价是两台设备各传一份同一张图，重复可接受（图片本来就是低频、少量）。
 *  2. **二进制帧而不是 base64/JSON**：图片本身已压缩，base64 会平白膨胀 33%。
 *     帧格式 `[版本 1B][算法 1B][nonce 12B(仅加密时)][密文+tag]`。
 */

export const ASSET_FRAME_VERSION = 1;
export const ASSET_ALG_NONE = 0;
export const ASSET_ALG_AES_GCM = 1;

export interface AssetStore {
  /** 上传（幂等：同内容再传会因条件写返回已存在）。 */
  put(bytes: Uint8Array): Promise<{ hash: string; uploaded: boolean; bytes: number }>;
  get(hash: string): Promise<Uint8Array>;
  has(hash: string): Promise<boolean>;
  pathOf(hash: string): string;
}

async function frameAsset(payload: Uint8Array, ports: CryptoPorts): Promise<Uint8Array> {
  if (!ports.cipher) {
    return concatBytes(new Uint8Array([ASSET_FRAME_VERSION, ASSET_ALG_NONE]), payload);
  }
  const sealed = await ports.cipher.seal(payload, new TextEncoder().encode('asset'));
  return concatBytes(new Uint8Array([ASSET_FRAME_VERSION, ASSET_ALG_AES_GCM]), sealed.nonce, sealed.ciphertext);
}

async function unframeAsset(frame: Uint8Array, ports: CryptoPorts, hash: string): Promise<Uint8Array> {
  if (frame.length < 2) throw new Error(`资产 ${hash} 损坏：帧头不完整`);
  const version = frame[0] as number;
  const algorithm = frame[1] as number;
  if (version !== ASSET_FRAME_VERSION) throw new Error(`资产 ${hash} 使用了不支持的帧版本 ${version}`);

  if (algorithm === ASSET_ALG_NONE) return frame.subarray(2);
  if (algorithm !== ASSET_ALG_AES_GCM) throw new Error(`资产 ${hash} 使用了未知算法 ${algorithm}`);
  if (!ports.cipher) throw new Error(`资产 ${hash} 已加密，但当前没有解密实现`);
  if (frame.length < 2 + 12 + 16) throw new Error(`资产 ${hash} 损坏：密文过短`);
  const nonce = frame.subarray(2, 14);
  const ciphertext = frame.subarray(14);
  try {
    return await ports.cipher.open(nonce, ciphertext, new TextEncoder().encode('asset'));
  } catch (error) {
    throw new Error(`资产 ${hash} 解密失败（密钥不符或被篡改）：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function createAssetStore(options: { backend: SyncBackend; ports: CryptoPorts }): AssetStore {
  const { backend, ports } = options;

  return {
    pathOf(hash: string): string {
      return assetPath(hash);
    },

    async put(bytes: Uint8Array): Promise<{ hash: string; uploaded: boolean; bytes: number }> {
      const frame = await frameAsset(bytes, ports);
      const hash = toHex(await ports.digest.sha256(frame));
      const path = assetPath(hash);
      const result = await backend.put(path, frame, { ifNoneMatch: true });
      return { hash, uploaded: result.ok, bytes: frame.length };
    },

    async has(hash: string): Promise<boolean> {
      try {
        await backend.get(assetPath(hash));
        return true;
      } catch {
        return false;
      }
    },

    async get(hash: string): Promise<Uint8Array> {
      const frame = await backend.get(assetPath(hash));
      return unframeAsset(frame, ports, hash);
    },
  };
}
