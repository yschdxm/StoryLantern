# 开发说明（Development）

面向要**改代码、写插件、自己构建或发版**的人。只想用的话看 DEVELOPMENT.md。

## 一、前置环境

| 用途 | 需要 |
|---|---|
| 跑门禁/测试/类型 | **Node ≥ 22.18**（或 24）、**pnpm** |
| 构建 Android APK | Rust + `aarch64-linux-android`/`x86_64-linux-android` 目标、**Android SDK**、**NDK**（脚本默认 `android-ndk-r27d`）、**JDK 17+**（Android Studio 自带的可） |
| 构建桌面端 | Rust；Linux 还需要 `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf` |

环境变量：`ANDROID_HOME`（或 `ANDROID_SDK_ROOT`）、`NDK_VERSION`、`JAVA_HOME` 可覆盖脚本默认值。

## 二、常用命令

```bash
pnpm install                 # 只有 typecheck / 桌面 / Android 构建需要它；门禁与全部测试零依赖

node scripts/check-boundaries.mjs   # 门禁：单文件 ≤400 行、依赖方向、禁 any、文本 UTF-8
node scripts/check-bundle.mjs       # 体积与"产物里不许有裸依赖"
npm run typecheck                   # TypeScript 零错误
node --test --test-reporter=spec "packages/**/*.test.ts" "apps/**/*.test.ts" \
  "plugins/**/*.test.ts" "fixtures/**/*.test.ts" "eval/**/*.test.ts"   # 全部测试
npm run perf                        # 性能预算（每行都给实测值与预算，超了返回非零）
npm run check                       # 门禁 + 体积 + 全部测试
npm run release:check               # 上面这些 + 类型 + 产物 + 可复现构建 + cargo
```

> 测试命令**必须用 glob**（`node --test <目录>` 会把目录当模块去 require，在 CI 上必挂）。

## 三、仓库结构

```
packages/     内核与领域：kernel(插件内核/组合) plugin-api(插件唯一依赖) oplog(操作日志/事件溯源)
              sync-core(同步协议) lore(世界书扫描) importer(导入) tuner(调优) i18n wire(宿主通信)
plugins/      功能都以插件形态存在：blocks pipeline sync-* memory-* tuner-agent locale settings log-sink …
apps/         app = 前端(React)   shell = 桌面/移动外壳(Tauri + Rust 宿主)
bundles/      组合配置：core / sync / … 的 patch 行决定"这次激活哪些插件与配置"
fixtures/     导入器的真实样本与畸形输入
eval/         golden 快照、长对话评估、性能预算
scripts/      门禁、构建、打包、签名、发布校验和
```

## 四、必须先知道的硬约束

1. **零第三方运行时依赖**：`packages/`、`plugins/`、`bundles/` 只用 Node/Web 内置能力；
   前端只允许 React（PLAN 选型）且产物里不许出现裸依赖（`check-bundle.mjs` 把关）。
2. **单文件 ≤ 400 行**，核心包**禁用 `any`** —— 门禁会拦。
3. **`plugin-api` 是插件作者的唯一依赖**；插件不要直接 import 别的内部包。
4. **操作日志是唯一事实源**：状态由 op 日志重放得出；不要绕过日志直接改状态。
5. **密钥/口令/用户数据绝不入库**：keystore、`keystore.properties`、`.env`、测试产物目录都在 `.gitignore` 里。
6. **不写替代性宣称**：文档与注释里"已验证"的话必须能指向一条测试、一段脚本输出或一张截图；
   做不到就写"未验证 + 缺什么"。

## 五、写一个插件（最小骨架）

```ts
// plugins/hello/src/index.ts
import type { PluginContext } from '../../../packages/plugin-api/src/index.ts';

export const name = 'hello';

export function apply(ctx: PluginContext, config: { greeting?: string } = {}): void {
  // 注册一个上下文块：出现在发给模型的提示里，并且 Inspector 会显示"为什么在/为什么被裁掉"
  ctx.get('context.blocks')?.register('hello', {
    id: 'hello',
    placement: 'system',
    priority: 50,
    render: () => config.greeting ?? '你好。',
  });
}
```

