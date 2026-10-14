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
$env:RUSTFLAGS       = '-C link-arg=-Wl,-z,max-page-size=16384'   # 见下：16KB 页

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

# 5) 校验（两道，都值得跑）
$zipalign = "$env:ANDROID_HOME\build-tools\<最新版本>\zipalign.exe"
& $zipalign -c -P 16 -v 4 app\build\outputs\apk\x86_64\debug\app-x86_64-debug.apk   # 16KB 对齐
& "$ndkBin\llvm-readelf.exe" -l ..\..\target\x86_64-linux-android\release\libstorylantern_shell_lib.so | Select-String LOAD  # 0x4000
```

> 任务命名的坑：Rust 插件的任务名由 `archList` 与 `targetList` **按下标配对**决定。
> 传 `-PtargetList=x86_64` 不会得到 `rustBuildX86_64Debug`，而是让下标 0 的 arch（默认 arm64）
> 去编 x86_64 —— 任务名仍是 `rustBuildArm64Debug`。所以**别传** `-PtargetList`，
> 只排除与目标 flavor 同名的那一个 rust 任务即可。

## 在模拟器里跑起来（本机已实测）

```powershell
# 1) 模拟器：端口必须避开 Windows/Hyper-V 保留段（5554/5555 都在里面！），图形后端用 -gpu off
#    （swiftshader 在本机会卡在 Vulkan 初始化）
& "$env:ANDROID_HOME\emulator\emulator.exe" -avd Pixel_9 -no-window -no-audio -no-boot-anim `
    -no-snapshot -gpu off -port 6554 -no-metrics

# 2) adb 连非默认端口
adb connect 127.0.0.1:6555
adb -s 127.0.0.1:6555 wait-for-device

# 3) 安装 + 启动
adb -s 127.0.0.1:6555 install -r app-x86_64-debug.apk
adb -s 127.0.0.1:6555 shell am start -n app.storylantern/.MainActivity

# 4) **debug 构建走 devUrl**（WebView 请求 http://127.0.0.1:15199/），
#    而模拟器里的 127.0.0.1 是它自己 —— 必须把端口反向映射到宿主机：
#    （宿主机先起 dev/preview：apps/app 里 `vite --port 15199`）
adb -s 127.0.0.1:6555 reverse tcp:15199 tcp:15199

# 5) 截图取证
adb -s 127.0.0.1:6555 shell screencap -p /sdcard/s.png; adb -s 127.0.0.1:6555 pull /sdcard/s.png shot.png
```

实测结果（Android 17 / SDK 37 / x86_64 / 16KB 页 / WebView 145）：
`Status: ok`、`Displayed app.storylantern/.MainActivity +801ms`、界面渲染出
`7 PLUGINS ACTIVE` 与 `CONTEXT GRAPH`（截图见 `docs/assets/android-ui.png` 与 `android-promptgraph.png`）。

## 四个坑与应对（本机环境，不是项目缺陷）

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

### 另外两个容易误判成"权限问题"的坑

5. **`EACCES` 通常是端口保留段，不是权限**：`vite preview`、模拟器 console/adb 端口如果落在
   Windows/Hyper-V 的动态保留段里，`listen` 会直接 `EACCES`（本机保留段含 5141–5240、
   5458–5557、5558–5657…）。查：`netsh interface ipv4 show excludedportrange protocol=tcp`；
   换到段外端口即可（本项目界面用 **15199**，模拟器用 **6554/6555**）。
   注意 **Vite 默认的 5173 在本机也在保留段内**。
6. **16KB 页镜像要求原生库 16KB 对齐**：否则系统弹 "This app isn't 16 KB compatible" 并以兼容模式运行。
   需要 Rust 侧 `-C link-arg=-Wl,-z,max-page-size=16384`（`LOAD` 段对齐 `0x4000`）
   与 APK 内 `zipalign -P 16`（AGP 新版默认满足）。

## 已验证 / 未验证

- **已验证（可复现）**：
  - Rust 侧 aarch64 与 x86_64 交叉编译；
  - 双 ABI debug APK 打包（arm64 16.10 MB / x86_64 16.57 MB），`aapt2 dump badging`
    显示 `package=app.storylantern`、`versionName=0.0.1`、`label='Story Lantern'`、
    `launchable-activity=app.storylantern.MainActivity`、`native-code=arm64-v8a`；
  - **在 Android 17 模拟器上安装、启动、渲染出界面**（`7 PLUGINS ACTIVE` 由 bundle patch 组合而来，
    `CONTEXT GRAPH` 显示每块的纳入/裁掉与理由）；
  - `zipalign -c -P 16` 通过。
- **未验证**：SSE 流式与 SQLite 在设备上的专项验证；release 签名 APK（当前 debug 依赖
  `adb reverse` 连 dev server；release 会把 `frontendDist` 打进包里，但需要签名配置）。
