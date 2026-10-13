import { fromBase64, fromUtf8, toBase64, toHex, utf8 } from '../../oplog/src/bytes.ts';
import type { CryptoPorts } from '../../oplog/src/ports.ts';

/**
 * 统一信封：manifest 与 snapshot 用的是同一套"压缩 + 可选加密 + 可选签名"。
 *
 * 为什么必须签名：这两类文件都是**哑存储可以任意改写**的元数据（不是 op 本身），
 * 读取方一旦信任伪造内容，物化状态就会被污染。签名让"只有名单内设备能写"成为可验证事实。
 *
 * 为什么加密要带 AAD：把密文从 A 会话搬到 B 会话（或从 manifest 搬到 snapshot）后解密必须失败，
 * 否则存储方可以做一个"张冠李戴"攻击。
 */
export interface Envelope {
  v: 1;
  cipher: string;
  payload?: string;
  nonce?: string;
  ct?: string;
  sig?: string;
}

export interface EncodeEnvelopeOptions {
  ports: CryptoPorts;
  encrypt?: boolean;
  /** 加密的附加认证数据。 */
  aad: string;
  /** 返回要签名的规范元组；不提供则不签名。 */
  sign?: (contentHash: string) => string;
}

export async function encodeEnvelope(inner: string, options: EncodeEnvelopeOptions): Promise<Uint8Array> {
  const { ports } = options;
  const cipher = options.encrypt === true && ports.cipher !== undefined ? ports.cipher : undefined;
  const contentHash = toHex(await ports.digest.sha256(utf8(inner)));

  const envelope: Envelope = { v: 1, cipher: cipher?.algorithm ?? 'none' };
  if (cipher) {
    const sealed = await cipher.seal(utf8(inner), utf8(options.aad));
    envelope.nonce = toBase64(sealed.nonce);
    envelope.ct = toBase64(sealed.ciphertext);
  } else {
    envelope.payload = inner;
  }

  if (options.sign && ports.signer) {
    envelope.sig = toBase64(await ports.signer.sign(utf8(options.sign(contentHash))));
  }

  return ports.compressor.compress(utf8(JSON.stringify(envelope)));
}

export interface DecodedEnvelope {
  inner: string;
  envelope: Envelope;
  contentHash: string;
}

export async function decodeEnvelope(
  bytes: Uint8Array,
  options: { ports: CryptoPorts; aad: string },
): Promise<DecodedEnvelope> {
  const { ports } = options;

  let envelope: Envelope;
  try {
    envelope = JSON.parse(fromUtf8(await ports.compressor.decompress(bytes))) as Envelope;
  } catch (error) {
    throw new Error(`信封解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (envelope.v !== 1) throw new Error(`信封版本 ${String(envelope.v)} 不受支持`);

  let inner: string;
  if (envelope.cipher !== 'none') {
    if (!ports.cipher) throw new Error(`内容使用 ${envelope.cipher} 加密，当前没有解密实现`);
    if (ports.cipher.algorithm !== envelope.cipher) {
      throw new Error(`内容使用 ${envelope.cipher} 加密，当前实现是 ${ports.cipher.algorithm}`);
    }
    inner = fromUtf8(
      await ports.cipher.open(fromBase64(envelope.nonce ?? ''), fromBase64(envelope.ct ?? ''), utf8(options.aad)),
    );
  } else {
    inner = envelope.payload ?? '';
  }

  const contentHash = toHex(await ports.digest.sha256(utf8(inner)));
  return { inner, envelope, contentHash };
}

export interface VerifyEnvelopeOptions {
  ports: CryptoPorts;
  contentHash: string;
  /** 签名覆盖的规范元组（由调用方按各自的语义拼）。 */
  payload: string;
  signerDeviceId: string;
  /** 默认 true：没有签名即拒绝。 */
  requireSignature?: boolean;
}

export async function verifyEnvelope(envelope: Envelope, options: VerifyEnvelopeOptions): Promise<void> {
  const { ports } = options;
  if (!ports.verifier) return;
  if (!envelope.sig) {
    if (options.requireSignature !== false) throw new Error('内容缺少签名，拒绝接受');
    return;
  }
  const ok = await ports.verifier.verify(options.signerDeviceId, utf8(options.payload), fromBase64(envelope.sig));
  if (!ok) {
    throw new Error(`签名无效（设备 ${options.signerDeviceId} 不在名单内或内容被篡改）`);
  }
}
