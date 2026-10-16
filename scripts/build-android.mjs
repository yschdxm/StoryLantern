#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * 一条命令把 Android APK 构建出来（可复现）。
 *
 *   node scripts/build-android.mjs                 # 两个 ABI，debug
 *   node scripts/build-android.mjs --abi=arm64     # 只编手机那个 ABI
 *   node scripts/build-android.mjs --skip-frontend # 前端没改时跳过（省 1-2 分钟）
 *
 * 步骤（顺序不能变）：前端产物 → cargo(每个 ABI) → 拷 .so 进 jniLibs → gradle → 汇总 APK + 校验 16KB 对齐。
 *
 * **环境限制（照实说，不伪造）**：本仓库没有 CI、也没有发布签名密钥，所以这个脚本只产出 **debug** APK，
 * 从不假装"已签名发布"。要做 release 得先有 keystore（见 README 的说明），脚本不会替你造签名。
 *
 * 前置：Android SDK（ANDROID_HOME 或 %LOCALAPPDATA%\Android\Sdk）、NDK r27d、Rust 的
 * aarch64/x86_64-linux-android target、JDK（Android Studio 的 jbr 或 JAVA_HOME）。
 */

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((item) => item.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const abiFilter = flag('abi', 'both');
const skipFrontend = args.includes('--skip-frontend');

/**
 * 跨平台：CI 跑在 ubuntu 上，而开发机是 Windows。
 * 第一版把这些写死成 `gradlew.bat` 与 `windows-x86_64`，于是**只有本机能用**（CI 上必然失败）。
 */
const platformKey = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
const ndkHostTag = { win32: 'windows-x86_64', darwin: 'darwin-x86_64', linux: 'linux-x86_64' }[platformKey];
/** NDK 里的 clang 在 Windows 上是 `.cmd` 包装，其它平台没有后缀。 */
const ccSuffix = process.platform === 'win32' ? '.cmd' : '';
const gradlewName = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
/**
 * `--release` 产**签名** release APK：
 *  - 先跑 `scripts/android-signing-setup.mjs` 把发布签名接进生成的 Gradle 工程；
 *  - 没有 `.keystore/keystore.properties` 时 Gradle 会**明确失败**（不会静默用开发密钥签）；
 *  - 出包后用 apksigner 验签，并把证书指纹写进 build-info.json —— 签名是"声称"还是"事实"，看这一步。
 */
const profile = args.includes('--release') ? 'release' : 'debug';

const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk');
const ndkVersion = process.env.NDK_VERSION ?? 'android-ndk-r27d';
const ndkBin = join(sdk, 'ndk', ndkVersion, 'toolchains', 'llvm', 'prebuilt', ndkHostTag, 'bin');
/** Windows 上默认用 Android Studio 自带的 JDK；其它平台必须由 JAVA_HOME 指过来（CI 里 setup-java 会设）。 */
const javaHome = process.env.JAVA_HOME ?? (process.platform === 'win32' ? 'C:\\Program Files\\Android\\Android Studio\\jbr' : '');

const ABIS = [
  { name: 'arm64', target: 'aarch64-linux-android', jni: 'arm64-v8a', gradleTask: 'assembleArm64Debug', releaseTask: 'assembleArm64Release', skipTask: '-x rustBuildArm64Debug', releaseSkipTask: '-x rustBuildArm64Release', apk: join('app/build/outputs/apk/arm64/debug/app-arm64-debug.apk'), apkRelease: join('app/build/outputs/apk/arm64/release/app-arm64-release.apk'), cc: `aarch64-linux-android24-clang${ccSuffix}` },
  { name: 'x86_64', target: 'x86_64-linux-android', jni: 'x86_64', gradleTask: 'assembleX86_64Debug', releaseTask: 'assembleX86_64Release', skipTask: '-x rustBuildX86_64Debug', releaseSkipTask: '-x rustBuildX86_64Release', apk: join('app/build/outputs/apk/x86_64/debug/app-x86_64-debug.apk'), apkRelease: join('app/build/outputs/apk/x86_64/release/app-x86_64-release.apk'), cc: `x86_64-linux-android24-clang${ccSuffix}` },
];

for (const [label, path] of [['Android SDK', sdk], ['NDK 工具链', ndkBin], ['JDK', javaHome]]) {
  if (!existsSync(path)) {
    console.error(`找不到 ${label}：${path}\n可以设 ANDROID_HOME / NDK_VERSION / JAVA_HOME 覆盖。`);
    process.exit(1);
  }
}

const run = (label, command, commandArgs, cwd, env) => {
  process.stdout.write(`\n=== ${label} ===\n`);
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    console.error(`\n${label} 失败（退出码 ${result.status ?? 'null'}）`);
    process.exit(result.status ?? 1);
  }
};

