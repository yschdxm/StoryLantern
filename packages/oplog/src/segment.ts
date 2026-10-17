import { concatBytes, fromBase64, fromUtf8, toBase64, toHex, utf8 } from './bytes.ts';
import { crc32Hex } from './crc32.ts';
import { decompressOrThrow, openSegmentBodyV2, packSegmentBodyV2 } from './segment-v2.ts';
// 对外仍然能从 segment.ts 拿到 v2 的常量（原先就在这里定义）
export { SEGMENT_V2_AAD, SEGMENT_V2_NONCE_BYTES } from './segment-v2.ts';
import { decodeOps, encodeOp, type Op } from './op.ts';
import type { CryptoPorts } from './ports.ts';
export const SEGMENT_MAGIC = 'SFSEG1';
export const SEGMENT_FORMAT_VERSION = 2;

/**

/**
 * 段的体积目标。段太大 → 一次重传代价高、冲突窗口长；段太小 → 文件数量与
 * 每次同步的往返数暴涨。256 KB–1 MB 是"一天重度使用 1–3 个段"的落点。
 */
export const SEGMENT_POLICY = {
  targetBytes: 512 * 1024,
  minBytes: 256 * 1024,
  maxBytes: 1024 * 1024,
  maxOps: 1500,
} as const;

export interface SegmentHeader {
  magic: string;
  v: number;
  deviceId: string;
  seq: number;
  blindSessionId: string;
  epoch: number;
  createdAt: number;
  count: number;
  codec: 'jsonl';
  compression: string;
  cipher: string;
}

export interface SegmentTrailer {
  /** 格式版本：**缺省 = v1**（老段的 trailer 里没有这个字段，读方据此走老路径）。 */
  v?: number;
  /** v2 才写：段体用哪种加密（'none' = 未加密）。v1 的这个信息在段头里，所以老段没有。 */
  cipher?: string;
  compression?: string;
  nonceLen?: number;
  count: number;
  crc32: string;
  blobHash: string;
  contentHash: string;
}

export type SegmentErrorCode =
  | 'truncated'
  | 'format'
  | 'crc-mismatch'
  | 'hash-mismatch'
  | 'name-mismatch'
  | 'count-mismatch'
  | 'decrypt'
  | 'compression'
  | 'op-codec';

export class SegmentError extends Error {
  readonly code: SegmentErrorCode;

  constructor(code: SegmentErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'SegmentError';
    this.code = code;
  }
}

export interface PackSegmentInput {
  /**
   * 写哪种格式：**默认 2**（先 gzip 再加密、二进制拼帧）。
   * 1 是老格式（先加密、密文套 base64 塞 JSON、再 gzip），保留它是为了让测试能造出
   * 真实的老段来验证"读得回老数据"，以及给迁移期用。
   */
  format?: 1 | 2;
  ops: readonly Op[];
  deviceId: string;
  seq: number;
  blindSessionId: string;
  epoch?: number;
  createdAt?: number;
  ports: CryptoPorts;
  /** 是否加密段内容（需要在 ports.cipher 提供实现）。 */
  encrypt?: boolean;
}

export interface PackedSegment {
  /** `00000007-1a2b3c4d.jsonl.gz` —— 序号 + 压缩前内容的哈希前缀。 */
  name: string;
  bytes: Uint8Array;
  header: SegmentHeader;
  trailer: SegmentTrailer;
  blobHash: string;
}

const NEWLINE = 0x0a;

/**
 * 段文件的物理布局（两种格式）：
 *
 *   v2（默认）[nonceLen 1B][nonce][密文] ++ "\n" ++ utf8(trailerJson)，密文里是 gzip(明文)；
 *   v1（老段）gzip( headerLine "\n" body ) ++ "\n" ++ utf8(trailerJson)，body 可能是 base64 密文 JSON。
 * 两版共同点：trailer 永远是**最后一行 JSON**（压缩流里的 0x0a 不受影响），它不加密；格式版本写在 trailer 的 v 里，
 * 老段没有 v 就是 v1。
 */
