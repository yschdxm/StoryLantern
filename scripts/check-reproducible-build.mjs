#!/usr/bin/env node
/**
 * 可复现构建检查（M7 准备项之一）：**同一份源码构建两次，产物必须逐字节相同。**
 *
 * 为什么值得真跑一遍：可复现构建是"发布出去的东西能被别人独立验证"的前提，
 * 而它最容易被构建工具悄悄破坏（时间戳、随机 id、绝对路径、并发顺序）。
 * 光在文档里写"应该可复现"没有任何约束力 —— 所以这里构建两次、逐文件比 sha256。
 *
 * 与 `check-bundle.mjs` 的分工：那个查"产物里有没有混进 node: 内置模块"，
 * 这个查"两次构建是不是同一个东西"。两者都不需要网络。
 *
 * 用法：node scripts/check-reproducible-build.mjs
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'apps', 'app', 'dist');
const BUILD = path.join(ROOT, 'apps', 'shell', 'build-frontend.mjs');

function walk(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    if (statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push(rel);
  }
  return out;
}

/** 产物的规范化清单：相对路径 + 大小 + sha256（排序后）。 */
function manifestOf(dir) {
  return walk(dir)
    .sort()
    .map((rel) => {
      const bytes = readFileSync(path.join(dir, rel));
      return {
        path: rel,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    });
}

function build() {
  // stdio 用 ignore：这一层不需要它的输出（也避免受限环境下的管道问题）
  const result = spawnSync(process.execPath, [BUILD], { cwd: ROOT, stdio: 'ignore' });
  if (result.status !== 0) throw new Error(`构建失败：node apps/shell/build-frontend.mjs 退出码 ${result.status}`);
}

function compare(first, second) {
  const byPath = new Map(second.map((entry) => [entry.path, entry]));
  const differences = [];
  for (const entry of first) {
    const other = byPath.get(entry.path);
    if (other === undefined) differences.push(`只在第一次出现：${entry.path}`);
    else if (other.sha256 !== entry.sha256) {
      differences.push(`内容不同：${entry.path}（${entry.size} B vs ${other.size} B）`);
    }
    byPath.delete(entry.path);
  }
  for (const leftover of byPath.keys()) differences.push(`只在第二次出现：${leftover}`);
  return differences;
}

try {
  console.log('  [可复现] 第一次构建…');
  build();
  const first = manifestOf(DIST);

  console.log('  [可复现] 第二次构建…');
  build();
  const second = manifestOf(DIST);

  const totalBytes = first.reduce((sum, entry) => sum + entry.size, 0);
  console.log(
    `  [可复现] 产物 ${first.length} 个文件 / ${(totalBytes / 1024).toFixed(1)} KB；` +
      `两次清单长度 ${first.length} vs ${second.length}`,
  );

  const differences = compare(first, second);
  if (differences.length === 0) {
    console.log('  [可复现] ✓ 两次构建逐字节相同');
  } else {
    console.error(`  [可复现] ✗ 两次构建有 ${differences.length} 处不同：`);
    for (const line of differences.slice(0, 10)) console.error('    - ' + line);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`  [可复现] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
