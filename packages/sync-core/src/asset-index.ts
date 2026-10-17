/**
 * 资产索引：把「本地明文 sha256」映射到「远端密文哈希」。
 *
 * 为什么必须有索引：远端资产按**密文哈希**命名（ADR-0008：同名 ⇒ 同字节），
 * 而卡片里只存 `asset://<明文 sha256>`。两者之间没有可推导关系（密文含随机 nonce），
 * 所以换机后必须靠一份**显式发布的映射**才能找到对方的图片。
 *
 * 每台设备只写自己的索引（与 manifest 同一条约束：一个路径只有一个写者）：
 *   assets/index/<deviceId>-<seq:8>-<hash8>.json.gz
 *
 * 信封复用 `envelope.ts`（gzip + 可选加密 + 可选签名）：
 *  - AAD 绑定 `asset-index|<deviceId>`：把密文搬到别的设备命名空间后解密必然失败；
 *  - 签名覆盖 `asset-index|<deviceId>|<seq>|<contentHash>`：内容与序号都被钉住；
 *  - 无签名/旧 v1 信封仍可读（与截图/段一致的双读策略），由 `requireSignature` 控制是否强拒。
 */

import { toHex } from '../../oplog/src/bytes.ts';
import type { CryptoPorts } from '../../oplog/src/ports.ts';
import { encodeEnvelope, decodeEnvelope, verifyEnvelope, type Envelope } from './envelope.ts';

export const ASSET_INDEX_PREFIX = 'assets/index/';

export interface AssetIndexEntry {
  /** 本地明文 sha256（64 hex）。 */
  plain: string;
  /** 远端密文哈希（64 hex），即 `assets/<cipher>` 的文件名。 */
  cipher: string;
  /** 远端帧字节数（仅统计用）。 */
  bytes: number;
}

export interface AssetIndex {
  v: 1;
  deviceId: string;
  updatedAt: number;
  entries: AssetIndexEntry[];
}

const HEX64 = /^[0-9a-f]{64}$/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const INDEX_FILE = /^assets\/index\/(.+)-(\d{8})-([0-9a-f]{8})\.json\.gz$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 设备 id 会直接进文件名：限制字符集，杜绝路径穿越。 */
export function isSafeAssetIndexDeviceId(value: string): boolean {
  return DEVICE_ID.test(value);
}

/** 索引文件名（seq 用 8 位补零，与 manifest 的命名习惯一致，便于按字典序列出）。 */
export function assetIndexFileName(deviceId: string, seq: number, blobHash: string): string {
  if (!isSafeAssetIndexDeviceId(deviceId)) throw new Error(`资产索引：设备 id 不合法：${deviceId}`);
  if (!Number.isInteger(seq) || seq < 0) throw new Error(`资产索引：序号必须是自然数，收到 ${String(seq)}`);
  return `${deviceId}-${String(seq).padStart(8, '0')}-${blobHash.slice(0, 8)}.json.gz`;
}

export function assetIndexPath(deviceId: string, seq: number, blobHash: string): string {
  return `${ASSET_INDEX_PREFIX}${assetIndexFileName(deviceId, seq, blobHash)}`;
}

/** 从扁平路径反解设备与序号；不是索引路径返回 undefined。 */
export function parseAssetIndexPath(path: string): { deviceId: string; seq: number; hash8: string } | undefined {
  const match = INDEX_FILE.exec(path);
  const deviceId = match?.[1];
  const seqText = match?.[2];
  const hash8 = match?.[3];
  if (deviceId === undefined || seqText === undefined || hash8 === undefined) return undefined;
  if (!isSafeAssetIndexDeviceId(deviceId)) return undefined;
  return { deviceId, seq: Number.parseInt(seqText, 10), hash8 };
}

/** 加密的附加认证数据：绑定到设备命名空间（防"张冠李戴"）。 */
export function assetIndexAad(deviceId: string): string {
  return `asset-index|${deviceId}`;
}

/** 签名覆盖的规范元组：设备 + 序号 + 内容摘要，三项都被钉死。 */
export function assetIndexSignaturePayload(deviceId: string, seq: number, contentHash: string): string {
  return ['asset-index', deviceId, String(seq), contentHash].join('|');
}

