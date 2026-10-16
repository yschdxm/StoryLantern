#!/usr/bin/env node
/**
 * 把"发布签名"接进生成的 Android 工程（幂等，可反复跑）。
 *
 * 为什么需要这样一个脚本：`apps/shell/src-tauri/gen/` 是 **Tauri 生成的**（本仓库把它 gitignore 了），
 * 所以任何手改都会在下一次 `tauri android init` / 重新生成后**丢掉**。于是把改动做成脚本：
 * 需要时重跑一次，签名配置就回来了。
 *
 * 它做两件事，都不碰任何密钥：
 *  1. `signingConfigs` 里加一个 **release** 配置：从 `.keystore/keystore.properties` 读路径与口令
 *     （该文件在 .gitignore 覆盖范围内，**永不入库**）；
 *  2. 让 **release 构建在没有 keystore.properties 时直接失败**（明确、可行动的报错），
 *     而不是"静默地用开发密钥签一个看起来正常的包"。debug 构建完全不受影响。
 *
 * 实现按**行**处理而不是按字符索引 —— 生成的 Gradle 文件行尾/缩进随时可能变，
 * 第一版用字符串找闭合括号，当场就找不到了。
 *
 * 用法：node scripts/android-signing-setup.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const GRADLE = path.join(ROOT, 'apps', 'shell', 'src-tauri', 'gen', 'android', 'app', 'build.gradle.kts');
const MARK = 'storylantern-release-signing';
/** app/ 往上 6 层就是仓库根（与开发密钥用的是同一套写法）。 */
const REL = '../../../../../../.keystore';

function fail(message) {
  console.error(`  ✗ ${message}`);
  process.exit(1);
}

let text;
try {
  text = readFileSync(GRADLE, 'utf8');
} catch {
  fail(`找不到 ${path.relative(ROOT, GRADLE)}：先跑一次 Tauri 的 Android 构建/初始化（见 docs/SIGNING.md）`);
}
if (text.includes(MARK)) {
  // 已打过补丁：做幂等的"修复过期/加固"替换，然后退出。
  //  - Kotlin DSL 里 `java` 是 JavaPluginExtension 不是包名 → `java.util.Properties()` 编不过；
  //  - properties 读不出来时要给**可行动**的报错：踩过 BOM 的坑（PowerShell/记事本写 utf8 会带 BOM，
  //    Java 的 Properties.load 把首键读成 "\uFEFFstoreFile"，于是 getProperty 返回 null，
  //    Gradle 只报一句 `getProperty(...) must not be null`，没法查）。
  let repaired = text.replaceAll('java.util.Properties()', 'Properties()');
  const guardMarker = 'val required = listOf(';
  if (!text.includes(guardMarker)) {
    const oldHead = [
      '        create("release") {',
      '            if (releasePropsFile.exists()) {',
      '                storeFile = file(releaseProps.getProperty("storeFile"))',
    ].join('\n');
    const newHead = [
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
    ].join('\n');
    if (text.includes(oldHead)) repaired = repaired.replace(oldHead, newHead);
  }
  if (repaired !== text) {
    writeFileSync(GRADLE, repaired, 'utf8');
    console.log('  ✓ 已接好，并加固了"读不出签名配置"的报错');
  } else {
    console.log(`  ✓ 已经接好（含 ${MARK}），无需改动`);
  }
  process.exit(0);
}

// 需要 Properties 类型：生成的文件通常已 import，缺了就补上（否则 patch 出来的脚本编不过）
if (!/^import java\.util\.Properties$/m.test(text)) {
  text = `import java.util.Properties${text.includes('\r\n') ? '\r\n' : '\n'}${text}`;
}

const eol = text.includes('\r\n') ? '\r\n' : '\n';
const lines = text.split(/\r?\n/);

const findLine = (from, predicate) => {
  for (let index = from; index < lines.length; index += 1) if (predicate(lines[index])) return index;
  return -1;
};

// ---- 1) 替换 signingConfigs 块 ----
const signingStart = findLine(0, (line) => line.trim() === 'signingConfigs {');
if (signingStart < 0) fail('找不到 signingConfigs 块（生成的 Gradle 结构变了，请照 docs/SIGNING.md 手工接）');
const signingEnd = findLine(signingStart + 1, (line) => line === '    }');
if (signingEnd < 0) fail('signingConfigs 块没有正常闭合');

const signingBlock = [
  '    signingConfigs {',
  '        // debug 用开发密钥（口令写在 .keystore/README.md 里，只用于本机测试）：',
  '        // debug 与 release 用同一把密钥是为了避免覆盖安装时 INSTALL_FAILED_UPDATE_INCOMPATIBLE、',
  '        // 以及每次切换签名就清掉测试数据——排查问题时非常费时间。',
  '        create("dev") {',
  `            storeFile = file("${REL}/storylantern-dev.jks")`,
  '            storePassword = "storylantern-dev"',
  '            keyAlias = "storylantern"',
  '            keyPassword = "storylantern-dev"',
  '        }',
  `        // ${MARK}：发布签名从仓库外的 .keystore/keystore.properties 读（永不入库，见 docs/SIGNING.md）。`,
  '        // properties 里的 storeFile 也用与上面同一套相对路径（相对 app/ 目录）。',
  `        val releasePropsFile = file("${REL}/keystore.properties")`,
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

// ---- 2) 替换 release buildType 的签名行 ----
const releaseStart = findLine(signingEnd + 1, (line) => line.trim() === 'getByName("release") {');
if (releaseStart < 0) fail('找不到 release buildType');
const optimization = findLine(releaseStart + 1, (line) => line.trim() === 'optimization {');
if (optimization < 0) fail('release buildType 里找不到 optimization 块（生成的 Gradle 结构变了）');

const releaseBlock = [
  '        getByName("release") {',
  `            // ${MARK}：没有 keystore.properties 就**不许**出包 —— 明确报错，而不是静默用开发密钥签。`,
  `            if (!file("${REL}/keystore.properties").exists()) {`,
  '                val asked = gradle.startParameter.taskNames.any { it.contains("release", ignoreCase = true) }',
  '                if (asked) {',
  '                    throw GradleException(',
  '                        "发布构建需要 .keystore/keystore.properties（生成方式见 docs/SIGNING.md）。" +',
  '                        "release 不再回退到开发密钥：它的口令写在仓库文档里，签出来的包没有安全性。"',
  '                    )',
  '                }',
  '            }',
  '            signingConfig = signingConfigs.getByName("release")',
];

const patched = [
  ...lines.slice(0, signingStart),
  ...signingBlock,
  ...lines.slice(signingEnd + 1, releaseStart),
  ...releaseBlock,
  ...lines.slice(optimization),
].join(eol);

writeFileSync(GRADLE, patched, 'utf8');
console.log(`  ✓ 已接入发布签名：${path.relative(ROOT, GRADLE)}`);
console.log('    下一步：node scripts/make-android-keystore.mjs（生成仓库外的发布密钥与 keystore.properties）');
