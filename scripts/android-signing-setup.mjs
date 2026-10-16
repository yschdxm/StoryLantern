#!/usr/bin/env node
/**
 * 把"签名"接进生成的 Android 工程（**幂等**，可反复跑）。
 *
 * 为什么需要脚本：`apps/shell/src-tauri/gen/` 是 **Tauri 生成的**、被本仓库 gitignore，
 * 任何手改都会在下一次 `tauri android init` 后丢掉 —— 所以补丁做成脚本，每次构建前重放一次。
 *
 * 它做三件事，都不碰任何密钥：
 *  1. 加一个 `signingConfigs` 块：`dev`（测试密钥，口令在仓库文档里）+ `release`
 *     （从仓库外的 `.keystore/keystore.properties` 读，**永不入库**）；
 *  2. `debug` buildType 用 `dev` 配置 —— 避免"同名换签名装不上"（INSTALL_FAILED_UPDATE_INCOMPATIBLE）；
 *  3. `release` buildType 用 `release` 配置，并且**没有 keystore.properties 时直接失败**
 *     （明确、可行动，而不是静默用测试密钥签一个看起来正常的包）。
 *
 * ⚠️ 第一版假设"生成的工程里已经有 `signingConfigs` 块"，于是**在干净机器上必然失败**：
 * 2026-10 的 Tauri 模板里只有 `buildTypes`，没有 `signingConfigs` —— 这是第一次真 runner 运行
 * 抓到的（本机有那块，是因为本机的 `gen/` 早被我改过）。现在两条路都支持：
 * 有块就整块替换，没有就在 `buildTypes` 前**插入**。
 *
 * 用法：node scripts/android-signing-setup.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const GRADLE = path.join(ROOT, 'apps', 'shell', 'src-tauri', 'gen', 'android', 'app', 'build.gradle.kts');
const MARK = 'storylantern-release-signing';
/** app/ 往上 6 层就是仓库根（与测试密钥用的是同一套写法）。 */
const REL = '../../../../../../.keystore';

function fail(message) {
  console.error(`  ✗ ${message}`);
  process.exit(1);
}

let text;
try {
  text = readFileSync(GRADLE, 'utf8');
} catch {
  fail(`找不到 ${path.relative(ROOT, GRADLE)}：先跑一次 Tauri 的 Android init/构建（见 docs/PACKAGING.md）`);
}

// 生成的工程里 `java` 是 JavaPluginExtension 不是包名 → `java.util.Properties()` 编不过。
text = text.replaceAll('java.util.Properties()', 'Properties()');
if (!/^import java\.util\.Properties$/m.test(text)) {
  text = `import java.util.Properties${text.includes('\r\n') ? '\r\n' : '\n'}${text}`;
}

const eol = text.includes('\r\n') ? '\r\n' : '\n';
let lines = text.split(/\r?\n/);
const findLine = (from, predicate) => {
  for (let index = from; index < lines.length; index += 1) if (predicate(lines[index])) return index;
  return -1;
};

const signingBlock = [
  `    // ${MARK}：测试密钥（dev）与发布密钥（release，从仓库外的 .keystore/keystore.properties 读，永不入库）。`,
  '    signingConfigs {',
  '        create("dev") {',
  `            storeFile = file("${REL}/storylantern-dev.jks")`,
  '            storePassword = "storylantern-dev"',
  '            keyAlias = "storylantern"',
  '            keyPassword = "storylantern-dev"',
  '        }',
  '        val releasePropsFile = file("' + REL + '/keystore.properties")',
  '        val releaseProps = Properties().apply {',
  '            if (releasePropsFile.exists()) releasePropsFile.inputStream().use { load(it) }',
  '        }',
  '        create("release") {',
  '            if (releasePropsFile.exists()) {',
  '                val required = listOf("storeFile", "storePassword", "keyAlias", "keyPassword")',
  '                val missing = required.filter { releaseProps.getProperty(it).isNullOrBlank() }',
  '                if (missing.isNotEmpty()) {',
  '                    throw GradleException(',
  '                        "读不出 .keystore/keystore.properties 里的 " + missing.joinToString(", ") +',
  '                        " —— 常见原因：文件带 BOM（记事本或 PowerShell 的 -Encoding utf8 写过就会），或键名拼错。" +',
  '                        "用 node scripts/make-android-keystore.mjs 重新生成最省事。"',
  '                    )',
  '                }',
  '                storeFile = file(releaseProps.getProperty("storeFile"))',
  '                storePassword = releaseProps.getProperty("storePassword")',
  '                keyAlias = releaseProps.getProperty("keyAlias")',
  '                keyPassword = releaseProps.getProperty("keyPassword")',
  '            }',
  '        }',
  '    }',
];

