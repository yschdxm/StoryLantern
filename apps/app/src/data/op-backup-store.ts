import type { Op } from '../../../../packages/oplog/src/op.ts';
import {
  createBackup,
  readBackup,
  type BackupAsset,
  type BackupHeader,
  type BackupPorts,
} from '../../../../packages/oplog/src/backup.ts';
import { getAssetClient } from './asset-client.ts';

/**
 * 「导出全部为一个文件」的适配器。
 *
 * 单独一个文件的原因有两条：一是 `op-repository.ts` 已经贴着"每文件 400 行"的门禁上限（该拆了），
 * 二是这件事本身就自成一件事 —— 它把**整份 op 日志 + 本机整个资产库**打成一个自包含文件，
 * 与同步、与物化状态都无关（计划里专门写明"远端 op 日志**不是** SQLite 备份"）。
 *
 * 依赖只有三样：读全部 op、这台设备的 id（写进备份头）、以及本机资产库。
 *
 * **备份包含整个本机资产库，不只被卡片引用的图片**（"整份数据"的语义）：
 * 大图多时文件会大，但恢复后不会出现"卡片在、图没了"。拿不到的资产会**跳过并计数**，
 * 计数通过 `createBackupExporterWithStats` 暴露（原有 `createBackupExporter` 签名不变）。
 */
export interface BackupExporterDeps {
  loadAll(): Promise<Op[]>;
  deviceId?: string;
}

export interface BackupExportResult {
  bytes: Uint8Array;
  /** 真正写进备份的资产数。 */
  assets: number;
  /** 列表里有、但这次取不到（或 hash 不合法）而跳过的资产数。 */
  assetsSkipped: number;
}

const ASSET_HASH = /^[0-9a-f]{64}$/i;

export function createBackupExporterWithStats(
  deps: BackupExporterDeps,
): (ports: BackupPorts) => Promise<BackupExportResult> {
  return async (ports) => {
    const ops = await deps.loadAll();
    const client = getAssetClient();
    // 排序只为让"同一份资产库"导出的文件内容稳定（便于核对/去重），不是格式要求。
    const hashes = [...(await client.list())].sort();
    const assets: BackupAsset[] = [];
    let skipped = 0;
    for (const hash of hashes) {
      if (!ASSET_HASH.test(hash)) {
        skipped += 1;
        continue;
      }
      const bytes = await client.get(hash).catch(() => undefined);
      if (bytes === undefined) {
        skipped += 1;
        continue;
      }
      assets.push({ hash, bytes });
    }
    const file = await createBackup(ops, {
      ports,
      createdAt: Date.now(),
      ...(deps.deviceId === undefined ? {} : { deviceId: deps.deviceId }),
      assets,
    });
    return { bytes: file, assets: assets.length, assetsSkipped: skipped };
  };
}

/** 原有签名：只要字节。需要"跳过了几张"时用 `createBackupExporterWithStats`。 */
export function createBackupExporter(deps: BackupExporterDeps): (ports: BackupPorts) => Promise<Uint8Array> {
  const withStats = createBackupExporterWithStats(deps);
  return async (ports) => (await withStats(ports)).bytes;
}

/**
 * **恢复**备份：把备份里的 op 追加进事实源，并把图片写回本机资产库。
 *
 * 为什么恢复等于"追加"而不是"替换"：op 日志是 append-only，且 **opId 幂等** ——
 * 所以重复导入同一份备份是安全的（第二次几乎全是重复项，状态不变），
 * 导入一份"别人导出的"备份也只是把里面**本地没有的** op 补进来。
 *
 * 资产是内容寻址的（put 返回实际 hash），所以写回前要**校验返回 hash 与条目 hash 一致**：
 * 不一致说明字节/实现有问题，跳过并计数（不静默、也不把错图塞进库里）。
 */
export interface BackupImporterDeps {
  appendAndApply(ops: Op[]): Promise<void>;
  knownOpIds(): Promise<Set<string>>;
}

export interface BackupImportResult {
  header: BackupHeader;
  total: number;
  applied: number;
  duplicates: number;
  /** 成功写回本机资产库的资产数。 */
  assets: number;
  /** 校验失败 / 写入失败的资产数（已如实计数，界面要显示）。 */
  assetsSkipped: number;
}

/**
 * 一次追加多少条。
 *
 * 这个数字是**真机逼出来的**：宿主对 `ops.append` 有"一次最多 5000 条"的限制，
 * 而一份真实日志有 3 万多条 op —— 第一次在手机上点恢复，界面直接报
 * 「一次最多追加 5000 条 op，收到 30313」。分批是必须的，不是优化。
 * 取 1000 而不是 5000：留余量，且分批后单批失败的影响面更小。
 */
const IMPORT_CHUNK = 1000;

export function createBackupImporter(
  deps: BackupImporterDeps,
): (bytes: Uint8Array, ports: BackupPorts) => Promise<BackupImportResult> {
  return async (bytes, ports) => {
    const { header, ops, assets } = await readBackup(bytes, { ports });
    // 先写回资产（内容寻址、幂等：同一张图重复写没有副作用），再追加 op。
    const client = getAssetClient();
    let restoredAssets = 0;
    let skippedAssets = 0;
    for (const asset of assets) {
      try {
        const hash = await client.put(asset.bytes);
        if (hash.toLowerCase() === asset.hash) restoredAssets += 1;
        else skippedAssets += 1;
      } catch {
        // 单张资产写不进去不该让整份恢复失败；但必须计数，由界面照实说"跳过了几张"。
        skippedAssets += 1;
      }
    }
    const known = await deps.knownOpIds();
    const fresh = ops.filter((op) => !known.has(op.opId));
    // 全部交给事实源：幂等由 opId 保证，这里不自己挑挑拣拣（少一条判断就少一处能出错的地方）。
    // 必须**分批**：宿主的 append 有单次条数上限（见上）。
    for (let start = 0; start < ops.length; start += IMPORT_CHUNK) {
      await deps.appendAndApply(ops.slice(start, start + IMPORT_CHUNK));
    }
    return {
      header,
      total: ops.length,
      applied: fresh.length,
      duplicates: ops.length - fresh.length,
      assets: restoredAssets,
      assetsSkipped: skippedAssets,
    };
  };
}
