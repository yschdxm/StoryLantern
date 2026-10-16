import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createFolderBackend } from '../plugins/sync-folder/src/index.ts';
import { runTwoPeers } from './sync-two-peers.mjs';

/**
 * **真实 SMB 共享**上的同步实测（板子 = 开发板，走这台 Windows 已有的映射盘）。
 *
 * 更正第七十一节的一个错判：当时我只查了板上的 `/etc/samba/smb.conf`（里面只有只读的 `[homes]`），
 * 就写下"板上没有可写共享"。**错了** —— 这台电脑本来就映射着两个共享：
 *
 *   Y:  \\quarkpi-ca2\sata     OK
 *   Z:  \\quarkpi-ca2\webdav   OK   ← Z:\agent 就是板上 /mnt/nvme/agent
 *
 * 那些共享由板上的宝塔面板管理，不在我读的那个文件里。所以这条实测用**产品里的文件夹后端**
 * （`plugins/sync-folder` 的 `createFolderBackend`，与"同步到本地文件夹"是同一份代码）指向映射盘 ——
 * 这正是计划里写的 SMB 路线："系统挂载 + 文件夹后端"。
 *
 * 用法：
 *   node scripts/sync-real-smb.mjs
 *   SMB_BASE='Y:\agent' node scripts/sync-real-smb.mjs      # 换一个共享/目录
 *   SMB_KEEP=1 node scripts/sync-real-smb.mjs               # 保留测试目录
 */

const BASE = process.env.SMB_BASE ?? 'Z:\\agent';
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const ROOT = path.join(BASE, `storylantern-smb-test-${STAMP}`);
const KEEP = process.env.SMB_KEEP === '1';

const backend = createFolderBackend({ root: ROOT });

function human(bytes) {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

try {
  console.log(`  [真 SMB] 共享目录=${BASE} 测试目录=${ROOT}`);
  const info = await stat(BASE);
  console.log(`  [真 SMB] 基目录可访问 ✓（isDirectory=${info.isDirectory()}）`);

  const result = await runTwoPeers({
    backend,
    label: 'real-smb',
    noDisk: true,
    // 远端不在本机（是网络盘）：体积与清单都通过后端自己问 —— 而这就是产品后端自己的 list
    remoteFiles: async (prefix) => (await backend.list(prefix)).entries,
  });

  const snapshots = (await backend.list('snapshots/')).entries.sort((left, right) => left.size - right.size);
  const segments = (await backend.list('logs/')).entries;
  const devices = (await backend.list('devices/')).entries;
  const sum = (list) => list.reduce((total, entry) => total + entry.size, 0);
  console.log(
    `  [真 SMB] 共享盘上落盘：快照 ${snapshots.length} 份 / ${human(sum(snapshots))}` +
      `（最小 ${human(snapshots[0]?.size ?? 0)}、最大 ${human(snapshots[snapshots.length - 1]?.size ?? 0)}）` +
      `、段 ${segments.length} 个 / ${human(sum(segments))}、设备清单 ${devices.length} 份`,
  );

  const ok = result.converged && result.brokenChain.ok && snapshots.length > 0;
  console.log(
    `  [真 SMB] 结论：两个对端消息一致=${result.converged}、断链回退=${result.brokenChain.ok}` +
      `、快照链份数=${result.snapshotCount} → ${ok ? '通过' : '**未通过**'}`,
  );
  if (!ok) process.exitCode = 1;
} catch (error) {
  console.error(`  [真 SMB] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (KEEP) {
    console.log(`  [真 SMB] 保留测试目录（SMB_KEEP=1）：${ROOT}`);
  } else {
    try {
      await rm(ROOT, { recursive: true, force: true });
      console.log('  [真 SMB] 已清理测试目录');
    } catch {
      console.log(`  [真 SMB] 清理失败，请手动删除：${ROOT}`);
    }
  }
}
