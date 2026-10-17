import { concatBytes, fromBase64, fromUtf8, toBase64, toHex, utf8 } from '../../oplog/src/bytes.ts';
import type { CryptoPorts } from '../../oplog/src/ports.ts';

/**
 * 统一信封：manifest、snapshot、资产索引共用同一套"压缩 + 可选加密"。
 *
 * **不提供签名**（2026-10 已整体删除）：内容完整性由 AES-GCM（加密时）与内容哈希保证；
 * 信任模型见同步文档——能解开共享目录里的密文就说明在组内。
 *
 * 为什么加密要带 AAD：把密文从 A 会话搬到 B 会话（或从 manifest 搬到 snapshot）后解密必须失败，
 * 否则存储方可以做一个"张冠李戴"攻击。
 *
 * **两种物理格式**（2026-10-15 起默认 v2）：
 *
 *   v2（默认）headerJson "\\n" [nonceLen 1B][nonce][密文]      ← 密文里是 gzip(inner)
 *   v1（老文件）gzip( JSON.stringify(信封) )                    ← 加密发生在 gzip **里面**，密文还要 base64
 *
 * v1 的毛病与段格式 v1 一模一样：先加密、密文 base64 塞进 JSON、**最后才 gzip 整个 JSON**，
 * 于是 gzip 面对 base64 文本几乎压不动。实测（scripts/measure-envelope.mjs，6.6MB 快照体）：
 * 现状 1.00× / 639 ms，B′（先 gzip→再 seal→二进制拼帧）10.01× / 51 ms。
 *
 * 兼容：**双读**（读到 v2 就按 v2 解，读到 v1 就按 v1 解，靠第一行是不是 `{"v":2,...}` 判断）。
 * 旧文件里可能残留已删除的 `sig` 字段：解析时天然忽略，不影响读取。
 * 但旧构建读不了 v2 —— 与段格式同一条注意事项：加新设备前先升级。
 */
export interface Envelope {
  v: 1 | 2;
  cipher: string;
  /** v1 专用：未加密时的明文载荷。 */
  payload?: string;
  /** v1 专用：base64 的 nonce。 */
  nonce?: string;
  /** v1 专用：base64 的密文。 */
  ct?: string;
  /** v2 专用：gzip 的算法名（仅用于自描述与排查）。 */
  compression?: string;
  /** v2 专用：密文帧里 nonce 的字节数。 */
  nonceLen?: number;
}

/** v2 密文帧里的 nonce 长度（AES-GCM 用 12），写进头部就不用猜。 */
export const ENVELOPE_V2_NONCE_BYTES = 12;

const NEWLINE = 0x0a;

export interface EncodeEnvelopeOptions {
  ports: CryptoPorts;
  encrypt?: boolean;
  /** 加密的附加认证数据。 */
  aad: string;
  /** 写哪种格式：**默认 2**；1 只用于"造老文件验证双读"与迁移期。 */
  format?: 1 | 2;
}

export async function encodeEnvelope(inner: string, options: EncodeEnvelopeOptions): Promise<Uint8Array> {
  const { ports } = options;
  const format = options.format ?? 2;
  const cipher = options.encrypt === true && ports.cipher !== undefined ? ports.cipher : undefined;

  // ---- v2：先 gzip、再加密、二进制拼帧（不再套 base64） ----
  if (format >= 2) {
    const header: Envelope = { v: 2, cipher: cipher?.algorithm ?? 'none', compression: ports.compressor.algorithm };
    if (cipher) header.nonceLen = ENVELOPE_V2_NONCE_BYTES;

    const compressed = await ports.compressor.compress(utf8(inner));
    let frame: Uint8Array;
    if (cipher) {
      const sealed = await cipher.seal(compressed, utf8(options.aad));
      frame = concatBytes(new Uint8Array([ENVELOPE_V2_NONCE_BYTES]), sealed.nonce, sealed.ciphertext);
    } else {
      frame = compressed;
    }

    return concatBytes(utf8(JSON.stringify(header)), new Uint8Array([NEWLINE]), frame);
  }

  // ---- v1：老格式，保持字节级不变（老文件仍要能读、也要能为测试造出来） ----
  const envelope: Envelope = { v: 1, cipher: cipher?.algorithm ?? 'none' };
  if (cipher) {
    const sealed = await cipher.seal(utf8(inner), utf8(options.aad));
    envelope.nonce = toBase64(sealed.nonce);
    envelope.ct = toBase64(sealed.ciphertext);
  } else {
    envelope.payload = inner;
  }

  return ports.compressor.compress(utf8(JSON.stringify(envelope)));
}

export interface DecodedEnvelope {
  inner: string;
  envelope: Envelope;
  contentHash: string;
}

/** 第一行是不是 v2 的明文头部（v1 是 gzip 二进制，第一行不会是合法 JSON）。 */
function readV2Header(bytes: Uint8Array): Envelope | undefined {
  const end = bytes.indexOf(NEWLINE);
  if (end <= 0) return undefined;
  try {
    const parsed = JSON.parse(fromUtf8(bytes.subarray(0, end))) as Envelope;
    return parsed.v === 2 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function decodeEnvelope(
  bytes: Uint8Array,
  options: { ports: CryptoPorts; aad: string },
): Promise<DecodedEnvelope> {
  const { ports } = options;
  const v2 = readV2Header(bytes);

  let envelope: Envelope;
  let inner: string;

  if (v2 !== undefined) {
    envelope = v2;
    const frame = bytes.subarray(bytes.indexOf(NEWLINE) + 1);
    if (envelope.cipher === 'none') {
      inner = fromUtf8(await decompressOrThrow(ports, frame));
    } else {
      if (!ports.cipher) throw new Error(`内容使用 ${envelope.cipher} 加密，当前没有解密实现`);
      if (ports.cipher.algorithm !== envelope.cipher) {
        throw new Error(`内容使用 ${envelope.cipher} 加密，当前实现是 ${ports.cipher.algorithm}`);
      }
      const nonceLen = envelope.nonceLen ?? ENVELOPE_V2_NONCE_BYTES;
      if (frame.length < 1 + nonceLen + 16) throw new Error(`信封密文帧过短（${frame.length} 字节）`);
      const nonce = frame.subarray(1, 1 + nonceLen);
      const ciphertext = frame.subarray(1 + nonceLen);
      let compressed: Uint8Array;
      try {
        compressed = await ports.cipher.open(new Uint8Array(nonce), new Uint8Array(ciphertext), utf8(options.aad));
      } catch (error) {
        throw new Error(`信封解密失败（密钥不符或密文被篡改/搬到了别的用途）：${error instanceof Error ? error.message : String(error)}`);
      }
      inner = fromUtf8(await decompressOrThrow(ports, compressed));
    }
  } else {
    try {
      envelope = JSON.parse(fromUtf8(await decompressOrThrow(ports, bytes))) as Envelope;
    } catch (error) {
      throw new Error(`信封解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (envelope.v !== 1) throw new Error(`信封版本 ${String(envelope.v)} 不受支持`);
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
  }

  const contentHash = toHex(await ports.digest.sha256(utf8(inner)));
  return { inner, envelope, contentHash };
}

/** 解压失败一律报成"信封解压失败"，不把底层异常漏给调用方。 */
async function decompressOrThrow(ports: CryptoPorts, data: Uint8Array): Promise<Uint8Array> {
  try {
    return await ports.compressor.decompress(data);
  } catch (error) {
    throw new Error(`信封解压失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