/** 严格校验（索引是哑存储可改的元数据，读入绝不接受"看起来能用"）。 */
export function validateAssetIndex(value: unknown): AssetIndex {
  if (!isRecord(value)) throw new Error('资产索引不是对象');
  if (value['v'] !== 1) throw new Error(`资产索引版本不受支持：${String(value['v'])}`);
  const deviceId = value['deviceId'];
  if (typeof deviceId !== 'string' || !isSafeAssetIndexDeviceId(deviceId)) throw new Error('资产索引的 deviceId 不合法');
  const updatedAt = value['updatedAt'];
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) throw new Error('资产索引的 updatedAt 不合法');
  const rawEntries = value['entries'];
  if (!Array.isArray(rawEntries)) throw new Error('资产索引的 entries 必须是数组');
  const entries: AssetIndexEntry[] = rawEntries.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`资产索引第 ${index + 1} 条不是对象`);
    const plain = entry['plain'];
    const cipher = entry['cipher'];
    const bytes = entry['bytes'];
    if (typeof plain !== 'string' || !HEX64.test(plain)) throw new Error(`资产索引第 ${index + 1} 条的 plain 不是 sha256`);
    if (typeof cipher !== 'string' || !HEX64.test(cipher)) {
      throw new Error(`资产索引第 ${index + 1} 条的 cipher 不是合法哈希（拒绝任何非哈希路径）`);
    }
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
      throw new Error(`资产索引第 ${index + 1} 条的 bytes 不合法`);
    }
    return { plain, cipher, bytes: Math.round(bytes) };
  });
  return { v: 1, deviceId, updatedAt, entries };
}

export interface EncodedAssetIndex {
  path: string;
  bytes: Uint8Array;
  hash: string;
}

/** 编码 + 发布用的路径（路径里的 hash8 来自整份字节的摘要）。 */
export async function encodeAssetIndex(
  index: AssetIndex,
  options: { ports: CryptoPorts; seq: number; encrypt?: boolean },
): Promise<EncodedAssetIndex> {
  const normalized = validateAssetIndex(index);
  if (normalized.deviceId !== index.deviceId) throw new Error('资产索引 deviceId 被规范化改动了');
  const inner = JSON.stringify(normalized);
  const bytes = await encodeEnvelope(inner, {
    ports: options.ports,
    encrypt: options.encrypt === true,
    aad: assetIndexAad(normalized.deviceId),
    sign: (contentHash) => assetIndexSignaturePayload(normalized.deviceId, options.seq, contentHash),
  });
  const hash = toHex(await options.ports.digest.sha256(bytes));
  return { path: assetIndexPath(normalized.deviceId, options.seq, hash), bytes, hash };
}

export interface DecodedAssetIndex {
  index: AssetIndex;
  contentHash: string;
  envelope: Envelope;
}

/**
 * 解码一份索引。
 *
 * 必须知道它**应该属于哪台设备/哪个序号**（调用方从路径反解）：
 * AAD 与签名都绑定这两项；对不上就拒绝，避免把 A 设备的索引当成 B 的。
 * `requireSignature` 默认 false：旧索引/无密钥环境没有签名也要能读（与 envelope 的双读策略一致）。
 */
export async function decodeAssetIndex(
  bytes: Uint8Array,
  options: { ports: CryptoPorts; deviceId: string; seq: number; requireSignature?: boolean },
): Promise<DecodedAssetIndex> {
  const decoded = await decodeEnvelope(bytes, { ports: options.ports, aad: assetIndexAad(options.deviceId) });
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.inner);
  } catch (error) {
    throw new Error(`资产索引不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  const index = validateAssetIndex(parsed);
  if (index.deviceId !== options.deviceId) {
    throw new Error(`资产索引归属设备 ${index.deviceId} 与路径上的 ${options.deviceId} 不符`);
  }
  await verifyEnvelope(decoded.envelope, {
    ports: options.ports,
    contentHash: decoded.contentHash,
    payload: assetIndexSignaturePayload(index.deviceId, options.seq, decoded.contentHash),
    signerDeviceId: index.deviceId,
    requireSignature: options.requireSignature === true,
  });
  return { index, contentHash: decoded.contentHash, envelope: decoded.envelope };
}
