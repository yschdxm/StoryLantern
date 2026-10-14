import type { CryptoPorts } from '../../../../../packages/oplog/src/index.ts';

/**
 * WebCrypto 版的加密端口（浏览器 / WebView 用；`node-adapters.ts` 那份是 Node 用的）。
 *
 * 关键约束：WebCrypto **只有异步 API**，所以这里的每个方法都返回 Promise——
 * 端口契约本来就写成 `T | Promise<T>`，正是为了这个。
 *
 * 端口的机密性与完整性来自 AEAD（AES-GCM）：哑存储方即使能改文件，也伪造不出内容。
 * 每设备签名（Ed25519）留给下一步——它额外提供"归属"证明，但不影响"内容不被篡改"。
 */

export interface SyncKeyMaterial {
  /** 段内容加密的密钥。 */
  cipher: CryptoKey;
  /** 盲化路径用的密钥。 */
  blindKey: Uint8Array;
}

export function webCryptoAvailable(): boolean {
  const subtle = (globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle;
  return subtle !== undefined && subtle !== null;
}

const ENCODER = new TextEncoder();

/** 从同步口令派生两把密钥（HKDF-SHA256）。同一口令的两台设备派生出同一套密钥，因此能互相解密。 */
export async function deriveSyncKeys(secret: string, salt = 'storylantern-sync-v1'): Promise<SyncKeyMaterial> {
  const subtle = subtleOf();
  const material = await subtle.importKey('raw', ENCODER.encode(secret), 'HKDF', false, ['deriveBits']);
  const cipherBits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: ENCODER.encode(salt), info: ENCODER.encode('segment') },
    material,
    256,
  );
  const blindBits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: ENCODER.encode(salt), info: ENCODER.encode('blind') },
    material,
    256,
  );
  const cipher = await subtle.importKey('raw', cipherBits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { cipher, blindKey: new Uint8Array(blindBits) };
}

export function createWebCryptoPorts(keys: SyncKeyMaterial): CryptoPorts {
  const subtle = subtleOf();

  return {
    digest: {
      async sha256(data) {
        return new Uint8Array(await subtle.digest('SHA-256', toSource(data)));
      },
      async hmacSha256(key, data) {
        const imported = await subtle.importKey('raw', toSource(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        return new Uint8Array(await subtle.sign('HMAC', imported, toSource(data)));
      },
    },

    // gzip：浏览器与 Node 都有 CompressionStream，因此不必引 pako 之类的库。
    // 这里的 `as` 只是迁就 lib.dom 的泛型签名（BufferSource vs Uint8Array），行为没有差别。
    compressor: {
      algorithm: 'gzip',
      compress: (data) => pump(data, new CompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>),
      decompress: (data) => pump(data, new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>),
    },

    cipher: {
      algorithm: 'AES-GCM',
      async seal(plaintext, aad) {
        const nonce = new Uint8Array(12);
        // 随机数来自 crypto（不是 subtle）：AES-GCM 的 nonce 绝不能重复
        const random = (globalThis as { crypto?: Crypto }).crypto;
        if (random === undefined) throw new Error('这个环境没有 WebCrypto，无法加密');
        random.getRandomValues(nonce);
        const sealed = await subtle.encrypt(
          { name: 'AES-GCM', iv: nonce, additionalData: toSource(aad) },
          keys.cipher,
          toSource(plaintext),
        );
        return { nonce, ciphertext: new Uint8Array(sealed) };
      },
      async open(nonce, ciphertext, aad) {
        // 密钥不对 / 被篡改 → 这里抛错，绝不返回部分明文（端口契约要求）
        const plain = await subtle.decrypt(
          { name: 'AES-GCM', iv: toSource(nonce), additionalData: toSource(aad) },
          keys.cipher,
          toSource(ciphertext),
        );
        return new Uint8Array(plain);
      },
    },
  };
}

function subtleOf(): SubtleCrypto {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (subtle === undefined) {
    throw new Error('这个环境没有 WebCrypto（需要安全上下文），无法加密同步数据');
  }
  return subtle;
}

/** WebCrypto 想要 ArrayBuffer 视图；这里统一收口，避免各处 `as` 断言。 */
function toSource(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(data.byteLength));
  copy.set(data);
  return copy;
}

async function pump(data: Uint8Array, transform: ReadableWritablePair<Uint8Array, Uint8Array>): Promise<Uint8Array> {
  const stream = new Blob([toSource(data)]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
