import { createFtpHarnessBackend } from './ftp-harness-backend.mjs';
import { runTwoPeers } from './sync-two-peers.mjs';

/**
 * **真实 FTP 服务端**上的同步实测（板子 = 开发板，pure-ftpd）。
 *
 * 与 SMB 那一条的区别要说清：SMB 用的是**产品里的文件夹后端**；FTP 用的是**验证夹具** ——
 * 因为产品里**没有** FTP 后端（计划第 ⑤ 条：宿主只有通用 HTTP 与受限文件 IO、没有裸 TCP，
 * 而 FTPS 又要 TLS 与零依赖冲突，于是如实记成"评估后不做"）。
 * 所以这条只证明"真实 FTP 服务端这一层能跑通同步协议"，**不能**读成"app 支持 FTP"。
 *
 * 账号是临时建的（`pure-pw useradd sltest`，chroot 到测试目录），跑完由调用方删掉；
 * 口令只存在于 `FTP_NETRC` 指向的文件里（仓库外），命令行上不出现。
 *
 * 用法：
 *   FTP_NETRC=<netrc 路径> node scripts/sync-real-ftp.mjs
 *   FTP_ROOT=storylantern-ftp-test FTP_KEEP=1 …
 */

/**
 * `FTP_ROOT` 默认是**空**：因为板上那个临时账号被 pure-ftpd **chroot 进了测试目录**
 * （`pure-pw show sltest` 里 `Directory : …/storylantern-ftp-test/./`），
 * 所以 FTP 会话里的 `/` **就是**测试目录，再带一层同名前缀只会写到不存在的子目录里去。
 * （第一版就是这么错的：PUT 一直 550，只是我没看返回码；诊断时才发现文件从来没落盘。）
 */
const ROOT = process.env.FTP_ROOT ?? '';
const KEEP = process.env.FTP_KEEP === '1';

const backend = createFtpHarnessBackend({ root: ROOT });

function human(bytes) {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

try {
  console.log(`  [真 FTP] 宿主机=${process.env.FTP_HOST ?? 'quarkpi-ca2.local'} 远端目录=${ROOT}/`);
  const result = await runTwoPeers({
    backend,
    label: 'real-ftp',
    noDisk: true,
    remoteFiles: async (prefix) => (await backend.list(prefix)).entries,
  });

  const snapshots = (await backend.list('snapshots/')).entries.sort((left, right) => left.size - right.size);
  const segments = (await backend.list('logs/')).entries;
  const sum = (list) => list.reduce((total, entry) => total + entry.size, 0);
  console.log(
    `  [真 FTP] 服务器上落盘：快照 ${snapshots.length} 份 / ${human(sum(snapshots))}` +
      `（最小 ${human(snapshots[0]?.size ?? 0)}、最大 ${human(snapshots[snapshots.length - 1]?.size ?? 0)}）` +
      `、段 ${segments.length} 个 / ${human(sum(segments))}`,
  );

  const ok = result.converged && result.brokenChain.ok && snapshots.length > 0;
  console.log(
    `  [真 FTP] 结论：两个对端消息一致=${result.converged}、断链回退=${result.brokenChain.ok}` +
      `、快照链份数=${result.snapshotCount} → ${ok ? '通过' : '**未通过**'}`,
  );
  if (!ok) process.exitCode = 1;
} catch (error) {
  console.error(`  [真 FTP] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  // FTP 里删一整棵树太啰嗦：测试目录与临时账号由调用方用 SSH 清掉（见文档第七十九节）
  console.log(KEEP ? '  [真 FTP] 保留远端目录（FTP_KEEP=1）' : '  [真 FTP] 远端目录由调用方清理（账号与目录一起删）');
  backend.dispose();
}
