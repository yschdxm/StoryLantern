#!/usr/bin/env node
/**
 * 架构与体积门禁（零依赖）。
 *
 * 规则：
 *  1. 单文件 ≤ 400 行。
 *  2. 类型擦除友好：不得使用 `enum` / `namespace`。
 *  3. `packages/oplog`、`packages/sync-core` 禁止 `any`（核心协议层要强类型）。
 *  4. 相对导入必须带 `.ts` 扩展名（Node 类型擦除不做扩展名重写）。
 *  5. 依赖方向：包之间只允许表中声明的方向。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAX_LINES = 400;
const SCAN_DIRS = ['packages', 'plugins', 'scripts'];

/** 允许的内部依赖：包名 -> 允许依赖的包名集合（'*' 表示除自身外任意 packages/*）。 */
const ALLOWED_DEPS = {
  'plugin-api': [],
  i18n: ['plugin-api'],
  kernel: ['plugin-api'],
  oplog: [],
  'sync-core': ['kernel', 'oplog'],
  domain: ['kernel', 'plugin-api'],
  sqlstore: ['kernel', 'plugin-api', 'domain', 'oplog'],
  'ui-kit': ['kernel', 'plugin-api', 'i18n'],
};

const FORBID_ANY = new Set(['oplog', 'sync-core']);

const violations = [];

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

/** 'packages/oplog/src/x.ts' -> 'oplog'；非包内文件返回 null。 */
function packageOf(relPath) {
  const match = /^(packages|plugins)\/([^/]+)\//.exec(relPath);
  return match ? { kind: match[1], name: match[2] } : null;
}

function isTestFile(relPath) {
  return /(^|\/)test\//.test(relPath) || /\.test\.ts$/.test(relPath);
}

function checkImports(relPath, text) {
  const importRe = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^\n]*?from\s*['"]([^'"]+)['"]/g;
  for (const match of text.matchAll(importRe)) {
    const typeOnly = match[1] !== undefined;
    const spec = match[2];
    if (!spec.startsWith('.')) continue;

    if (!/\.(ts|json|css|mjs)$/.test(spec)) {
      violations.push(`${relPath}: 相对导入缺少扩展名 -> '${spec}'`);
      continue;
    }

    // 仅类型导入不产生运行时耦合，因此不参与方向约束
    // （将来会由 packages/plugin-api 统一承载这些共享类型）。
    if (typeOnly) continue;

    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relPath), spec));
    if (/^packages\/[^/]+\//.test(resolved) || /^plugins\/[^/]+\//.test(resolved)) {
      const from = packageOf(relPath);
      const to = packageOf(resolved);
      if (!from || !to) continue;
      if (from.kind === to.kind && from.name === to.name) continue;
      if (to.kind === 'plugins' && from.kind === 'plugins' && !isTestFile(relPath)) {
        violations.push(`${relPath}: 插件之间不得互相导入 -> '${spec}'`);
        continue;
      }
      // 测试允许把各包接起来（它不发货），生产代码仍受方向表约束。
      if (isTestFile(relPath)) continue;
      const allowed = ALLOWED_DEPS[from.name];
      if (allowed && !allowed.includes(to.name) && !allowed.includes('*')) {
        violations.push(`${relPath}: 非法依赖方向 ${from.name} -> ${to.name}`);
      }
    }
  }
}

function checkSourceRules(relPath, text) {
  const pkg = packageOf(relPath);
  const lines = text.split('\n');

  if (lines.length > MAX_LINES) {
    violations.push(`${relPath}: ${lines.length} 行，超过 ${MAX_LINES} 行上限`);
  }
  if (/^\s*(?:export\s+)?enum\s/m.test(text)) {
    violations.push(`${relPath}: 使用了 enum（不可类型擦除），改用 as const 对象`);
  }
  if (/^\s*(?:declare\s+)?namespace\s/m.test(text)) {
    violations.push(`${relPath}: 使用了 namespace（不可类型擦除）`);
  }
  if (pkg && FORBID_ANY.has(pkg.name) && /(?::\s*any\b|<any>|\bas any\b)/.test(text)) {
    violations.push(`${relPath}: packages/${pkg.name} 禁止 any`);
  }
}

async function main() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    const full = path.join(ROOT, dir);
    const info = await stat(full).catch(() => null);
    if (info?.isDirectory()) await walk(full, files);
  }

  const sourceFiles = files.filter((f) => /\.(ts|mts|tsx|mjs|js)$/.test(f));
  for (const file of sourceFiles) {
    const relPath = path.relative(ROOT, file).split(path.sep).join('/');
    const text = await readFile(file, 'utf8');
    checkSourceRules(relPath, text);
    checkImports(relPath, text);
  }

  if (violations.length > 0) {
    console.error(`✗ 门禁失败：${violations.length} 项`);
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log(`✓ 门禁通过（${sourceFiles.length} 个源文件：行数 / 可擦除性 / any / 依赖方向）`);
}

await main();