export async function packSegment(input: PackSegmentInput): Promise<PackedSegment> {
  const { ports } = input;
  const format = input.format ?? SEGMENT_FORMAT_VERSION;
  const useCipher = input.encrypt === true && ports.cipher !== undefined;
  const cipher = useCipher ? ports.cipher : undefined;

  const header: SegmentHeader = {
    magic: SEGMENT_MAGIC,
    v: format,
    deviceId: input.deviceId,
    seq: input.seq,
    blindSessionId: input.blindSessionId,
    epoch: input.epoch ?? 0,
    createdAt: input.createdAt ?? Date.now(),
    count: input.ops.length,
    codec: 'jsonl',
    compression: ports.compressor.algorithm,
    cipher: cipher?.algorithm ?? 'none',
  };
  const headerLine = JSON.stringify(header);

  const plaintext = input.ops.map((op) => encodeOp(op)).join('\n');

  // 两条写路径都收敛成 { blob, trailer }，最后统一拼一次 bytes。
  // v2（默认）：先压缩、再加密、密文二进制拼帧 —— 实测压缩 9-24×、打包与解包都快得多（见 segment-v2.ts）。
  // v1（format=1）：老格式保持字节级不变，供"造老段验证双读"与迁移期使用。
  let blob: Uint8Array;
  let trailer: SegmentTrailer;
  if (format >= 2) {
    ({ blob, trailer } = await packSegmentBodyV2({
      header,
      plain: utf8(headerLine + "\n" + plaintext),
      ports,
      encrypt: input.encrypt === true,
    }));
  } else {
    let body: string;
    if (cipher) {
      const sealed = await cipher.seal(utf8(plaintext), utf8(headerLine));
      body = JSON.stringify({ nonce: toBase64(sealed.nonce), ct: toBase64(sealed.ciphertext) });
    } else {
      body = plaintext;
    }

    const contentHash = toHex(await ports.digest.sha256(utf8(headerLine + "\n" + body)));
    blob = await ports.compressor.compress(utf8(headerLine + "\n" + body));
    trailer = {
      count: header.count,
      crc32: crc32Hex(blob),
      blobHash: toHex(await ports.digest.sha256(blob)),
      contentHash,
    };
  }

  const bytes = concatBytes(blob, new Uint8Array([NEWLINE]), utf8(JSON.stringify(trailer)));
  return { name: segmentFileName(input.seq, trailer.blobHash), bytes, header, trailer, blobHash: trailer.blobHash };
}

export function segmentFileName(seq: number, blobHash: string): string {
  return `${String(seq).padStart(8, '0')}-${blobHash.slice(0, 8)}.jsonl.gz`;
}

export function parseSegmentFileName(name: string): { seq: number; hash8: string } | undefined {
  const match = /^(\d{8})-([0-9a-f]{8})\.jsonl\.gz$/.exec(name);
  if (!match) return undefined;
  return { seq: Number.parseInt(match[1] as string, 10), hash8: match[2] as string };
}

export interface UnpackExpectations {
  deviceId?: string;
  seq?: number;
  blindSessionId?: string;
}

export interface UnpackedSegment {
  header: SegmentHeader;
  trailer: SegmentTrailer;
  ops: Op[];
  blobHash: string;
}

/** 不解压的廉价预检：拿到 trailer（段是谁写的、几条、多大）。 */
export function peekSegment(bytes: Uint8Array): { trailer: SegmentTrailer; blobBytes: number } {
  const split = splitTrailer(bytes);
  const trailer = parseJson<SegmentTrailer>(split.trailerText, 'trailer');
  if (typeof trailer.count !== 'number' || typeof trailer.blobHash !== 'string') {
    throw new SegmentError('format', 'trailer 缺少 count/blobHash');
  }
  return { trailer, blobBytes: split.blob.length };
}

function looksLikeTrailer(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return typeof parsed.count === 'number' && typeof parsed.blobHash === 'string' && typeof parsed.contentHash === 'string';
  } catch {
    return false;
  }
}

/**
 * 从文件末尾向前寻找真正的 trailer 分隔符。
 *
 * 之所以不能"只取最后一个换行"：被截断的文件里，gzip 流内部本来就可能出现 0x0a，
 * 那样会把压缩数据的尾巴误当成 trailer，报出与事实不符的错误。
 * 因此逐个候选向前回溯，只接受"能解析成合法 trailer"的那一个；
 * 全都不是 → 明确判定为截断/非段文件。
 */
function splitTrailer(bytes: Uint8Array): { blob: Uint8Array; trailerText: string } {
  let index = bytes.length - 1;
  while (index > 0) {
    while (index > 0 && bytes[index] !== NEWLINE) index -= 1;
    if (index <= 0) break;
    const trailerText = fromUtf8(bytes.subarray(index + 1));
    if (looksLikeTrailer(trailerText)) return { blob: bytes.subarray(0, index), trailerText };
    index -= 1;
  }
  throw new SegmentError('truncated', '未找到有效的 trailer（文件被截断、或不是段文件）');
}


function parseJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new SegmentError('format', `${label} JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 校验并解出段。任何一步失败都整体拒绝（绝不部分接受）：
 *  1. trailer 可解析、字段齐全；
 *  2. crc32 与 blobHash 与实收字节一致（传输完整性）；
 *  3. 文件名中的摘要与实收字节一致（防止张冠李戴）；
 *  4. contentHash 与解压后的内容一致（防止内容被替换）；
 *  5. 之后才解密、解析 op、核对条数。
 *
 * 旧段文件里可能存在已删除的 `sig` 字段：JSON 解析时天然忽略，不影响读取。
 */
export async function unpackSegment(
  bytes: Uint8Array,
  options: { ports: CryptoPorts; fileName?: string; expect?: UnpackExpectations },
): Promise<UnpackedSegment> {
  const { ports } = options;
  const expectations = options.expect ?? {};

  const split = splitTrailer(bytes);
  const trailer = parseJson<SegmentTrailer>(split.trailerText, 'trailer');

  const actualCrc = crc32Hex(split.blob);
  if (trailer.crc32 !== actualCrc) {
    throw new SegmentError('crc-mismatch', `crc32 不符（trailer=${trailer.crc32} 实际=${actualCrc}）`);
  }

  const blobHash = toHex(await ports.digest.sha256(split.blob));
  if (trailer.blobHash !== blobHash) {
    throw new SegmentError('hash-mismatch', '段字节哈希与 trailer 不符（传输损坏或被篡改）');
  }

  if (options.fileName !== undefined) {
    const parsed = parseSegmentFileName(options.fileName);
    if (!parsed) throw new SegmentError('format', `文件名不符合段命名规范：${options.fileName}`);
    if (parsed.hash8 !== blobHash.slice(0, 8)) {
      throw new SegmentError('name-mismatch', `文件名摘要 ${parsed.hash8} 与实际 ${blobHash.slice(0, 8)} 不符`);
    }
    if (expectations.seq !== undefined && parsed.seq !== expectations.seq) {
      throw new SegmentError('name-mismatch', `文件名序号 ${parsed.seq} 与预期 ${expectations.seq} 不符`);
    }
  }

  // v2：密文帧 = [nonceLen 1B][nonce][密文]，里面是**压缩后**的整份明文 → 先解密、再解压。
  // v1：blob 就是 gzip(headerLine + body)，body 可能还套着一层 base64 密文 JSON。
  // 版本靠 trailer.v 判断（老 trailer 没有 v 字段 → v1），所以不必猜、也不必看文件头魔数。
  const plain =
    trailer.v === 2
      ? await openSegmentBodyV2(split.blob, trailer, ports)
      : await decompressOrThrow(ports.compressor, split.blob);

  const text = fromUtf8(plain);
  const newline = text.indexOf('\n');
  if (newline < 0) throw new SegmentError('format', '段内容缺少 header 行');
  const headerLine = text.slice(0, newline);
  const body = text.slice(newline + 1);
  const header = parseJson<SegmentHeader>(headerLine, 'header');

  if (header.magic !== SEGMENT_MAGIC) throw new SegmentError('format', `段魔数不符：${header.magic}`);
  if (header.v > SEGMENT_FORMAT_VERSION) {
    throw new SegmentError('format', `段格式 v${header.v} 高于本实现支持的 v${SEGMENT_FORMAT_VERSION}`);
  }
  if (expectations.deviceId !== undefined && header.deviceId !== expectations.deviceId) {
    throw new SegmentError('name-mismatch', `段来自设备 ${header.deviceId}，与预期 ${expectations.deviceId} 不符`);
  }
  if (expectations.blindSessionId !== undefined && header.blindSessionId !== expectations.blindSessionId) {
    throw new SegmentError('name-mismatch', '段的会话盲化 id 与预期不符');
  }
  if (options.fileName !== undefined) {
    const parsed = parseSegmentFileName(options.fileName);
    if (parsed && parsed.seq !== header.seq) {
      throw new SegmentError('name-mismatch', `文件名序号 ${parsed.seq} 与段头 ${header.seq} 不符`);
    }
  }

  const contentHash = toHex(await ports.digest.sha256(utf8(`${headerLine}\n${body}`)));
  if (trailer.contentHash !== contentHash) {
    throw new SegmentError('hash-mismatch', 'contentHash 不符（段内容被替换或损坏）');
  }

  let opsText = body;
  if (trailer.v === 2) {
    // v2 的加密在"整份明文"那一层做过了（上面），body 到这里就是明文 ops
  } else if (header.cipher !== 'none') {
    if (!ports.cipher) throw new SegmentError('decrypt', `段使用 ${header.cipher} 加密，但当前没有可用的解密实现`);
    if (ports.cipher.algorithm !== header.cipher) {
      throw new SegmentError('decrypt', `段使用 ${header.cipher} 加密，当前实现是 ${ports.cipher.algorithm}`);
    }
    const sealed = parseJson<{ nonce: string; ct: string }>(body, 'encrypted body');
    try {
      opsText = fromUtf8(await ports.cipher.open(fromBase64(sealed.nonce), fromBase64(sealed.ct), utf8(headerLine)));
    } catch (error) {
      throw new SegmentError('decrypt', `解密失败（密钥不符或密文被篡改）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let ops: Op[];
  try {
    ops = decodeOps(opsText);
  } catch (error) {
    throw new SegmentError('op-codec', `op 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }

  if (ops.length !== header.count || ops.length !== trailer.count) {
    throw new SegmentError(
      'count-mismatch',
      `op 条数不符（header=${header.count} trailer=${trailer.count} 实际=${ops.length}）`,
    );
  }

  return { header, trailer, ops, blobHash };
}

/** 段是否应该收口（达到体积/条数阈值，或调用方要求 flush）。 */
export function shouldFlush(pendingBytes: number, pendingOps: number, force = false): boolean {
  if (force) return true;
  if (pendingOps >= SEGMENT_POLICY.maxOps) return true;
  return pendingBytes >= SEGMENT_POLICY.targetBytes;
}

/** 从 op 文本估算字节数，用于分段决策（不编码成完整 JSON 也能估）。 */
export function estimateOpBytes(op: Op): number {
  let size = 128;
  size += (op.payload as { content?: string }).content?.length ?? 0;
  size += op.type.length + op.entity.id.length;
  return size;
}
