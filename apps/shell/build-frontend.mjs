#!/usr/bin/env node
/**
 * 构建前端产物（apps/app → apps/app/dist）。
 *
 * 为什么不用 `pnpm --filter @storylantern/app build`：
 * 在本机沙箱里 pnpm 启动子进程会挂住（stdio 管道受限），而 Tauri 的 beforeBuildCommand
 * 必须可靠返回。这里直接用 node 跑 vite 的可执行入口，行为等价但不依赖包管理器。
 *
 * stdio: 'inherit' 是刻意的——受限环境下管道式 stdio 会 EPERM。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const viteEntry = fileURLToPath(new URL('../../node_modules/vite/bin/vite.js', import.meta.url));
const appDir = fileURLToPath(new URL('../app/', import.meta.url));

// `--watch` 给 dev 用：起 vite 开发服务器（不退出），交给 Tauri 的 devUrl 连接。
const mode = process.argv.includes('--watch') ? 'dev' : 'build';
const result = spawnSync(process.execPath, [viteEntry, mode], { cwd: appDir, stdio: 'inherit' });
if (result.error) {
  console.error(`前端构建失败：${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
