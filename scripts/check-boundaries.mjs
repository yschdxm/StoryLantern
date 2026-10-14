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
 *
 * 扫描范围是**产品与工具代码**（packages / plugins / scripts / apps）。
 * 刻意不扫描 `spikes/`、`eval/`、`fixtures/`：它们是开发期一次性产物或测试数据生成器
 * （`fixtures/tools/make-fixtures.mjs` 就明显超过 400 行，因为样本数据本身就长），
 * 不随产品发布。这是**有意的排除**，不是遗漏。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAX_LINES = 400;
const SCAN_DIRS = ['packages', 'plugins', 'scripts', 'apps'];

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

const BUILD_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'gen', 'coverage', 'out']);

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (BUILD_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

/** 文本类文件：UTF-8 校验只针对这些（二进制夹具跳过）。 */
const TEXT_FILE = /\.(ts|mts|tsx|mjs|js|cjs|json|jsonl|md|ya?ml|toml|txt|gitignore|gitattributes|editorconfig|properties|kts|gradle|rs|py|html|css)$/i;
const TEXT_ROOTS = ['docs', 'bundles', 'fixtures', 'eval', 'spikes'];
const TEXT_ROOT_FILES = [
  'README.md',
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.base.json',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
];

/**
 * 校验文本文件是合法 UTF-8。
 *
 * 为什么值得单独一条：本机已经三次因"用 PowerShell 追加内容"写进 GBK 字节，
 * 造出混合编码文件——其中一次直接把 `.gitignore` 变成非法 UTF-8，另一次让 `.ps1` 解析失败。
 * Node 读非法 UTF-8 **不会报错**（静默替换成 U+FFFD），所以必须显式往返比对。
 */
async function checkUtf8(files) {
  const targets = [...files];
  for (const dir of TEXT_ROOTS) {
    const full = path.join(ROOT, dir);
    const info = await stat(full).catch(() => null);
    if (info?.isDirectory()) await walk(full, targets);
  }
  for (const name of TEXT_ROOT_FILES) {
    const full = path.join(ROOT, name);
    const info = await stat(full).catch(() => null);
    if (info?.isFile()) targets.push(full);
  }

  for (const file of targets) {
    const relPath = path.relative(ROOT, file).split(path.sep).join('/');
    if (!TEXT_FILE.test(relPath)) continue;
    const bytes = await readFile(file);
    const roundTrip = Buffer.from(bytes.toString('utf8'), 'utf8');
    if (!roundTrip.equals(bytes)) {
      violations.push(`${relPath}: 不是合法 UTF-8（混入了其它编码；用 UTF-8 重写该文件）`);
    }
  }
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

    // Vite 的 `?raw` / `?url` 后缀：校验前先摘掉，本体仍须是已知扩展名。
    const bare = spec.split('?')[0];
    if (!/\.(ts|tsx|json|css|mjs|yml|yaml)$/.test(bare)) {
      violations.push(`${relPath}: 相对导入缺少扩展名 -> '${spec}'`);
      continue;
    }

    // 仅类型导入不产生运行时耦合，因此不参与方向约束
    // （将来会由 packages/plugin-api 统一承载这些共享类型）。
    if (typeOnly) continue;

    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relPath), bare));
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

  await checkUtf8(files);

  if (violations.length > 0) {
    console.error(`✗ 门禁失败：${violations.length} 项`);
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log(`✓ 门禁通过（${sourceFiles.length} 个源文件 + 文本文件 UTF-8：行数 / 可擦除性 / any / 依赖方向 / 编码）`);
}

await main();
