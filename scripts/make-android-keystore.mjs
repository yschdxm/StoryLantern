#!/usr/bin/env node
/**
 * 生成**发布用** Android 签名密钥（keystore）+ 给 Gradle 读的 keystore.properties。
 *
 * 三条铁律，脚本自己守着：
 *  1. **口令绝不进命令行**：用 `keytool -storepass:env` / `-keypass:env`，
 *     也就是口令只经过环境变量 —— 不会出现在进程列表里（进程列表是低级但真实的泄露面）；
 *  2. **口令绝不打印**：脚本只输出"生成在哪、别名是什么、有效期多久"，以及怎么自己核对；
 *  3. **绝不覆盖已有密钥**：同名文件存在就直接失败（签名密钥被覆盖 = 以后再也升不了级，
 *     只能让用户卸载重装，还会丢掉本地数据）。
 *
 * 用法：
 *   # 口令走环境变量（推荐；CI 里用 secrets 注入）
 *   set STORYLANTERN_KEYSTORE_PASSWORD=...        # Windows
 *   export STORYLANTERN_KEYSTORE_PASSWORD=...     # macOS/Linux
 *   node scripts/make-android-keystore.mjs
 *
 *   # 想放到仓库外（例如 %TEMP%，做一次性验证用）
 *   node scripts/make-android-keystore.mjs --out "%TEMP%" --name sl-test.jks --props "%TEMP%\sl-test.properties" --dname "CN=Throwaway, O=Story Lantern, C=CN"
 *
 * 生成之后请**立刻离机备份**（加密压缩 + 至少两份），并把口令存进密码管理器 ——
 * 丢了它，Android 不允许用新密钥覆盖安装（见 DEVELOPMENT.md 第三节）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_DIR = path.join(ROOT, '.keystore');
const DEFAULT_NAME = 'release.jks';
const ALIAS = 'storylantern';
/** app/ 往上 6 层 = 仓库根；Gradle 里用 `file(...)` 解析这个相对路径。 */
const GRADLE_REL = '../../../../../../.keystore';

function arg(name, fallback) {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const channel = arg('channel', 'prod');
const isTest = channel === 'test';
/** 测试渠道的口令是**故意公开**的：它写在本仓库文档里，只用来签"本地/CI 的测试包"。 */
const TEST_PASSWORD = 'storylantern-dev';

const outDir = path.resolve(arg('out', DEFAULT_DIR));
const keystoreName = arg('name', isTest ? 'storylantern-dev.jks' : DEFAULT_NAME);
const propsPath = path.resolve(arg('props', path.join(outDir, isTest ? 'dev.properties' : 'keystore.properties')));
const dname = arg('dname', isTest ? 'CN=Story Lantern test key, O=Story Lantern, C=CN' : 'CN=Story Lantern, O=Story Lantern, OU=personal, C=CN');
const validityDays = arg('validity', '10000');
const keysize = arg('keysize', isTest ? '2048' : '4096');
const keystorePath = path.join(outDir, keystoreName);

const password = process.env.STORYLANTERN_KEYSTORE_PASSWORD ?? (isTest ? TEST_PASSWORD : '');
if (password === '') {
  console.error('  ✗ 请先把口令放进环境变量 STORYLANTERN_KEYSTORE_PASSWORD（不要把口令写在命令行上）');
  console.error('    Windows: $env:STORYLANTERN_KEYSTORE_PASSWORD = (Read-Host -AsSecureString | ConvertFrom-SecureString -AsPlainText)');
  console.error('    bash   : read -rs STORYLANTERN_KEYSTORE_PASSWORD && export STORYLANTERN_KEYSTORE_PASSWORD');
  process.exit(1);
}
if (!isTest && password.length < 12) {
  console.error(`  ✗ 口令太短（${password.length} 位）：这把密钥一旦丢失就再也升不了级，请用 ≥12 位随机串（建议 24+）`);
  process.exit(1);
}
if (existsSync(keystorePath)) {
  console.error(`  ✗ 已经存在：${keystorePath}`);
  console.error('    签名密钥**不能**被覆盖：换了密钥就再也盖不上旧版本（只能让用户卸载重装、丢本地数据）。');
  console.error('    确实要另起一把新密钥，就换 --name（那意味着这是一个新应用身份，取决于你的分发策略）。');
  process.exit(1);
}

const javaHome = process.env.JAVA_HOME ?? '';
const keytool = path.join(javaHome, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool');
if (javaHome === '' || !existsSync(keytool)) {
  console.error('  ✗ 找不到 keytool：先设置 JAVA_HOME 指向 JDK（Android Studio 自带的 jbr 也行）');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
process.env.STORYLANTERN_KEYSTORE_PASSWORD = password;

const result = spawnSync(
  keytool,
  [
    '-genkeypair',
    '-keystore', keystorePath,
    '-alias', ALIAS,
    '-keyalg', 'RSA',
    '-keysize', keysize,
    '-validity', validityDays,
    '-storetype', 'PKCS12',
    '-dname', dname,
    // 口令只走环境变量：不出现在命令行里，也不进任何日志
    '-storepass:env', 'STORYLANTERN_KEYSTORE_PASSWORD',
    '-keypass:env', 'STORYLANTERN_KEYSTORE_PASSWORD',
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);
if (result.status !== 0) {
  console.error(`  ✗ keytool 失败（退出码 ${result.status}）`);
  process.exit(1);
}

const storeFileValue = outDir === path.join(ROOT, '.keystore') ? `${GRADLE_REL}/${keystoreName}` : keystorePath;
writeFileSync(
  propsPath,
  [
    '# 由 scripts/make-android-keystore.mjs 生成 —— 这个文件包含口令，永不入库（.gitignore 覆盖 .keystore/）',
    `storeFile=${storeFileValue}`,
    'storePassword=' + password,
    `keyAlias=${ALIAS}`,
    'keyPassword=' + password,
    '',
  ].join('\n'),
  'utf8',
);

console.log(`  ✓ ${isTest ? '测试' : '发布'}密钥已生成（口令未打印、未进命令行）`);
console.log(`    渠道     : ${channel}`);
console.log(`    keystore : ${keystorePath}`);
console.log(`    properties: ${propsPath}`);
console.log(`    别名 ${ALIAS} / RSA ${keysize} / 有效期 ${validityDays} 天 / PKCS12`);
if (isTest) {
  console.log('    ⚠️ 这是**测试密钥**：口令是公开的（storylantern-dev），只用来签本机/CI 的测试包；');
  console.log('       正式发布必须用发布密钥（不加 --channel=test），见 DEVELOPMENT.md 的密钥矩阵。');
} else {
  console.log('    自己核对（不需要口令就能看证书指纹）：');
  console.log(`      keytool -list -v -keystore "${keystorePath}" -alias ${ALIAS}`);
  console.log('    ⚠️ 立刻离机备份 keystore 与口令：Android 要求升级包同签名，丢了就只能卸载重装。');
}
void readFileSync;