// ---- 1) 有旧的 signingConfigs 块就整块删掉（我们的块是唯一真相）----
const existingStart = findLine(0, (line) => line.trim() === 'signingConfigs {');
if (existingStart >= 0) {
  const existingEnd = findLine(existingStart + 1, (line) => line === '    }');
  if (existingEnd < 0) fail('原有的 signingConfigs 块没有正常闭合');
  // 我们插入的块**前面**带着 MARK 注释；删块时要连它一起去掉，否则每跑一次就多一行注释（实测不幂等）。
  let start = existingStart;
  while (start > 0 && lines[start - 1].includes(MARK)) start -= 1;
  lines = [...lines.slice(0, start), ...lines.slice(existingEnd + 1)];
}

// ---- 2) 在 buildTypes 之前插入我们的块 ----
const buildTypesIndex = findLine(0, (line) => line.trim() === 'buildTypes {');
if (buildTypesIndex < 0) fail('找不到 buildTypes（Tauri 模板结构变了，请照 docs/PACKAGING.md 手工接）');
lines = [...lines.slice(0, buildTypesIndex), ...signingBlock, ...lines.slice(buildTypesIndex)];

// ---- 3) debug buildType 用 dev 配置 ----
const debugIndex = findLine(0, (line) => line.trim() === 'getByName("debug") {');
if (debugIndex < 0) fail('找不到 debug buildType');
const debugNext = lines[debugIndex + 1] ?? '';
if (!debugNext.includes('signingConfig =')) {
  lines = [...lines.slice(0, debugIndex + 1), '            signingConfig = signingConfigs.getByName("dev")', ...lines.slice(debugIndex + 1)];
}

// ---- 4) release buildType：守卫 + release 配置 ----
const releaseIndex = findLine(0, (line) => line.trim() === 'getByName("release") {');
if (releaseIndex < 0) fail('找不到 release buildType');
const releaseLines = [
  `            // ${MARK}：没有 keystore.properties 就**不许**出包 —— 明确报错，而不是静默用测试密钥签。`,
  '            if (!file("' + REL + '/keystore.properties").exists()) {',
  '                val asked = gradle.startParameter.taskNames.any { it.contains("release", ignoreCase = true) }',
  '                if (asked) {',
  '                    throw GradleException(',
  '                        "发布构建需要 .keystore/keystore.properties（生成方式见 docs/PACKAGING.md）。" +',
  '                        "release 不再回退到测试密钥：它的口令写在仓库文档里，签出来的包没有安全性。"',
  '                    )',
  '                }',
  '            }',
  '            signingConfig = signingConfigs.getByName("release")',
];
const releaseHasGuard = (lines[releaseIndex + 1] ?? '').includes(MARK);
if (!releaseHasGuard) {
  lines = [...lines.slice(0, releaseIndex + 1), ...releaseLines, ...lines.slice(releaseIndex + 1)];
}

writeFileSync(GRADLE, lines.join(eol), 'utf8');
console.log(`  ✓ 已接入签名：${path.relative(ROOT, GRADLE)}`);
console.log('    debug 用测试密钥；release 用 .keystore/keystore.properties（缺了会明确失败）');
