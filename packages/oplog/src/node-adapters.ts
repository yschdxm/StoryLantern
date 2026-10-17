import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { Compressor, Digest, SealedPayload, SegmentCipher } from './ports.ts';

export const nodeDigest: Digest = {
  sha256(data) {
    // 同步实现让 API 简单；浏览器侧换成 WebCrypto（异步），因此调用点一律 await。
    return createHash('sha256').update(data).digest();
  },
  hmacSha256(key, data) {
    return createHmac('sha256', key).update(data).digest();
  },
};

export const nodeGzip: Compressor = {
  algorithm: 'gzip',
  compress(data) {
    return gzipSync(data);
  },
  decompress(data) {
    return gunzipSync(data);
  },
};

export interface AesGcmOptions {
  /** 32 字节密钥；不传则随机生成（仅用于测试）。 */
  key?: Uint8Array;
}

/**
 * AES-256-GCM。选择它而不是 XChaCha20-Poly1305 的原因：
 * 浏览器 WebCrypto、Node 与 Rust 三端都原生支持，无需引入 libsodium WASM；
 * 96 位随机 nonce 在本项目量级（每设备每天个位数段）远未触及生日界。
 * 密文为 `nonce || ciphertext || tag`，`algorithm` 写入段头，因此将来切换到
 * XChaCha20 只需新增一个实现 + 格式版本号。
 */
export function createAesGcmCipher(options: AesGcmOptions = {}): SegmentCipher {
  const key = options.key ?? new Uint8Array(randomBytes(32));
  if (key.length !== 32) throw new Error('AES-256-GCM 需要 32 字节密钥');

  return {
    algorithm: 'aes-256-gcm',
    seal(plaintext: Uint8Array, aad: Uint8Array): SealedPayload {
      const nonce = new Uint8Array(randomBytes(12));
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(aad));
      const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
      return { nonce, ciphertext: new Uint8Array(Buffer.concat([ciphertext, cipher.getAuthTag()])) };
    },
    open(nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Uint8Array {
      if (ciphertext.length < 16) throw new Error('密文过短，缺少 GCM 认证标签');
      const tag = ciphertext.subarray(ciphertext.length - 16);
      const body = ciphertext.subarray(0, ciphertext.length - 16);
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(Buffer.from(tag));
      return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(body)), decipher.final()]));
    },
  };
}
