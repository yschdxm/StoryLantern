# apps/shell —— 桌面 / Android / iOS 的外壳（Tauri v2 + Rust 宿主）

同一份界面产物（`apps/app`）跑在三个平台上；这里只放**平台能力**：宿主通过 `packages/wire`
向界面暴露少数几个服务（`shell`、`store`、`fs`…），界面代码不需要知道自己在 WebView 里还是在浏览器里。
"宿主能做什么"的**唯一事实源**是 `src-tauri/src/wire.rs` 里那张服务表。

构建方式、环境变量、Android 的渠道与签名矩阵、桌面端构建，以及各平台容易踩的坑，
都写在仓库根的 **[DEVELOPMENT.md](../../DEVELOPMENT.md)**。本文件只留两条与本目录强相关的提醒：

1. **`src-tauri/gen/` 是 Tauri 生成并 gitignore 的目录**：手改会在下一次 `tauri android init` 后丢掉，
   需要长期生效的改动必须写成脚本（见 `scripts/android-channel.mjs`、`scripts/android-signing-setup.mjs`）。
2. **Windows 未开"开发者模式"时，`tauri android build` 会因无法创建符号链接而失败**
   （`Creation symbolic link is not allowed for this system`）→ 本地统一走
   `node scripts/build-android.mjs`，它会按平台选择可行路径。
