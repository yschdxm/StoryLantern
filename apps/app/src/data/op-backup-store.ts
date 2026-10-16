import type { Op } from '../../../../packages/oplog/src/op.ts';
import { createBackup, readBackup, type BackupHeader, type BackupPorts } from '../../../../packages/oplog/src/backup.ts';

/**
 * 「导出全部为一个文件」的适配器。
 *
 * 单独一个文件的原因有两条：一是 `op-repository.ts` 已经贴着"每文件 400 行"的门禁上限（该拆了），
 * 二是这件事本身就自成一件事 —— 它把**整份 op 日志**打成一个自包含文件，
 * 与同步、与物化状态都无关（计划里专门写明"远端 op 日志**不是** SQLite 备份"）。
 *
 * 依赖只有两样：读全部 op、以及这台设备的 id（写进备份头，便于日后核对"这是哪台机器导的"）。
 */
export interface BackupExporterDeps {
  loadAll(): Promise<Op[]>;
  deviceId?: string;
}

export function createBackupExporter(deps: BackupExporterDeps): (ports: BackupPorts) => Promise<Uint8Array> {
  return async (ports) =>
    createBackup(await deps.loadAll(), {
      ports,
      createdAt: Date.now(),
      ...(deps.deviceId === undefined ? {} : { deviceId: deps.deviceId }),
    });
}

/**
 * **恢复**备份：把备份里的 op 追加进事实源。
 *
 * 为什么恢复等于"追加"而不是"替换"：op 日志是 append-only，且 **opId 幂等** ——
 * 所以重复导入同一份备份是安全的（第二次几乎全是重复项，状态不变），
 * 导入一份"别人导出的"备份也只是把里面**本地没有的** op 补进来。
 *
 * "新导入几条 / 重复几条"是**算出来的**（先数一遍已有的 opId），不是猜的：
 * 界面上那句"导入了 N 条（其中 M 条已存在）"必须是真的。
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
    const { header, ops } = await readBackup(bytes, { ports });
    const known = await deps.knownOpIds();
    const fresh = ops.filter((op) => !known.has(op.opId));
    // 全部交给事实源：幂等由 opId 保证，这里不自己挑挑拣拣（少一条判断就少一处能出错的地方）。
    // 必须**分批**：宿主的 append 有单次条数上限（见上）。
    for (let start = 0; start < ops.length; start += IMPORT_CHUNK) {
      await deps.appendAndApply(ops.slice(start, start + IMPORT_CHUNK));
    }
    return { header, total: ops.length, applied: fresh.length, duplicates: ops.length - fresh.length };
  };
}
