#!/usr/bin/env node
/**
 * 把 `apps/shell/android/overrides/` 里的文件套用到生成的 Android 工程上。
 *
 * 为什么需要它：`apps/shell/src-tauri/gen/`（Tauri 生成的 Android 工程）**不入库**
 * （它是生成物，换台机器 `tauri android init` 会重建）。可是我们确实要改两个东西：
 *  1. `MainActivity.kt` —— 系统目录选择器（SAF）只能在这里做；
 *  2. `app/build.gradle.kts` —— 需要 `androidx.documentfile` 才能读 SAIF 树的显示名。
 *
 * 所以把它们放在受版本管理的 `android/overrides/` 下，构建前套用；重复运行是幂等的。
 *
 * 用法：`node apps/shell/android/apply-overrides.mjs`（在生成工程之前跑）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const androidRoot = join(repoRoot, 'apps/shell/src-tauri/gen/android');

if (!existsSync(androidRoot)) {
  console.error(`✗ 找不到生成的 Android 工程：${androidRoot}`);
  console.error('  先跑一次 `pnpm tauri android init`（或 `tauri android init --ci`）再套用。');
  process.exit(1);
}

const files = [
  {
    from: join(here, 'overrides/MainActivity.kt'),
    to: join(androidRoot, 'app/src/main/java/app/storylantern/MainActivity.kt'),
  },
];

let changed = 0;
for (const entry of files) {
  const wanted = readFileSync(entry.from, 'utf8');
  const current = existsSync(entry.to) ? readFileSync(entry.to, 'utf8') : '';
  if (current === wanted) {
    console.log(`  已是目标内容：${entry.to.replace(repoRoot, '')}`);
    continue;
  }
  mkdirSync(dirname(entry.to), { recursive: true });
  writeFileSync(entry.to, wanted, 'utf8');
  changed += 1;
  console.log(`  已套用：${entry.to.replace(repoRoot, '')}`);
}

// 依赖：DocumentFile（读 SAF 树的显示名）
const gradle = join(androidRoot, 'app/build.gradle.kts');
if (existsSync(gradle)) {
  const text = readFileSync(gradle, 'utf8');
  if (!text.includes('androidx.documentfile')) {
    const anchor = 'implementation("androidx.activity:activity-ktx:';
    const at = text.indexOf(anchor);
    if (at < 0) {
      console.error('✗ build.gradle.kts 里找不到 activity-ktx 依赖，无法安全插入 documentfile');
      process.exit(1);
    }
    const lineEnd = text.indexOf('\n', at);
    const line = '  implementation("androidx.documentfile:documentfile:1.1.0")\n';
    writeFileSync(gradle, `${text.slice(0, lineEnd + 1)}${line}${text.slice(lineEnd + 1)}`, 'utf8');
    console.log('  已加依赖：androidx.documentfile:documentfile:1.1.0');
    changed += 1;
  } else {
    console.log('  依赖已存在：androidx.documentfile');
  }
} else {
  console.error(`✗ 找不到 ${gradle}`);
  process.exit(1);
}

console.log(`  完成（改动 ${changed} 处）。`);