const rustEnv = {
  RUSTFLAGS: '-C link-arg=-Wl,-z,max-page-size=16384',
  ...Object.fromEntries(
    ABIS.flatMap((abi) => {
      const upper = abi.target.toUpperCase().replace(/-/g, '_');
      return [
        [`CARGO_TARGET_${upper}_LINKER`, join(ndkBin, abi.cc)],
        [`CC_${abi.target.replace(/-/g, '_')}`, join(ndkBin, abi.cc)],
        [`CXX_${abi.target.replace(/-/g, '_')}`, join(ndkBin, abi.cc.replace('-clang.cmd', '-clang++.cmd'))],
        [`AR_${abi.target.replace(/-/g, '_')}`, join(ndkBin, process.platform === 'win32' ? 'llvm-ar.exe' : 'llvm-ar')],
      ];
    }),
  ),
};

const gradleEnv = {
  GRADLE_USER_HOME: join(root, '.gradle-home'),
  JAVA_HOME: javaHome,
  ANDROID_HOME: sdk,
  ANDROID_SDK_ROOT: sdk,
  NDK_HOME: join(sdk, 'ndk', ndkVersion),
};

const wanted = ABIS.filter((abi) => abiFilter === 'both' || abiFilter === abi.name);
if (wanted.length === 0) {
  console.error(`--abi 只能是 both / arm64 / x86_64，收到 ${abiFilter}`);
  process.exit(1);
}

// 原生覆盖（MainActivity.kt / SafPlugin.kt）必须先套进 gen/android，否则改了 Kotlin 也不会生效——
// 这一步以前是手工跑的，忘了就会用旧的覆盖去构建，产物看起来"成功"但行为没变。
run('套用原生覆盖（MainActivity.kt / SafPlugin.kt → gen/android）', 'node', ['apps/shell/android/apply-overrides.mjs'], root, {});

// 发布签名也是"生成工程上的改动"，同样要先套（gen/ 是 Tauri 生成的、本仓库把它 gitignore 了，
// 所以补丁必须每次构建前重放一次；脚本是幂等的）。
if (profile === 'release') {
  run('接入发布签名（读 .keystore/keystore.properties）', 'node', ['scripts/android-signing-setup.mjs'], root, {});
}

if (!skipFrontend) {
  run('前端产物（Tauri 把 assets 编译进 .so，必须先跑）', 'node', ['apps/shell/build-frontend.mjs'], root, {});
}

for (const abi of wanted) {
  run(`cargo ${abi.target}`, 'cargo', ['build', '--release', '--target', abi.target, '--features', 'custom-protocol'], join(root, 'apps/shell/src-tauri'), rustEnv);
  const so = join(root, 'apps/shell/src-tauri/target', abi.target, 'release/libstorylantern_shell_lib.so');
  const dest = join(root, 'apps/shell/src-tauri/gen/android/app/src/main/jniLibs', abi.jni, 'libstorylantern_shell_lib.so');
  mkdirSync(join(root, 'apps/shell/src-tauri/gen/android/app/src/main/jniLibs', abi.jni), { recursive: true });
  writeFileSync(dest, readFileSync(so));
  console.log(`  已放入 jniLibs：${abi.jni}（${(statSync(dest).size / 1024 / 1024).toFixed(2)} MB）`);

  // Android 15+ 要求 16KB 页对齐；不对齐的 .so 会在新设备上直接装不上，所以在这里就拦下来。
  const readelf = spawnSync(join(ndkBin, process.platform === 'win32' ? 'llvm-readelf.exe' : 'llvm-readelf'), ['-l', so], { encoding: 'utf8', shell: true }).stdout ?? '';
  const load = readelf.split('\n').find((line) => line.includes('LOAD'));
  const align = load === undefined ? '?' : load.trim().split(/\s+/).at(-1);
  if (align !== '0x4000') {
    console.error(`  ${abi.name} 的 LOAD 对齐是 ${align}，不是 0x4000（16KB）——装到 Android 15+ 设备会失败`);
    process.exit(1);
  }
  console.log(`  LOAD 对齐 ${align}（16KB）✓`);
}

