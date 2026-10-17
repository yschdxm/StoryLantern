#!/usr/bin/env node
/**
 * 前端产物体检：**浏览器包里不允许出现 Node 内置模块**。
 *
 * 为什么需要它：前端代码可以"静态看起来没问题"、打包也能过，但运行时在 WebView 里
 * 才炸（真实事故：`bytes.ts` import 了 `node:crypto`，真机上 ULID 生成抛
 * "(0, We.randomBytes) is not a function"，界面直接报错）。
 * 类型检查与单元测试都拦不住这类问题——只有看产物。
 *
 * 用法：node apps/shell/build-frontend.mjs && node scripts/check-bundle.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'apps', 'app', 'dist');

/** 允许出现的 Node 内置模块（目前的产物里一个都不该有）。 */
const FORBIDDEN = /(?:from|require\()\s*["']node:/g;
/** 单个 js 产物的体积上限（gzip 前）：超了说明有东西被整包打进来了。 */
const MAX_BYTES = 800 * 1024;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const info = statSync(DIST, { throwIfNoEntry: false });if (info === null || !info.isDirectory()) {
  console.error('✗ 找不到 apps/app/dist：先跑 node apps/shell/build-frontend.mjs');
  process.exit(1);
}

const problems = [];
const allFiles = walk(DIST);
const assets = allFiles.filter((file) => /\.(js|css|html)$/.test(file));
let totalBytes = 0;

// dist 就是 Tauri 的 frontendDist：`.map` 会被一起打进安装包（实测多出约 2.6 MB，且等于把源码发出去）。
// 原先只扫 .js/.css/.html，所以这个洞一直没被看见 —— 现在单独拦一条。
for (const file of allFiles) {
  if (/\.map$/.test(file)) problems.push(`${path.relative(ROOT, file).split(path.sep).join('/')}: 产物里不许有 sourcemap（会打进安装包并把源码发出去）`);
}

for (const file of assets) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const text = readFileSync(file, 'utf8');
  const size = Buffer.byteLength(text);

  if (/\.js$/.test(file) && size > MAX_BYTES) {
    problems.push(`${rel}: ${Math.round(size / 1024)} KB，超过 ${MAX_BYTES / 1024} KB 上限`);
  }

  for (const match of text.matchAll(FORBIDDEN)) {
    const around = text.slice(Math.max(0, match.index - 60), match.index + 40).replace(/\s+/g, ' ');
    problems.push(`${rel}: 引用了 Node 内置模块（浏览器里不存在）…${around}…`);
  }

  if (/\.(js|css)$/.test(file)) totalBytes += size;
}

if (problems.length > 0) {
  console.error(`✗ 产物体检失败：${problems.length} 项`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`✓ 产物体检通过（${assets.length} 个文件，js+css 共 ${Math.round(totalBytes / 1024)} KB，无 Node 内置模块）`);
