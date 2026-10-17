import { toHex, utf8 } from './bytes.ts';
import type { Op } from './op.ts';
import type { Compressor, Digest } from './ports.ts';

/**
 * 「导出全部为一个文件」的整体备份。
 *
 * 计划里的两句话决定了它的形状：
 *  - "**独立提供**'导出全部为一个文件'整体备份；建议至少一台设备保留完整历史" →
 *    备份的是 **op 日志**（唯一事实源），所以恢复 = 重放，不需要别的黑魔法；
 *  - "远端 op 日志**不是** SQLite 备份" → 因此这个文件与同步目录**无关**：
 *    它是自包含的（魔数 + 版本 + 条目数 + 内容摘要 + 压缩体），拿到它就能在没有远端的情况下重建。
 *
 * 格式（与段编解码同构，复用同一套端口）：
 *
 * ```
 * SLBAK1\n
 * {"v":2,"createdAt":…,"opCount":…,"assetCount":…,"compression":"gzip","digest":"…"}\n
 * <前 opCount 行：每行一个 JSON op；之后 assetCount 行：{"asset":"<64hex>","data":"<base64>"}>
 * ```
 *
 * 整个文本**一次压缩**；摘要覆盖 `头（digest 置空） + "\n" + 主体` —— 把 digest 字段排除在摘要之外，
 * 是为了避免"摘要算摘要"的循环。任何一处不对劲都明确失败，绝不返回半个 op 列表。
 *
 * 版本兼容：v1（只有 op、头里没有 assetCount）仍能读，`assets` 返回空数组；
 * v2 的 `assetCount` 缺省按 0 处理（但 body 行数必须严格等于 opCount + assetCount）。
 * 魔数、压缩算法与摘要口径**没有变**，所以 v1 文件的摘要照旧对得上。
 */

/**
 * 备份只需要两件事：内容摘要与压缩。**不要求整个 CryptoPorts** —— 备份不签名也不加密
 * （它是用户自己保管的整份数据，不是要放进哑存储的段），伪造一个 hmac 端口只会让人误会。
 */
export interface BackupPorts {
  digest: Pick<Digest, 'sha256'>;
  compressor: Compressor;
}

export const BACKUP_MAGIC = 'SLBAK1';
export const BACKUP_VERSION = 2;

/** 兼容读取的版本：v1 = 只有 op；v2 = op + 资产。 */
const READABLE_VERSIONS: readonly number[] = [1, 2];

export class BackupError extends Error {
  readonly reason: 'format' | 'version' | 'digest' | 'algorithm';

  constructor(reason: 'format' | 'version' | 'digest' | 'algorithm', message: string) {
    super(message);
    this.name = 'BackupError';
    this.reason = reason;
  }
}

/** 备份里的一个二进制资产（图片等）：内容寻址，hash 是明文字节的 sha256。 */
export interface BackupAsset {
  hash: string;
  bytes: Uint8Array;
}

export interface BackupHeader {
  v: number;
  createdAt: number;
  opCount: number;
  /** v2 起有：body 里资产行的条数。v1 读出时归一化为 0。 */
  assetCount: number;
  compression: string;
  digest: string;
  deviceId?: string;
}

export interface CreateBackupInput {
  ports: BackupPorts;
  createdAt: number;
  deviceId?: string;
  /** 本机整个资产库（不只被卡片引用的）：备份是"整份数据"，所以图片也一起带走。 */
  assets?: ReadonlyArray<BackupAsset>;
}

