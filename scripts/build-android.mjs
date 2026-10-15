#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk');
const ndkVersion = process.env.NDK_VERSION ?? 'android-ndk-r27d';
const ndkBin = join(sdk, 'ndk', ndkVersion, 'toolchains', 'llvm', 'prebuilt', 'windows-x86_64', 'bin');
const javaHome = process.env.JAVA_HOME ?? 'C:\\Program Files\\Android\\Android Studio\\jbr';

const ABIS = [
  { name: 'arm64', target: 'aarch64-linux-android', jni: 'arm64-v8a', gradleTask: 'assembleArm64Debug', skipTask: '-x rustBuildArm64Debug', apk: join('app/build/outputs/apk/arm64/debug/app-arm64-debug.apk'), cc: 'aarch64-linux-android24-clang.cmd' },
  { name: 'x86_64', target: 'x86_64-linux-android', jni: 'x86_64', gradleTask: 'assembleX86_64Debug', skipTask: '-x rustBuildX86_64Debug', apk: join('app/build/outputs/apk/x86_64/debug/app-x86_64-debug.apk'), cc: 'x86_64-linux-android24-clang.cmd' },
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
        [`AR_${abi.target.replace(/-/g, '_')}`, join(ndkBin, 'llvm-ar.exe')],
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
  const readelf = spawnSync(join(ndkBin, 'llvm-readelf.exe'), ['-l', so], { encoding: 'utf8', shell: true }).stdout ?? '';
  const load = readelf.split('\n').find((line) => line.includes('LOAD'));
  const align = load === undefined ? '?' : load.trim().split(/\s+/).at(-1);
  if (align !== '0x4000') {
    console.error(`  ${abi.name} 的 LOAD 对齐是 ${align}，不是 0x4000（16KB）——装到 Android 15+ 设备会失败`);
    process.exit(1);
  }
  console.log(`  LOAD 对齐 ${align}（16KB）✓`);
}

for (const abi of wanted) {
  run(`gradle ${abi.gradleTask}`, 'gradlew.bat', [abi.gradleTask, '--no-daemon', '--no-configuration-cache', '--console=plain', abi.skipTask], join(root, 'apps/shell/src-tauri/gen/android'), gradleEnv);
}

const builtAt = new Date().toISOString();
const apks = wanted.map((abi) => {
  const path = join(root, 'apps/shell/src-tauri/gen/android', abi.apk);
  if (!existsSync(path)) {
    console.error(`没找到产出的 APK：${path}`);
    process.exit(1);
  }
  const bytes = readFileSync(path);
  return { abi: abi.name, path: abi.apk, mb: Number((bytes.length / 1024 / 1024).toFixed(2)), sha256: createHash('sha256').update(bytes).digest('hex').slice(0, 16) };
});

const outDir = join(root, '.apk-out');
mkdirSync(outDir, { recursive: true });
for (const apk of apks) {
  writeFileSync(join(outDir, `storylantern-${apk.abi}-debug.apk`), readFileSync(join(root, 'apps/shell/src-tauri/gen/android', apk.path)));
}
const info = {
  builtAt,
  abis: apks,
  profile: 'debug',
  // 应用里显示的"构建 {{stamp}}"来自前端构建注入的 __BUILD_STAMP__（见 apps/shell/build-frontend.mjs），
  // 这里只记下这次构建的时间与产物指纹，方便回溯"手机上装的是哪一次构建"。
  signed: false,
  note: '本仓库没有 CI、也没有发布签名密钥：只产出 debug APK，不伪造签名。',
};
writeFileSync(join(outDir, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`, 'utf8');

console.log('\n=== 完成 ===');
for (const apk of apks) console.log(`  ${apk.abi}: .apk-out/storylantern-${apk.abi}-debug.apk  ${apk.mb} MB  sha256:${apk.sha256}…`);
console.log(`  构建信息：.apk-out/build-info.json（${builtAt}；未签名，仓库无 CI/密钥）`);