for (const abi of wanted) {
  const task = profile === 'release' ? abi.releaseTask : abi.gradleTask;
  const skip = profile === 'release' ? abi.releaseSkipTask : abi.skipTask;
  run(`gradle ${task}`, gradlewName, [task, '--no-daemon', '--no-configuration-cache', '--console=plain', skip], join(root, 'apps/shell/src-tauri/gen/android'), gradleEnv);
}

/** 用 apksigner 验签：签名是"声称"还是"事实"，只看这一步。 */
const verifySignature = (apkPath) => {
  const buildTools = join(sdk, 'build-tools');
  const versions = existsSync(buildTools) ? readdirSync(buildTools).sort() : [];
  const latest = versions.at(-1);
  if (latest === undefined) return { ok: false, reason: '找不到 build-tools，无法验签' };
  const apksigner = join(buildTools, latest, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner');
  const result = spawnSync(apksigner, ['verify', '--print-certs', apkPath], { encoding: 'utf8', shell: true });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const dn = /certificate DN: (.+)/.exec(output)?.[1]?.trim();
  // 这个 apksigner 版本平时不打 "Verified using vN scheme…"，只在 -v 下打；
  // 但它一定会打 "V1 Signer:" / "V2 Signer:" / "V3 Signer:" —— 按真实输出解析，别按记忆。
  const verified = [
    ...new Set([...output.matchAll(/^(V\d) Signer:/gm)].map((match) => (match[1] ?? '').toLowerCase())),
  ];
  return result.status === 0
    ? { ok: true, dn: dn ?? '(未解析到 DN)', schemes: verified }
    : { ok: false, reason: output.trim().split('\n')[0] ?? `apksigner 退出码 ${result.status}` };
};

const builtAt = new Date().toISOString();
const apks = wanted.map((abi) => {
  const relative = profile === 'release' ? abi.apkRelease : abi.apk;
  const path = join(root, 'apps/shell/src-tauri/gen/android', relative);
  if (!existsSync(path)) {
    console.error(`没找到产出的 APK：${path}`);
    process.exit(1);
  }
  const bytes = readFileSync(path);
  const signature = verifySignature(path);
  if (profile === 'release' && !signature.ok) {
    // 发布包必须是真签名：验不过就直接失败，不产出"看起来成功"的包
    console.error(`  ✗ release APK 验签失败：${signature.reason}`);
    process.exit(1);
  }
  return {
    abi: abi.name,
    path: relative,
    mb: Number((bytes.length / 1024 / 1024).toFixed(2)),
    sha256: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
    signature,
  };
});

const outDir = join(root, '.apk-out');
mkdirSync(outDir, { recursive: true });
for (const apk of apks) {
  writeFileSync(
    join(outDir, `storylantern-${apk.abi}-${profile}.apk`),
    readFileSync(join(root, 'apps/shell/src-tauri/gen/android', apk.path)),
  );
}
const info = {
  builtAt,
  abis: apks,
  profile,
  // 应用里显示的"构建 {{stamp}}"来自前端构建注入的 __BUILD_STAMP__（见 apps/shell/build-frontend.mjs），
  // 这里只记下这次构建的时间与产物指纹，方便回溯"手机上装的是哪一次构建"。
  signed: profile === 'release' && apks.every((apk) => apk.signature.ok),
  // 签名不是"声称"：release 由 apksigner 验过（证书 DN 与方案记在上面），debug 用仓库里那把开发密钥。
  note:
    profile === 'release'
      ? 'release：已用 .keystore/keystore.properties 指向的密钥签名，并经 apksigner verify 验证'
      : 'debug：用 .keystore/storylantern-dev.jks 签名（口令写在仓库文档里，只用于本机测试）',
};
writeFileSync(join(outDir, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`, 'utf8');

console.log('\n=== 完成 ===');
for (const apk of apks) {
  console.log(`  ${apk.abi}: .apk-out/storylantern-${apk.abi}-${profile}.apk  ${apk.mb} MB  sha256:${apk.sha256}…`);
  if (apk.signature.ok) {
    console.log(`    签名 ✓ ${apk.signature.schemes.join('/') || '(方案未解析)'}  DN: ${apk.signature.dn}`);
  }
}
console.log(`  构建信息：.apk-out/build-info.json（${builtAt}；${info.profile}${info.signed ? '，已验签' : ''}）`);
