#!/usr/bin/env node
/**
 * 把生成的 Android 工程改成目标**渠道**：`test`（本地/CI 测试）或 `prod`（正式发布）。
 *
 * 为什么需要脚本：`apps/shell/src-tauri/gen/` 是 **Tauri 生成的**，而且被本仓库 gitignore
 * （跟签名补丁同一个原因）—— 任何手改都会在下一次 `tauri android init` 后丢掉。
 *
 * 它只改两处，都不碰密钥：
 *  1. `applicationId`：**决定"这个包能不能和另一个包同时装在手机上"**。
 *     生产 `app.storylantern`，测试 `app.storylantern.test` —— 两者身份不同，可共存；
 *     `namespace` 保持不动（Gradle 允许 namespace ≠ applicationId，Kotlin 包路径就不用搬家）。
 *  2. `res/values/strings.xml` 的 `app_name`：人在桌面上看到的名字（"叙灯" / "叙灯·测试"），
 *     免得装了两个之后分不清哪个是哪个。
 *
 * 用法：node scripts/android-channel.mjs --channel=test|prod
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const GRADLE = path.join(ROOT, 'apps', 'shell', 'src-tauri', 'gen', 'android', 'app', 'build.gradle.kts');
const STRINGS = path.join(ROOT, 'apps', 'shell', 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml');

export const CHANNELS = {
  test: { applicationId: 'app.storylantern.test', label: '叙灯·测试' },
  prod: { applicationId: 'app.storylantern', label: '叙灯' },
};

function arg(name, fallback) {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

function fail(message) {
  console.error(`  ✗ ${message}`);
  process.exit(1);
}

const channel = arg('channel', 'test');
const target = CHANNELS[channel];
if (target === undefined) fail(`--channel 只能是 test / prod，收到 ${channel}`);
if (!existsSync(GRADLE)) {
  fail(`找不到 ${path.relative(ROOT, GRADLE)}：先跑一次 Tauri 的 Android init/构建（见 docs/PACKAGING.md）`);
}

const changes = [];

// ---- 1) applicationId ----
let gradle = readFileSync(GRADLE, 'utf8');
const idLine = /applicationId = "[^"]*"/;
if (!idLine.test(gradle)) fail('生成文件里找不到 applicationId（Tauri 的结构变了，请照 docs/PACKAGING.md 手工改）');
const wantId = `applicationId = "${target.applicationId}"`;
if (!gradle.includes(wantId)) {
  const before = idLine.exec(gradle)?.[0];
  gradle = gradle.replace(idLine, wantId);
  changes.push(`applicationId: ${before} → ${wantId}`);
  writeFileSync(GRADLE, gradle, 'utf8');
}

// ---- 2) 显示名 ----
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

if (changes.length === 0) {
  console.log(`  ✓ 渠道已经是 ${channel}（${target.applicationId} / ${target.label}），无需改动`);
} else {
  console.log(`  ✓ 渠道 → ${channel}：${target.applicationId} / ${target.label}`);
  for (const change of changes) console.log(`    - ${change}`);
}