然后在 `bundles/` 的 patch 里加两行把它激活（`insert`/`set`），并**补一条测试**：
删掉 patch 行后功能必须消失（这是"没有特性被硬编码"的验收方式）。

> `apps/shell/src-tauri/gen/` 是 Tauri **生成**的目录（已 gitignore）。任何时候手改都会被下一次
> `tauri android init` 丢掉 —— 需要长期生效的改动要写成脚本（仓库里 `scripts/android-*.mjs` 就是这种）。

## 六、构建 Android

```bash
node scripts/build-android.mjs --abi=arm64                      # 本地：dev 渠道、debug 形态、测试密钥
node scripts/build-android.mjs --release --abi=arm64 --channel=prod --key=prod   # 生产渠道（需发布密钥）
```

**渠道与密钥是两件事**，三个渠道的包名互不相同（因此可以同时装在手机上）：

| 渠道 | 谁构建 | 包名 | 形态 | 密钥 |
|---|---|---|---|---|
| `dev` | 你的机器 | `app.storylantern.dev` | **debug**（只留本地） | 测试密钥（口令公开，仅供本地/CI 测试） |
| `test` | GA `release-test.yml` | `app.storylantern.test` | **release，与生产同形态** | 生产密钥 |
| `prod` | GA `release-prod.yml`（打 tag） | `app.storylantern` | release | 生产密钥 |

- **版本**：`test` 与 `prod` 的 `versionCode` 由版本号算出（`major*10000+minor*100+patch`）；
  **生产版不许回退** —— `node scripts/check-version-no-rollback.mjs --version=X.Y.Z` 会在发布前拦住。
- **发布密钥**：只从仓库外的 `.keystore/keystore.properties` 读；缺了会**明确失败**，不会静默用测试密钥签。
  生成方式：`node scripts/make-android-keystore.mjs`（口令走环境变量，不进命令行、不打印）。
- **平台差异**：Linux/macOS 由 `tauri android build` 驱动（它生成自己那批文件）；
  **Windows 上 CLI 会往 jniLibs 建符号链接**，没开"开发者模式"的系统不允许 → Windows 改走
  "复制 .so + 直接调 gradle"，并由脚本代生成那两个文件。

## 七、构建桌面端

```bash
cd apps/shell && pnpm exec tauri build      # 产物在 src-tauri/target/release/bundle/
```

不买代码签名证书：产物**未签名**，用户用 `SHA256SUMS`(+GPG) 核对来源（README 第六节写了怎么核）。
生成校验和：`node scripts/release-checksums.mjs`。

## 八、发布（维护者）

1. 打 tag：`v0.1.0`（版本号不许回退；生产 `versionCode` 由它算出）；
2. `release-prod.yml` 会跑：门禁/类型/全部测试 → 生产签名 APK → 三平台桌面包 → `SHA256SUMS`（可选 GPG 签名）；
3. 需要的 GitHub secrets（**只放名字，值不进仓库**）：
   - `ANDROID_KEYSTORE_BASE64`：发布 keystore 的 base64；
   - `ANDROID_KEYSTORE_PROPERTIES`：`keystore.properties` 全文；
   - 可选 `GPG_PRIVATE_KEY` / `GPG_PASSPHRASE`：给 `SHA256SUMS` 签名。
   设置方式（值只从 stdin 进，不经过命令行）：
   `cmd /c "gh secret set ANDROID_KEYSTORE_BASE64 < 文件"`（Windows）或 `gh secret set … < 文件`（bash）。

## 九、提交 PR 的期望

1. 先跑 `npm run check`（门禁 + 体积 + 全部测试），涉及 Rust 再加 `cargo check`；
2. 改了什么、**怎么验证的**写清楚；数字要能复现（贴命令与输出，不贴结论）；
3. 新增能力请**以插件形态**加，并给出"删掉激活行后功能消失"的测试；
4. 不要提交任何密钥、口令、用户数据或测试产物目录。
