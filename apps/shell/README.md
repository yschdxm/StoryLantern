# Tauri v2 壳（apps/shell）

桌面 / Android / iOS 共用**同一份界面产物**（`apps/app`）。这里只放平台能力：
Rust 侧目前只有一条 `shell_info` 命令，用来证明宿主 IPC 通道可用——之后 `packages/wire`
的 Tauri 承载就接在这条通道上，界面代码不需要知道自己在 WebView 里还是浏览器里。

## 前置条件（本机已就位）

| 组件 | 位置 / 版本 |
|---|---|
| JDK（Android 构建） | Android Studio 自带 JBR 21：`C:\Program Files\Android\Android Studio\jbr` |
| Android SDK | `%LOCALAPPDATA%\Android\Sdk`（platform android-36/36.1、build-tools 36/37） |
| Android NDK | `%LOCALAPPDATA%\Android\Sdk\ndk\android-ndk-r27d`（r27d，clang 已校验） |
| Rust targets | `aarch64-linux-android`、`armv7-linux-androideabi`、`i686-linux-android`、`x86_64-linux-android` |
| Tauri CLI | 仓库 devDependency：`node_modules/.bin/tauri`（tauri-cli 2.12.2） |

## 构建（本机可用的路径）

本机有两个 Windows/网络限制，直接用 `tauri android build` 会失败，因此按下面的方式走：

```powershell
$env:JAVA_HOME       = "C:\Program Files\Android\Android Studio\jbr"
$env:ANDROID_HOME    = "$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_SDK_ROOT= $env:ANDROID_HOME
$env:NDK_HOME        = "$env:ANDROID_HOME\ndk\android-ndk-r27d"
$env:GRADLE_USER_HOME= "F:\dev\StoryForge\.gradle-home"   # 见下：避开失效代理

# 1) 前端产物
node apps/shell/build-frontend.mjs

cd apps/shell/src-tauri

# 2) Rust 侧交叉编译（产出 .so）——**必须给 linker**，否则报 `linker 'cc' not found`
#    （`tauri android build` 会自己设这些环境变量；我们绕开它，所以手动设）
$ndkBin = "$env:NDK_HOME\toolchains\llvm\prebuilt\windows-x86_64\bin"

# 真机（arm64）
cargo build --release --target aarch64-linux-android

# 模拟器（x86_64；Pixel_9 就是这个 ABI）
$env:CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER = "$ndkBin\x86_64-linux-android24-clang.cmd"
$env:CC_x86_64_linux_android  = "$ndkBin\x86_64-linux-android24-clang.cmd"
$env:CXX_x86_64_linux_android = "$ndkBin\x86_64-linux-android24-clang++.cmd"
$env:AR_x86_64_linux_android  = "$ndkBin\llvm-ar.exe"
cargo build --release --target x86_64-linux-android

# 3) 手动把 .so 放进 jniLibs（因为本机不允许建符号链接，见下）
$copy = @{
  'aarch64-linux-android' = 'arm64-v8a'
  'x86_64-linux-android'  = 'x86_64'
}
foreach ($t in $copy.Keys) {
  $dest = "gen/android/app/src/main/jniLibs/$($copy[$t])"
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Copy-Item "target/$t/release/libstorylantern_shell_lib.so" $dest -Force
}

# 4) 用 Gradle 出 APK（**只构建目标 ABI 的 flavor**，否则会去编另外 3 个 ABI）
cd gen/android
.\gradlew.bat assembleArm64Debug  --no-daemon --no-configuration-cache -x rustBuildArm64Debug
.\gradlew.bat assembleX86_64Debug --no-daemon --no-configuration-cache -x rustBuildX86_64Debug
# 产物：app/build/outputs/apk/<flavor>/debug/app-<flavor>-debug.apk
```

> 任务命名的坑：Rust 插件的任务名由 `archList` 与 `targetList` **按下标配对**决定。
> 传 `-PtargetList=x86_64` 不会得到 `rustBuildX86_64Debug`，而是让下标 0 的 arch（默认 arm64）
> 去编 x86_64 —— 任务名仍是 `rustBuildArm64Debug`。所以**别传** `-PtargetList`，
> 只排除与目标 flavor 同名的那一个 rust 任务即可。

## 四个限制与应对（都是本机环境问题，不是项目缺陷）

1. **符号链接被禁**：`tauri android build` 要把 `.so` 软链进 `jniLibs`，Windows 未开"开发者模式"时
   报 `Creation symbolic link is not allowed for this system`。两条路：开开发者模式（系统设置），
   或按上面第 3 步手动复制 + 直接跑 Gradle。当前走后者。
2. **Java 走了已停用的代理**：用户全局 `~/.gradle/gradle.properties` 指向 `127.0.0.1:7890`，
   而该代理没在运行，于是 Gradle 的下载全部 `Connection refused`（直连其实是通的）。
   应对：Gradle 发行版用 curl 直连抓进 `~/.gradle/wrapper/dists`，并建仓库内 `.gradle-home`
   （`wrapper` 与 `caches` 用 junction 复用，只放一份**不带代理**的 `gradle.properties`），
   构建时设 `GRADLE_USER_HOME` 指向它。**没有改动用户的全局配置。**
3. **配置缓存 keystore 抢锁**：共享 `caches` 时 Gradle 9.6.1 的 `cc-keystore` 锁被别的守护进程占用，
   因此构建加 `--no-configuration-cache`（或按上面的 `gradle.properties` 关闭）。
4. **Gradle 插件还会自己调 CLI 编 Rust**：`:app:rustBuild*` 任务会执行 `node tauri android
   android-studio-script`。我们已经自己编好 `.so`，因此用 `-x` 排除该任务，让 Gradle 只做打包。

## 已验证 / 未验证

- 已验证（可复现）：
  - `tauri android init` 成功；Rust 侧 **aarch64 与 x86_64 交叉编译都成功**（各约 1–2 分钟）；
  - **两个 ABI 的 debug APK 都打包成功**并逐项核对：
    `app-arm64-debug.apk` 16.10 MB（`lib/arm64-v8a/libstorylantern_shell_lib.so` 9.18 MB）、
    `app-x86_64-debug.apk` 16.57 MB（`lib/x86_64/…so` 9.66 MB）；
    `aapt2 dump badging` 显示 `package=app.storylantern`、`versionName=0.0.1`、
    `label='Story Lantern'`、`launchable-activity=app.storylantern.MainActivity`、`native-code='arm64-v8a'`。
- 未验证：**安装到设备并在界面里跑起来**。原因是本机沙箱禁止子进程监听端口
  （`vite preview` 报 `EACCES`；模拟器进程活着但 5554/5555 始终无监听，`adb devices` 为空），
  因此模拟器无法在本会话内完成 adb 连接。要完成这一步需要：
  在不受该限制的环境里跑本节命令，或接一台真机（`adb install -r app-arm64-debug.apk`）。
- 未验证：SQLite + SSE + WebView 版本矩阵（M0 移动端 spike 的验收项，需要上一步先成立）。
