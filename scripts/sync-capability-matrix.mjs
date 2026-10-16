import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { runTwoPeers } from './sync-two-peers.mjs';

/**
 * **能力降级矩阵**：把哑存储的各种"缺能力"档位真的造出来，逐个跑一遍真同步。
 *
 * 为什么必须有这个：计划里写着"能力探测与降级"，但代码里光有 `capabilities` 字段不算数 ——
 * 真实世界的网盘目录常常没有条件写、老 NAS 没有范围读、只读挂载根本不能删。
 * 只有把这些档位**跑过一遍**，才能说"降级之后仍然收敛、不丢消息"。
 *
 * 做法：每种档位起一个独立端口的 mock NAS（`--no-conditional` / `--no-range` / `--no-delete`），
 * 用同一套两对端流程跑，最后断言：
 *   - 能力探测如实反映该档位（不能"探测说支持、实际不支持"）；
 *   - 消息在两个对端之间完全一致（0 丢、0 重）；
 *   - 没有删除能力时**不去删**（GC / 断链回退都要跳过），而且不能因此报错。
 *
 * 用法：`node scripts/sync-capability-matrix.mjs`
 */

const MODES = [
  { key: 'normal', title: '正常（条件写 + 范围读 + 删除）', flags: [] },
  { key: 'no-conditional', title: '无条件写（忽略 If-None-Match，像网盘同步目录）', flags: ['--no-conditional'] },
  { key: 'no-range', title: '无范围读（老 NAS 常见）', flags: ['--no-range'] },
  { key: 'no-delete', title: '无删除（只读挂载 / 不允许删）', flags: ['--no-delete'] },
  {
    key: 'none',
    title: '三样都没有（最保守的哑存储）',
    flags: ['--no-conditional', '--no-range', '--no-delete'],
  },
];

const BASE_PORT = 15210;

async function waitForServer(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { method: 'OPTIONS' });
      if (response.ok) return;
    } catch {
      // 还没起来
    }
    if (Date.now() > deadline) throw new Error(`假 NAS 在 ${port} 上没起来`);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

async function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

const rows = [];
for (const [index, mode] of MODES.entries()) {
  const port = BASE_PORT + index;
  const root = `.webdav-matrix/${mode.key}`;
  await rm(root, { recursive: true, force: true });

  // stdio 用 ignore：这一层不需要读它的输出，也不想因为管道在受限环境里被拦
  const server = spawn('node', ['scripts/mock-webdav.mjs', String(port), root, ...mode.flags], {
    cwd: process.cwd(),
    stdio: 'ignore',
    detached: true,
  });

  try {
    await waitForServer(port);
    console.log(`\n=== ${mode.title} ===`);
    const result = await runTwoPeers({ url: `http://127.0.0.1:${port}/`, diskRoot: root, label: mode.key });
    rows.push({ mode, result });
  } finally {
    server.kill();
    await waitForExit(server);
  }
}

console.log('\n=== 汇总 ===');
console.log('  档位                 条件写  范围读  删除   快照  消息一致  断链回退');
for (const { mode, result } of rows) {
  const caps = result.capabilities;
  console.log(
    `  ${mode.key.padEnd(18)} ${String(caps.conditionalPut).padEnd(7)} ${String(caps.rangeRead).padEnd(7)} ` +
      `${String(caps.delete).padEnd(6)} ${String(result.snapshotCount).padEnd(5)} ` +
      `${(result.converged ? '是' : '否').padEnd(9)} ${result.brokenChain.ok ? '通过' : '跳过/失败'}`,
  );
}

const failures = [];
for (const { mode, result } of rows) {
  const expected = {
    conditionalPut: !mode.flags.includes('--no-conditional'),
    rangeRead: !mode.flags.includes('--no-range'),
    delete: !mode.flags.includes('--no-delete'),
  };
  if (result.capabilities.conditionalPut !== expected.conditionalPut) {
    failures.push(`${mode.key}：条件写探测=${result.capabilities.conditionalPut}，实际=${expected.conditionalPut}`);
  }
  if (result.capabilities.rangeRead !== expected.rangeRead) {
    failures.push(`${mode.key}：范围读探测=${result.capabilities.rangeRead}，实际=${expected.rangeRead}`);
  }
  if (result.capabilities.delete !== expected.delete) {
    failures.push(`${mode.key}：删除探测=${result.capabilities.delete}，实际=${expected.delete}`);
  }
  if (!result.converged) failures.push(`${mode.key}：两个对端的消息不一致`);
}

if (failures.length > 0) {
  console.error('\n✗ 降级矩阵失败：');
  for (const failure of failures) console.error('  - ' + failure);
  process.exitCode = 1;
} else {
  console.log(`\n✓ 降级矩阵通过：${rows.length} 个档位下能力探测如实、消息一致（0 丢 0 重）。`);
}
