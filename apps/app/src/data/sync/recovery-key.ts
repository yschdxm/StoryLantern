import type { RecoveryProofPort } from '../../../../../packages/sync-core/src/recovery.ts';
import { toHex } from '../../../../../packages/sync-core/src/signing.ts';

/**
 * 恢复密钥的 WebCrypto 实现（Ed25519）——与设备签名用的是同一套算法，但**用途不同**。
 *
 * 关键差别（写进文档，别混）：
 *  - **设备密钥**：证明"这段是谁写的"，是这台机器的永久身份；
 *  - **恢复密钥**：证明"持有它的人是我（库主人）"，用来在忘记同步口令时把新设备接回来。
 *
 * 私钥**只交出一次给用户离线保存**：这里不落地、不缓存（落地就等于"离线"没意义），
 * 所以界面上必须写清"丢了就再也拿不回来，只能重新生成并重新公布公钥"。
 */

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bytesFromHex(hex: string): Uint8Array {
  if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw new Error('不是合法的十六进制密钥');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return out;
}

export async function detectRecoverySupport(): Promise<boolean> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return false;
  try {
    await subtle.generateKey({ name: 'Ed25519' } as never, true, ['sign', 'verify']);
    return true;
  } catch {
    return false;
  }
}

export function createWebCryptoRecoveryProof(): RecoveryProofPort {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new Error('这个环境没有 WebCrypto，无法使用恢复密钥');

  return {
    async generate() {
      const pair = (await subtle.generateKey({ name: 'Ed25519' } as never, true, ['sign', 'verify'])) as CryptoKeyPair;
      const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
      const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
      // 私钥以 PKCS#8 十六进制给用户；公钥十六进制公布到共享目录
      return { publicKey: toHex(raw), privateKey: toHex(pkcs8) };
    },

    async sign(privateKeyHex, payload) {
      const key = await subtle.importKey(
        'pkcs8',
        bufferOf(bytesFromHex(privateKeyHex)),
        { name: 'Ed25519' } as never,
        false,
        ['sign'],
      );
      return toHex(new Uint8Array(await subtle.sign({ name: 'Ed25519' } as never, key, bufferOf(payload))));
    },

    async verify(publicKeyHex, payload, signatureHex) {
      if (publicKeyHex === '' || signatureHex === '') return false;
      const key = await subtle.importKey(
        'raw',
        bufferOf(bytesFromHex(publicKeyHex)),
        { name: 'Ed25519' } as never,
        false,
        ['verify'],
      );
      return subtle.verify(
        { name: 'Ed25519' } as never,
        key,
        bufferOf(bytesFromHex(signatureHex)),
        bufferOf(payload),
      );
    },
  };
}
