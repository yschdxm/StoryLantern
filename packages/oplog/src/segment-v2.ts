import { concatBytes, toHex, utf8 } from './bytes.ts';
import { crc32Hex } from './crc32.ts';
import type { CryptoPorts } from './ports.ts';
import { SegmentError, type SegmentHeader, type SegmentTrailer } from './segment.ts';

/**
 * 段格式 v2 的编解码：**先压缩、再加密**，密文用二进制拼帧（不再套 base64）。
 *
 * 为什么换（都有实测，见 DEVELOPMENT.md 与 scripts/measure-segment-codec.mjs）：
 * v1 是"先 seal 加密再 gzip"，gzip 面对密文压不动（实测 1.00×），密文又被 base64 撑大 33%
 * → 现状是"零压缩 + 五套方案里最慢的那个"。v2 实测 9-24×、打包快约 4.7 倍、解包快约 18 倍。
 *
 * 这个文件从 segment.ts 里拆出来，一半是为了单一职责，一半是因为 segment.ts 已经贴着 400 行上限。
 * 与 segment.ts 之间是**类型 + SegmentError 的互引**（ESM 循环引用，纯运行时使用，
 * 初始化顺序无碍）；拆分的边界是"整份明文的加解密与拼帧"，段头构造、校验顺序、v1 老路径都留在 segment.ts。
 */

/**
 * v2 的附加认证数据（AAD）。
 *
 * v1 把 header 放在 gzip **里面**、密文只包正文，所以能用 headerLine 当 AAD；
 * v2 把整个 `headerLine + "\n" + opsText` 一起压缩后加密，**加密时还没有 header 可引用**，
 * 因此 AAD 用一个固定的格式串：它绑定"这是 v2 段"，防的是跨格式张冠李戴。
 * header 的完整性另有保障——contentHash 覆盖整份明文。
 */
export const SEGMENT_V2_AAD = 'SFSEG2';
/** v2 密文帧里的 nonce 长度（AES-GCM 用 12；写进 trailer，读方不必猜）。 */
export const SEGMENT_V2_NONCE_BYTES = 12;

/** 解压失败一律报成"压缩层错误"，不把底层异常漏给调用方。 */
export async function decompressOrThrow(compressor: CryptoPorts['compressor'], data: Uint8Array): Promise<Uint8Array> {
  try {
    return await compressor.decompress(data);
  } catch (error) {
    throw new SegmentError('compression', `解压失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface PackSegmentBodyV2Input {
  header: SegmentHeader;
  /** 整份明文：`headerLine + "\n" + op 行`。 */
  plain: Uint8Array;
  ports: CryptoPorts;
  /** 只有它还要求加密、且 ports.cipher 存在时才真的加密。 */
  encrypt: boolean;
}

/** 写：gzip(明文) → seal → `[nonceLen][nonce][密文]`；顺带算出 trailer（含内容哈希）。 */
export async function packSegmentBodyV2(input: PackSegmentBodyV2Input): Promise<{ blob: Uint8Array; trailer: SegmentTrailer }> {
  const { header, plain, ports } = input;
  const cipher = input.encrypt ? ports.cipher : undefined;

  const contentHash = toHex(await ports.digest.sha256(plain));

  const compressed = await ports.compressor.compress(plain);
  let blob: Uint8Array;
  if (cipher) {
    const sealed = await cipher.seal(compressed, utf8(SEGMENT_V2_AAD));
    blob = concatBytes(new Uint8Array([SEGMENT_V2_NONCE_BYTES]), sealed.nonce, sealed.ciphertext);
  } else {
    blob = compressed;
  }

  const blobHash = toHex(await ports.digest.sha256(blob));
  const trailer: SegmentTrailer = {
    v: 2,
    count: header.count,
    cipher: header.cipher,
    compression: header.compression,
    ...(cipher === undefined ? {} : { nonceLen: SEGMENT_V2_NONCE_BYTES }),
    crc32: crc32Hex(blob),
    blobHash,
    contentHash,
  };
  return { blob, trailer };
}

/** 读：从 blob 取出明文（需要时先解密、再解压）。校验（crc/哈希/条数）由 segment.ts 负责。 */
export async function openSegmentBodyV2(blob: Uint8Array, trailer: SegmentTrailer, ports: CryptoPorts): Promise<Uint8Array> {
  if (trailer.cipher === undefined || trailer.cipher === 'none') return decompressOrThrow(ports.compressor, blob);

  if (!ports.cipher) {
    throw new SegmentError('decrypt', `段使用 ${trailer.cipher} 加密，但当前没有可用的解密实现`);
  }
  if (ports.cipher.algorithm !== trailer.cipher) {
    throw new SegmentError('decrypt', `段使用 ${trailer.cipher} 加密，当前实现是 ${ports.cipher.algorithm}`);
  }

  const nonceLen = trailer.nonceLen ?? SEGMENT_V2_NONCE_BYTES;
  if (blob.length < 1 + nonceLen + 16) throw new SegmentError('format', `v2 密文帧过短（${blob.length} 字节）`);
  const nonce = blob.subarray(1, 1 + nonceLen);
  const ciphertext = blob.subarray(1 + nonceLen);

  let compressed: Uint8Array;
  try {
    compressed = await ports.cipher.open(new Uint8Array(nonce), new Uint8Array(ciphertext), utf8(SEGMENT_V2_AAD));
  } catch (error) {
    throw new SegmentError('decrypt', `解密失败（密钥不符或密文被篡改）：${error instanceof Error ? error.message : String(error)}`);
  }
  return decompressOrThrow(ports.compressor, compressed);
}
