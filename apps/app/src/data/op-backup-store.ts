import type { Op } from '../../../../packages/oplog/src/op.ts';
import { createBackup, type BackupPorts } from '../../../../packages/oplog/src/backup.ts';

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
