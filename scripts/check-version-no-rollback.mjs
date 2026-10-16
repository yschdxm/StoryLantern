#!/usr/bin/env node
/**
 * **生产版版本号不许回退**：拿这次的版本号算出版本码，和仓库里已有的 `v*` tag 比，
 * 不大于最大的那个就直接失败（测试渠道不做限制 —— 它们是另一套包名，互不影响）。
 *
 * 为什么需要它：Android 用 `versionCode` 判断"能不能升级"，一旦发过 `v1.2.0` 再发 `v1.1.0`，
 * 用户装不上（而且如果发出去过，商店/用户侧会一直卡着）。这个规则**必须由机器守**，
 * 不能靠"我记得上次发到哪了"。
 *
 * 版本码算法与 `scripts/android-channel.mjs` 的 `versionCodeOf` 必须**同一套**：
 *   `major*10000 + minor*100 + patch`  （所以 0.0.1 → 1，1.2.3 → 10203）
 *
 * 用法：
 *   node scripts/check-version-no-rollback.mjs                 # 用 tauri.conf.json 的版本
 *   node scripts/check-version-no-rollback.mjs --version=1.2.3  # 用指定版本（CI 里来自 tag）
 *   node scripts/check-version-no-rollback.mjs --channel=dev    # 测试渠道：直接放行
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function arg(name, fallback) {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

/** 与 scripts/android-channel.mjs 共用同一套算法（唯一实现在 scripts/lib/version-code.mjs）。 */
import { versionCodeOf } from './lib/version-code.mjs';
export { versionCodeOf };

const channel = arg('channel', 'prod');
if (channel !== 'prod') {
  console.log(`  ✓ 渠道 ${channel}：测试版版本号不做限制（包名与生产不同，互不影响）`);
  process.exit(0);
}

const version = arg('version', String(JSON.parse(readFileSync(path.join(ROOT, 'apps', 'shell', 'src-tauri', 'tauri.conf.json'), 'utf8')).version ?? ''));
const normalized = version.replace(/^v/, '');
const code = versionCodeOf(normalized);
if (code === undefined) {
  console.error(`  ✗ 版本号不是 x.y.z 形式：${version}（生产发布必须用语义化版本，例如 v0.1.0）`);
  process.exit(1);
}

const tags = spawnSync('git', ['tag', '-l', 'v*'], { cwd: ROOT, encoding: 'utf8' });
if (tags.status !== 0) {
  console.error('  ✗ 取不到 git tag（不在 git 仓库里？）');
  process.exit(1);
}

const released = (tags.stdout ?? '')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '')
  .map((tag) => ({ tag, code: versionCodeOf(tag.replace(/^v/, '')) }))
  .filter((item) => item.code !== undefined)
  .sort((a, b) => (a.code ?? 0) - (b.code ?? 0));

const highest = released.at(-1);
console.log(`  这次：${normalized} → versionCode ${code}`);
console.log(released.length === 0 ? '  仓库里还没有 v* tag（这是第一次）' : `  已有 ${released.length} 个 tag，最高：${highest?.tag}（${highest?.code}）`);

if (highest !== undefined && highest.code !== undefined && code <= highest.code) {
  console.error(`  ✗ 版本回退：${normalized}（${code}）不大于已发布的 ${highest.tag}（${highest.code}）`);
  console.error('    生产版本号一旦发出就不能回退（Android 用 versionCode 判断升级，回退会让用户装不上）。');
  console.error('    请提高版本号；测试渠道（dev/test）不受这条限制。');
  process.exit(1);
}
console.log('  ✓ 未回退，可以发布');
