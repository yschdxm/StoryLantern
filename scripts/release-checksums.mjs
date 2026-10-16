#!/usr/bin/env node
/**
 * 生成发布校验和（`SHA256SUMS`），并在本机装了 GnuPG 时**顺手给校验和签名**。
 *
 * 为什么需要它：用户决定**不买**代码签名证书（Windows Authenticode / macOS 公证都要花钱），
 * 那"未签名"就等于"用户下载时没法判断东西有没有被换过"吗？不是 —— 还有免费的替代：
 * 把发布产物做成校验和清单，再用 **GPG 密钥给清单签名**（公钥放进仓库/官网）。
 * 用户拿到的是一份可验证的来源：哈希对不上就说明文件变了，签名对不上就说明清单被人动过。
 *
 * 这**不等于**代码签名证书的效果：SmartScreen / Gatekeeper 仍然会警告（因为那是操作系统
 * 按"发行者身份"给信任，而我们没有付费身份）。两者的区别写在 docs/SIGNING.md 里，不混为一谈。
 *
 * 用法：
 *   node scripts/release-checksums.mjs                 # 扫 .apk-out/ 与桌面 target/release 的产物
 *   node scripts/release-checksums.mjs <文件> [文件…]   # 只对指定文件
 *   node scripts/release-checksums.mjs --out <目录>     # 默认 release/
 *
 * 装 GnuPG 之后（Windows: `winget install GnuPG.GnuPG`），会自动多出一个 `SHA256SUMS.asc`。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = path.resolve(outIndex >= 0 ? (args[outIndex + 1] ?? 'release') : path.join(ROOT, 'release'));
const explicit = args.filter((item, index) => !item.startsWith('--') && index !== outIndex + 1);

/** 默认扫描：Android APK 产物 + 桌面 release 目录里的可执行产物。 */
function defaultInputs() {
  const found = [];
  const apkDir = path.join(ROOT, '.apk-out');
  if (existsSync(apkDir)) {
    for (const name of readdirSync(apkDir)) {
      if (name.endsWith('.apk')) found.push(path.join(apkDir, name));
    }
  }
  const desktopDir = path.join(ROOT, 'apps', 'shell', 'src-tauri', 'target', 'release');
  if (existsSync(desktopDir)) {
    for (const name of readdirSync(desktopDir)) {
      const full = path.join(desktopDir, name);
      // 只收真正的分发产物：exe / dll 之外的安装包由 tauri bundle 产出在 bundle/ 里
      if (statSync(full).isFile() && (name.endsWith('.exe') || name.endsWith('.msi'))) found.push(full);
    }
    const bundleDir = path.join(desktopDir, 'bundle');
    if (existsSync(bundleDir)) {
      const walk = (dir) => {
        for (const name of readdirSync(dir)) {
          const full = path.join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (/\.(exe|msi|dmg|AppImage|deb|rpm)$/.test(name)) found.push(full);
        }
      };
      walk(bundleDir);
    }
  }
  return found;
}

const inputs = (explicit.length > 0 ? explicit.map((item) => path.resolve(item)) : defaultInputs()).filter((file) =>
  existsSync(file),
);
if (inputs.length === 0) {
  console.error('  ✗ 没有找到可发布产物。先构建（APK: node scripts/build-android.mjs --release；桌面: pnpm --filter @storylantern/shell run build）');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const lines = [];
console.log('  产物：');
for (const file of inputs.sort()) {
  const bytes = readFileSync(file);
  const hash = createHash('sha256').update(bytes).digest('hex');
  lines.push(`${hash}  ${path.basename(file)}`);
  console.log(`    ${path.basename(file).padEnd(40)} ${(bytes.length / 1024 / 1024).toFixed(2)} MB  sha256:${hash.slice(0, 16)}…`);
}
const sumsPath = path.join(outDir, 'SHA256SUMS');
writeFileSync(sumsPath, `${lines.join('\n')}\n`, 'utf8');
console.log(`  ✓ 校验和：${path.relative(ROOT, sumsPath)}（${lines.length} 个产物）`);

// GPG 是**可选**的：没有也不该挡路，但要明确告诉用户"现在这份清单是不可验证来源的"
const gpg = spawnSync('gpg', ['--version'], { encoding: 'utf8' });
if (gpg.status === 0) {
  const keyId = process.env.RELEASE_GPG_KEY ?? '';
  const argsForSign = ['--detach-sign', '--armor', ...(keyId === '' ? [] : ['--local-user', keyId]), sumsPath];
  const signed = spawnSync('gpg', argsForSign, { stdio: 'inherit' });
  if (signed.status === 0) {
    console.log(`  ✓ 已签名：${path.relative(ROOT, `${sumsPath}.asc`)}（公钥请发布到仓库/官网）`);
  } else {
    console.error('  ✗ GPG 签名失败：先 `gpg --gen-key`，或设 RELEASE_GPG_KEY 指定密钥');
    process.exitCode = 1;
  }
} else {
  console.log('  ⚠️ 本机没有 GnuPG → 只有未签名的 SHA256SUMS：用户能查"文件有没有损坏"，但**无法**验证清单本身有没有被替换');
  console.log('    装上之后重跑即可（Windows: winget install GnuPG.GnuPG；macOS: brew install gnupg）');
}

console.log('\n  给用户的核验命令（写进发布说明里）：');
console.log('    Linux/macOS : sha256sum -c SHA256SUMS');
console.log('    macOS       : shasum -a 256 -c SHA256SUMS');
console.log('    Windows     : Get-FileHash -Algorithm SHA256 <文件>   # 与清单里的值比对');
console.log('    验清单来源   : gpg --verify SHA256SUMS.asc SHA256SUMS   # 需要发布者的公钥');
