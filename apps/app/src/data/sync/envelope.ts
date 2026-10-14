import type { KeyWrapPort } from '../../../../../packages/sync-core/src/keyring.ts';
import { toHex } from '../../../../../packages/sync-core/src/signing.ts';

/**
 * "一人一把锁"的 WebCrypto 实现（X25519 + HKDF-SHA256 + AES-GCM）。
 *
 * 为什么是这套组合：
 *  - **X25519**：Ed25519 只能签名、不能协商密钥，所以收自己那份钥匙要另一对密钥；
 *  - **HKDF-SHA256**：把 ECDH 出来的共享秘密整理成一把 AES 密钥（不直接用共享秘密）；
 *  - **AES-GCM**：包装内容密钥时带认证，别人解不出**也改不了**（改了会认证失败）。
 *
 * 关于绑定的那份"只有收件人能解"的强度：ECDH 出来的共享秘密双方都能算，
 * 所以包的时候把**收件人公钥**混进 HKDF 的 salt，避免"换个人名就能互相顶替"这类错用。
 */

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function bytesFromHex(hex: string): Uint8Array {
  if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw new Error(`不是合法的十六进制公钥：${hex.slice(0, 16)}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return out;
}

export async function detectKeyWrapSupport(): Promise<boolean> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return false;
  try {
    await subtle.generateKey({ name: 'X25519' } as never, true, ['deriveBits']);
    return true;
  } catch {
    return false;
  }
}

export function createWebCryptoKeyWrap(): KeyWrapPort {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new Error('这个环境没有 WebCrypto，无法包装密钥');

  /** ECDH → HKDF → AES-GCM 密钥；salt 与 info 里绑上双方公钥。 */
  async function deriveAesKey(
    myPrivate: CryptoKey,
    peerPublic: CryptoKey,
    peerPublicHex: string,
    myPublicHex: string,
  ): Promise<CryptoKey> {
    const shared = await subtle.deriveBits({ name: 'X25519', public: peerPublic } as never, myPrivate, 256);
    const hkdfKey = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
    // 两个公钥**排序**后拼进 salt：包装方与解包方拿到的顺序可能相反，不排序就对不上
    const pair = [myPublicHex, peerPublicHex].sort().join('/');
    const salt = new TextEncoder().encode(`storylantern/keywrap/v1/${pair}`);
    const info = new TextEncoder().encode('storylantern/content-key/v1');
    const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, hkdfKey, 256);
    return subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async function importPublic(hex: string): Promise<CryptoKey> {
    return subtle.importKey('raw', bufferOf(bytesFromHex(hex)), { name: 'X25519' } as never, false, []);
  }

  return {
    async generateAgreementKeys() {
      const pair = (await subtle.generateKey({ name: 'X25519' } as never, true, ['deriveBits'])) as CryptoKeyPair;
      const publicKey = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
      const privateKey = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
      // 公钥要以十六进制发布；私钥留给本机存（与签名私钥一样的取舍：明文存本地，写进文档）
      return { publicKey: toHex(publicKey), privateKey: toHex(privateKey) };
    },

    async randomContentKey() {
      return new Uint8Array(crypto.getRandomValues(new Uint8Array(32)));
    },

    async wrapFor(recipientPublicKeyHex, contentKey) {
      // 包装方临时生成一对密钥：只需要对方公钥就能包（离线也能包）
      const ephemeral = (await subtle.generateKey({ name: 'X25519' } as never, true, ['deriveBits'])) as CryptoKeyPair;
      const ephemeralPublic = new Uint8Array(await subtle.exportKey('raw', ephemeral.publicKey));
      const peer = await importPublic(recipientPublicKeyHex);
      const aes = await deriveAesKey(ephemeral.privateKey, peer, recipientPublicKeyHex, toHex(ephemeralPublic));

      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = new Uint8Array(
        await subtle.encrypt({ name: 'AES-GCM', iv } as never, aes, bufferOf(contentKey)),
      );
      // 格式：临时公钥 | iv | 密文（都塞进一个 base64 里，读的人按长度切）
      const combined = new Uint8Array(ephemeralPublic.length + iv.length + sealed.length);
      combined.set(ephemeralPublic, 0);
      combined.set(iv, ephemeralPublic.length);
      combined.set(sealed, ephemeralPublic.length + iv.length);
      let binary = '';
      for (const byte of combined) binary += String.fromCharCode(byte);
      return btoa(binary);
    },

    async unwrapWith(myPrivateKey, myPublicKeyHex, wrapped) {
      const binary = atob(wrapped);
      const combined = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) combined[index] = binary.charCodeAt(index);
      if (combined.length <= 32 + 12) throw new Error('包起来的钥匙长度不对');

      const ephemeralPublic = combined.slice(0, 32);
      const iv = combined.slice(32, 44);
      const sealed = combined.slice(44);

      const privateKey = await subtle.importKey(
        'pkcs8',
        bufferOf(bytesFromHex(myPrivateKey)),
        { name: 'X25519' } as never,
        false,
        ['deriveBits'],
      );
      const peer = await importPublic(toHex(ephemeralPublic));
      const aes = await deriveAesKey(privateKey, peer, toHex(ephemeralPublic), myPublicKeyHex);

      const plain = await subtle.decrypt({ name: 'AES-GCM', iv } as never, aes, bufferOf(sealed));
      return new Uint8Array(plain);
    },
  };
}
