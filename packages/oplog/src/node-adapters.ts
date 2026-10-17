import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { Compressor, Digest, SealedPayload, SegmentCipher, SegmentSigner, SignatureVerifier } from './ports.ts';
import { toHex } from './bytes.ts';

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

/**
 * 协议层的**可选**签名端口在 Node 里的测试实现。
 *
 * 注意：app 不注入签名实现（真机 WebView 没有非对称签名能力，且我们的信任模型建立在
 * "共享口令 + AES-GCM"上）。这里用 HMAC-SHA256 做**对称**签名替身，只为让段/信封的
 * 签名分支能在 Node 里被测试；`publicKeyPem` 是对称密钥的十六进制，不是可发布公钥。
 */
export interface DeviceKeyPair {
  deviceId: string;
  privateKeyPem: string;
  publicKeyPem: string;
}

export function generateDeviceKeyPair(deviceId: string): DeviceKeyPair {
  const secret = toHex(new Uint8Array(randomBytes(32)));
  return { deviceId, privateKeyPem: secret, publicKeyPem: secret };
}

export function createDeviceSigner(device: DeviceKeyPair): SegmentSigner {
  const key = Buffer.from(device.privateKeyPem, 'hex');
  return {
    deviceId: device.deviceId,
    sign(data) {
      return createHmac('sha256', key).update(data).digest();
    },
  };
}

/** 设备名单：deviceId -> 对称密钥十六进制。名单外的设备一律拒绝。 */
export type DeviceRoster = ReadonlyMap<string, string>;

export function createRosterVerifier(roster: DeviceRoster): SignatureVerifier {
  return {
    verify(deviceId, data, signature) {
      const keyHex = roster.get(deviceId);
      if (!keyHex) return false;
      try {
        const expected = createHmac('sha256', Buffer.from(keyHex, 'hex')).update(data).digest();
        return expected.length === signature.length && timingSafeEqual(expected, Buffer.from(signature));
      } catch {
        return false;
      }
    },
  };
}

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
