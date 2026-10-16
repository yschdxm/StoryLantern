import { createSafFolderBackend } from '../saf-folder.ts';
import { pickSafFolder } from '../saf.ts';
import { createBackupPorts } from '../backup-ports.ts';
import type { BackupPorts } from '../../../../../packages/oplog/src/backup.ts';

/**
 * 「导出全部为一个文件」与**恢复**的编排（M6 §8.10 的最后两格）。
 *
 * 为什么单独一个文件：`main.tsx` 已经贴着"每文件 400 行"的门禁上限，而这段编排与界面无关 ——
 * 它做的事只有"让用户选一个目录，然后往那儿写 / 从那儿读"。
 *
 * 两条刻意的设计：
 *  - 走**系统选择器**（SAF），不走宿主的私有目录：宿主 `files.*` 的根**就是**同步目录，
 *    而计划里明确要求这份备份"与同步目录无关"（"远端 op 日志不是 SQLite 备份"）；
 *  - 恢复**不是覆盖导入**：op 日志 append-only 且 opId 幂等，所以恢复只是"把本地还没有的 op 补进来"，
 *    并且照实报出"共 N 条、新导入 M 条、已存在 K 条"。
 */

type FolderBridge = Parameters<typeof createSafFolderBackend>[0];

export interface BackupAdminDeps {
  bridge: FolderBridge;
  exportBackup?(ports: BackupPorts): Promise<Uint8Array>;
  importBackup?(
    bytes: Uint8Array,
    ports: BackupPorts,
  ): Promise<{ total: number; applied: number; duplicates: number }>;
}

export interface BackupAdmin {
  exportBackup?(): Promise<{ ok: true; name: string } | { ok: false; error: string }>;
  importBackup?(): Promise<
    | { ok: true; name: string; total: number; applied: number; duplicates: number }
    | { ok: false; error: string }
  >;
}

const NEEDS_PICKER = '这条操作目前需要手机上的系统选择器（桌面端还没接）';
void NEEDS_PICKER;
export function createBackupAdmin(deps: BackupAdminDeps): BackupAdmin {
  const bridge = deps.bridge;

  const exportBackup: BackupAdmin['exportBackup'] =
    deps.exportBackup === undefined
      ? undefined
      : async () => {
          const picked = await pickSafFolder(bridge);
          if ('error' in picked) return { ok: false as const, error: picked.error };
          const bytes = await deps.exportBackup!(createBackupPorts());
          const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
          const name = `storylantern-backup-${stamp}.slbak`;
          const written = await createSafFolderBackend(bridge).put(name, bytes, { ifNoneMatch: true });
          if (!written.ok && written.exists !== true) return { ok: false as const, error: '写入所选目录失败' };
          return { ok: true as const, name };
        };

  const importBackup: BackupAdmin['importBackup'] =
    deps.importBackup === undefined
      ? undefined
      : async () => {
          const picked = await pickSafFolder(bridge);
          if ('error' in picked) return { ok: false as const, error: picked.error };
          // 导出名带时间戳，所以字典序就是时间序：取最后一个就是最新的那份
          const candidates = (await createSafFolderBackend(bridge).list('')).entries
            .filter((entry) => entry.path.endsWith('.slbak'))
            .sort((left, right) => left.path.localeCompare(right.path));
          const newest = candidates[candidates.length - 1];
          if (newest === undefined) return { ok: false as const, error: '这个目录里没有 .slbak 备份文件' };
          const bytes = await createSafFolderBackend(bridge).get(newest.path);
          const result = await deps.importBackup!(bytes, createBackupPorts());
          return { ok: true as const, name: newest.path, ...result };
        };

  return {
    ...(exportBackup === undefined ? {} : { exportBackup }),
    ...(importBackup === undefined ? {} : { importBackup }),
  };
}

export const BACKUP_NEEDS_PICKER = NEEDS_PICKER;
