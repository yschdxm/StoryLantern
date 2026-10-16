import { toHex, utf8 } from './bytes.ts';
import type { Op } from './op.ts';
import type { CryptoPorts } from './ports.ts';

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
 * {"v":1,"createdAt":…,"opCount":…,"compression":"gzip","digest":"…"}\n
 * <每行一个 JSON op 的主体>
 * ```
 *
 * 整个文本**一次压缩**；摘要覆盖 `头（digest 置空） + "\n" + 主体` —— 把 digest 字段排除在摘要之外，
 * 是为了避免"摘要算摘要"的循环。任何一处不对劲都明确失败，绝不返回半个 op 列表。
 */

export const BACKUP_MAGIC = 'SLBAK1';
export const BACKUP_VERSION = 1;

export class BackupError extends Error {
  readonly reason: 'format' | 'version' | 'digest' | 'algorithm';

  constructor(reason: 'format' | 'version' | 'digest' | 'algorithm', message: string) {
    super(message);
    this.name = 'BackupError';
    this.reason = reason;
  }
}

export interface BackupHeader {
  v: number;
  createdAt: number;
  opCount: number;
  compression: string;
  digest: string;
  deviceId?: string;
}

export interface CreateBackupInput {
  ports: CryptoPorts;
  createdAt: number;
  deviceId?: string;
}

/** 摘要的输入：头（digest 置空）+ 换行 + 主体。写与读用的是同一个函数，避免两边算错。 */
async function digestOf(
  header: BackupHeader,
  body: string,
  ports: CryptoPorts,
): Promise<string> {
  const canonical = `${JSON.stringify({ ...header, digest: '' })}\n${body}`;
  return toHex(await ports.digest.sha256(utf8(canonical)));
}

/** 把一串 op 打成**一个**自包含字节文件。空日志也是合法的备份（恢复出来就是空）。 */
export async function createBackup(ops: readonly Op[], input: CreateBackupInput): Promise<Uint8Array> {
  const body = ops.map((op) => JSON.stringify(op)).join('\n');
  const header: BackupHeader = {
    v: BACKUP_VERSION,
    createdAt: input.createdAt,
    opCount: ops.length,
    compression: input.ports.compressor.algorithm,
    digest: '',
    ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
  };
  const finalHeader: BackupHeader = { ...header, digest: await digestOf(header, body, input.ports) };
  return input.ports.compressor.compress(utf8(`${BACKUP_MAGIC}\n${JSON.stringify(finalHeader)}\n${body}`));
}

/** 读回备份：解压 → 校验魔数/版本/压缩算法/摘要/条数 → 返回 op。 */
export async function readBackup(
  bytes: Uint8Array,
  options: { ports: CryptoPorts },
): Promise<{ header: BackupHeader; ops: Op[] }> {
  let raw: Uint8Array;
  try {
    raw = await options.ports.compressor.decompress(bytes);
  } catch (cause) {
    throw new BackupError('format', `备份解压失败：${cause instanceof Error ? cause.message : String(cause)}`);
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
    header = JSON.parse(text.slice(firstBreak + 1, secondBreak)) as BackupHeader;
  } catch (cause) {
    throw new BackupError('format', `备份头解析失败：${cause instanceof Error ? cause.message : String(cause)}`);
  }

  if (header.v !== BACKUP_VERSION) throw new BackupError('version', `不支持的备份版本：${header.v}`);
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
  return { header, ops };
}
