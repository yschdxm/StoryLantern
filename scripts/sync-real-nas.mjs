import { runTwoPeers } from './sync-two-peers.mjs';
import { createSftpHarnessBackend } from './sftp-harness-backend.mjs';

/**
 * **真实第三方存储**上的同步实测（板子 = 开发板，真 NAS）。
 *
 * 为什么是 SFTP：这台板子确实是真 NAS（Samba + pure-ftpd + nvme/sata 大盘），但
 *   - 匿名 FTP 被拒（实测 530）；
 *   - Samba 只导出了只读的 [homes]，没有可写的自定义共享；
 *   - 而用户给的是 **SSH 密钥**。
 * 所以用 SFTP 这条已有的、零侵入的通路来验"真存储"这一层 —— 不动板子上的任何配置。
 *
 * 用法（默认在 `/mnt/nvme/agent/` 下建一个带时间戳的测试目录，跑完自动清理）：
 *   node scripts/sync-real-nas.mjs
 *   NAS_KEEP=1 node scripts/sync-real-nas.mjs    # 保留测试目录，便于自己去看落盘
 */

const HOST = process.env.NAS_HOST ?? '开发板';
const BASE = process.env.NAS_BASE ?? '/mnt/nvme/agent';
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const ROOT = `${BASE}/storylantern-sync-test-${STAMP}`;
const KEEP = process.env.NAS_KEEP === '1';

const backend = createSftpHarnessBackend({ root: ROOT });

function human(bytes) {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

try {
  console.log(`  [真 NAS] 宿主机=${HOST} 测试目录=${ROOT}`);
  backend.exec(`mkdir -p ${ROOT}`);
  const host = backend.exec('uname -n; uname -m; df -h /mnt/nvme | tail -1');
  console.log('  [真 NAS] 板子：' + host.trim().split('\n').join(' | '));

  const result = await runTwoPeers({
    backend,
    label: 'real-nas',
    noDisk: true,
    // 远端不在本机：体积改为向后端问（夹具的 list 是我们自己实现的，与 mock NAS 的 PROPFIND 不同）
    remoteFiles: async (prefix) => (await backend.list(prefix)).entries,
  });

  const snapshots = (await backend.list('snapshots/')).entries.sort((left, right) => left.size - right.size);
  const segments = (await backend.list('logs/')).entries;
  const snapshotBytes = snapshots.reduce((sum, entry) => sum + entry.size, 0);
  const segmentBytes = segments.reduce((sum, entry) => sum + entry.size, 0);
  console.log(
    `  [真 NAS] 远端落盘：快照 ${snapshots.length} 份 / ${human(snapshotBytes)}` +
      `（最小 ${human(snapshots[0]?.size ?? 0)}、最大 ${human(snapshots[snapshots.length - 1]?.size ?? 0)}）` +
      `、段 ${segments.length} 个 / ${human(segmentBytes)}`,
  );

  const ok = result.converged && result.brokenChain.ok && result.snapshotCount > 0;
  console.log(
    `  [真 NAS] 结论：两个对端消息一致=${result.converged}、断链回退=${result.brokenChain.ok}` +
      `、快照链份数=${result.snapshotCount} → ${ok ? '通过' : '**未通过**'}`,
  );
  if (!ok) process.exitCode = 1;
} catch (error) {
  console.error(`  [真 NAS] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (KEEP) {
    console.log(`  [真 NAS] 保留测试目录（NAS_KEEP=1）：${ROOT}`);
  } else {
    try {
      backend.exec(`rm -rf ${ROOT}`);
      console.log('  [真 NAS] 已清理测试目录');
    } catch {
      console.log(`  [真 NAS] 清理失败，请手动删除：${ROOT}`);
    }
  }
  backend.dispose();
}