/** 摘要的输入：头（digest 置空）+ 换行 + 主体。写与读用的是同一个函数，避免两边算错。 */
async function digestOf(header: BackupHeader, body: string, ports: BackupPorts): Promise<string> {
  const canonical = `${JSON.stringify({ ...header, digest: '' })}\n${body}`;
  return toHex(await ports.digest.sha256(utf8(canonical)));
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

/** 资产行必须能**单独**解码；坏行是 format 错误，不是"跳过这一张"。 */
function parseAssetLine(line: string, index: number): BackupAsset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    throw new BackupError(
      'format',
      `第 ${index} 条资产解析失败：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object') throw new BackupError('format', `第 ${index} 条资产不是对象`);
  const record = parsed as Record<string, unknown>;
  const hash = record['asset'];
  const data = record['data'];
  if (typeof hash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hash)) {
    throw new BackupError('format', `第 ${index} 条资产缺少合法的 asset sha256`);
  }
  if (typeof data !== 'string') throw new BackupError('format', `第 ${index} 条资产缺少 base64 data`);
  try {
    return { hash: hash.toLowerCase(), bytes: fromBase64(data) };
  } catch (cause) {
    throw new BackupError(
      'format',
      `第 ${index} 条资产 base64 解码失败：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/** 把一串 op（以及本机资产）打成**一个**自包含字节文件。空日志也是合法的备份。 */
export async function createBackup(ops: readonly Op[], input: CreateBackupInput): Promise<Uint8Array> {
  const assets = input.assets ?? [];
  const lines = [
    ...ops.map((op) => JSON.stringify(op)),
    ...assets.map((asset) => JSON.stringify({ asset: asset.hash.toLowerCase(), data: toBase64(asset.bytes) })),
  ];
  const body = lines.join('\n');
  const header: BackupHeader = {
    v: BACKUP_VERSION,
    createdAt: input.createdAt,
    opCount: ops.length,
    assetCount: assets.length,
    compression: input.ports.compressor.algorithm,
    digest: '',
    ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
  };
  const finalHeader: BackupHeader = { ...header, digest: await digestOf(header, body, input.ports) };
  return input.ports.compressor.compress(utf8(`${BACKUP_MAGIC}\n${JSON.stringify(finalHeader)}\n${body}`));
}

/** 读回备份：解压 → 校验魔数/版本/压缩算法/摘要/条数 → 返回 op 与资产。 */
export async function readBackup(
  bytes: Uint8Array,
  options: { ports: BackupPorts },
): Promise<{ header: BackupHeader; ops: Op[]; assets: BackupAsset[] }> {
  let raw: Uint8Array;
  try {
    raw = await options.ports.compressor.decompress(bytes);
  } catch (cause) {
    // 真机上验到过这条：选到一个不是备份的文件时，底层会丢出英文的 zlib 报错（"incorrect header check"）。
    // 中文用户看不懂那半截，所以把**可能的原因**补在前面，底层原因照旧带上（不吞）。
    throw new BackupError(
      'format',
      `备份解压失败：文件不是有效的 .slbak，或在传输中损坏（底层原因：${cause instanceof Error ? cause.message : String(cause)}）`,
    );
  }
  const text = new TextDecoder().decode(raw);

  const firstBreak = text.indexOf('\n');
  if (firstBreak < 0) throw new BackupError('format', '备份缺少头行');
  const magic = text.slice(0, firstBreak);
  if (magic !== BACKUP_MAGIC) throw new BackupError('format', `备份魔数不符：${magic.slice(0, 16)}`);

  const secondBreak = text.indexOf('\n', firstBreak + 1);
  if (secondBreak < 0) throw new BackupError('format', '备份缺少头信息');
  let header: BackupHeader;
  try {
    // 注意：**用原样的头**算摘要（v1 头里没有 assetCount，补字段会改变摘要输入）。
    header = JSON.parse(text.slice(firstBreak + 1, secondBreak)) as BackupHeader;
  } catch (cause) {
    throw new BackupError('format', `备份头解析失败：${cause instanceof Error ? cause.message : String(cause)}`);
  }

  if (!READABLE_VERSIONS.includes(header.v)) throw new BackupError('version', `不支持的备份版本：${header.v}`);
  if (header.compression !== options.ports.compressor.algorithm) {
    throw new BackupError(
      'algorithm',
      `备份用的压缩算法是 ${header.compression}，这台设备是 ${options.ports.compressor.algorithm}`,
    );
  }

  const body = text.slice(secondBreak + 1);
  if ((await digestOf(header, body, options.ports)) !== header.digest) {
    throw new BackupError('digest', '备份内容与摘要不符（文件被改过、或没传完）');
  }

  if (header.v === 1) {
    // v1：body 全是 op 行；旧实现会忽略空行，这里保持同样的宽容（否则老备份读不了）。
    const ops: Op[] = [];
    for (const line of body.split('\n')) {
      if (line.trim() === '') continue;
      try {
        ops.push(JSON.parse(line) as Op);
      } catch (cause) {
        throw new BackupError(
          'format',
          `第 ${ops.length + 1} 条 op 解析失败：${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
    if (ops.length !== header.opCount) {
      throw new BackupError('format', `备份声称 ${header.opCount} 条 op，实际读到 ${ops.length} 条`);
    }
    return { header: { ...header, assetCount: 0 }, ops, assets: [] };
  }

  // v2：前 opCount 行 op、后 assetCount 行资产；行数严格对账。
  const rawAssetCount = header.assetCount;
  if (rawAssetCount !== undefined && (!Number.isInteger(rawAssetCount) || rawAssetCount < 0)) {
    throw new BackupError('format', `备份的 assetCount 不合法：${String(rawAssetCount)}`);
  }
  const assetCount = typeof rawAssetCount === 'number' ? rawAssetCount : 0;
  if (!Number.isInteger(header.opCount) || header.opCount < 0) {
    throw new BackupError('format', `备份的 opCount 不合法：${String(header.opCount)}`);
  }
  const lines = body === '' ? [] : body.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const expected = header.opCount + assetCount;
  if (lines.length !== expected) {
    throw new BackupError(
      'format',
      `备份声称 ${header.opCount} 条 op + ${assetCount} 条资产，实际读到 ${lines.length} 行`,
    );
  }
  const ops: Op[] = [];
  for (let index = 0; index < header.opCount; index += 1) {
    const line = lines[index] as string;
    try {
      ops.push(JSON.parse(line) as Op);
    } catch (cause) {
      throw new BackupError(
        'format',
        `第 ${index + 1} 条 op 解析失败：${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  const assets: BackupAsset[] = [];
  for (let index = 0; index < assetCount; index += 1) {
    assets.push(parseAssetLine(lines[header.opCount + index] as string, index + 1));
  }
  return { header: { ...header, assetCount }, ops, assets };
}
