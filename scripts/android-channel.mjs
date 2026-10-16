#!/usr/bin/env node
/**
 * 把生成的 Android 工程改成目标**渠道**：`dev`（本地测试）/ `test`（GA 测试）/ `prod`（正式发布）。
 *
 * 三个渠道的**包名必须互不相同**，否则手机上装不下第二个（同包名换签名更是直接装不上）。
 *
 * 为什么需要脚本：`apps/shell/src-tauri/gen/` 是 **Tauri 生成的**，而且被本仓库 gitignore
 * （跟签名补丁同一个原因）—— 任何手改都会在下一次 `tauri android init` 后丢掉。
 *
 * 它改四件事，都不碰密钥：
 *  1. `applicationId`：决定"这个包能不能和另一个包共存"（`namespace` 保持不动 ——
 *     Gradle 允许 namespace ≠ applicationId，Kotlin 包路径就不用搬家）；
 *  2. `res/values/strings.xml` 的 `app_name`：桌面图标下的名字，免得装了几个分不清；
 *  3. `versionName`：测试渠道带上 `-dev` / `-test` 后缀，一眼看出是哪个渠道（显示用，不参与升级判断）；
 *  4. `versionCode`：**只有生产渠道**把它写成由版本号算出来的数（`major*10000+minor*100+patch`）。
 *     这是 Android 判断"能不能升级"的依据，所以生产版必须单调递增、**不许回退**；
 *     两个测试渠道不做限制（你要的也是这样）。回退会被 `scripts/check-version-no-rollback.mjs` 拦住。
 *
 * 用法：node scripts/android-channel.mjs --channel=dev|test|prod
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const GRADLE = path.join(ROOT, 'apps', 'shell', 'src-tauri', 'gen', 'android', 'app', 'build.gradle.kts');
const STRINGS = path.join(ROOT, 'apps', 'shell', 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml');
const TAURI_CONF = path.join(ROOT, 'apps', 'shell', 'src-tauri', 'tauri.conf.json');

export const CHANNELS = {
  dev: { applicationId: 'app.storylantern.dev', label: '叙灯·开发', versionSuffix: '-dev' },
  test: { applicationId: 'app.storylantern.test', label: '叙灯·测试', versionSuffix: '-test' },
  prod: { applicationId: 'app.storylantern', label: '叙灯', versionSuffix: '' },
};

// 版本码算法只有一个实现（scripts/lib/version-code.mjs）：与发布守卫共用同一套。
import { versionCodeOf } from './lib/version-code.mjs';
export { versionCodeOf };

function arg(name, fallback) {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

function fail(message) {
  console.error(`  ✗ ${message}`);
  process.exit(1);
}

const channel = arg('channel', 'dev');
const target = CHANNELS[channel];
if (target === undefined) fail(`--channel 只能是 dev / test / prod，收到 ${channel}`);
if (!existsSync(GRADLE)) {
  fail(`找不到 ${path.relative(ROOT, GRADLE)}：先跑一次 Tauri 的 Android init/构建（见 docs/PACKAGING.md）`);
}

const changes = [];
const baseVersion = existsSync(TAURI_CONF)
  ? String(JSON.parse(readFileSync(TAURI_CONF, 'utf8')).version ?? '0.0.1')
  : '0.0.1';

// ---- 1) applicationId ----
let gradle = readFileSync(GRADLE, 'utf8');
const idLine = /applicationId = "[^"]*"/;
if (!idLine.test(gradle)) fail('生成文件里找不到 applicationId（Tauri 的结构变了，请照 docs/PACKAGING.md 手工改）');
const wantId = `applicationId = "${target.applicationId}"`;
if (!gradle.includes(wantId)) {
  const before = idLine.exec(gradle)?.[0];
  gradle = gradle.replace(idLine, wantId);
  changes.push(`applicationId: ${before} → ${wantId}`);
}

// ---- 2) versionName（显示用）+ 3) versionCode（升级判断用：只有生产渠道固定）----
const wantName = `${baseVersion}${target.versionSuffix}`;
const nameLine = /versionName = tauriProperties\.getProperty\("tauri\.android\.versionName", "[^"]*"\)/;
if (channel === 'prod') {
  const code = versionCodeOf(baseVersion);
  if (code === undefined) fail(`tauri.conf.json 里的 version 不是 x.y.z 形式：${baseVersion}`);
  const codeLine = /versionCode = tauriProperties\.getProperty\("tauri\.android\.versionCode", "\d+"\)\.toInt\(\)/;
  if (!codeLine.test(gradle)) fail('生成文件里找不到 versionCode 行（Tauri 的结构变了）');
  gradle = gradle.replace(codeLine, `versionCode = ${code}`);
  gradle = gradle.replace(/versionCode = \d+/, `versionCode = ${code}`);
  if (!gradle.includes(`versionCode = ${code}`)) changes.push(`versionCode → ${code}（由 ${baseVersion} 算出，生产版不许回退）`);
  else changes.push(`versionCode = ${code}（生产版；由 ${baseVersion} 算出）`);
}
if (nameLine.test(gradle)) {
  const next = gradle.replace(nameLine, `versionName = "${wantName}"`);
  if (next !== gradle) {
    gradle = next;
    changes.push(`versionName → ${wantName}`);
  }
}
writeFileSync(GRADLE, gradle, 'utf8');

// ---- 4) 显示名 ----
const appName = `    <string name="app_name">${target.label}</string>`;
if (existsSync(STRINGS)) {
  const xml = readFileSync(STRINGS, 'utf8');
  if (/<string name="app_name">/.test(xml)) {
    const next = xml.replace(/(<string name="app_name">)[^<]*(<\/string>)/, `$1${target.label}$2`);
    if (next !== xml) {
      writeFileSync(STRINGS, next, 'utf8');
      changes.push(`app_name → ${target.label}`);
    }
  } else {
    writeFileSync(STRINGS, xml.replace('</resources>', `${appName}\n</resources>`), 'utf8');
    changes.push(`app_name 新增 → ${target.label}`);
  }
} else {
  mkdirSync(path.dirname(STRINGS), { recursive: true });
  writeFileSync(STRINGS, `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n${appName}\n</resources>\n`, 'utf8');
  changes.push(`strings.xml 新建（app_name = ${target.label}）`);
}

console.log(`  ✓ 渠道 → ${channel}：${target.applicationId} / ${target.label} / ${wantName}`);
for (const change of changes) console.log(`    - ${change}`);
if (changes.length === 0) console.log('    （无改动：本来就是这个渠道）');
