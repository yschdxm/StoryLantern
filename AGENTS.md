# AGENTS.md

> 给 coding agent 的仓库级指令（**当前只写 UI 部分**；数据层/宿主/同步/插件/发布后续补）。
> 本文件遵循 [AGENTS.md 开放规范](https://agents.md/) 的"README for agents"写法：**命令优先、精简、不重复门禁能查的规则**；依据见 §13。
> 结构约定：本文件在仓库根；将来按模块可在子目录放 `AGENTS.md` 或 `AGENTS.override.md`（就近优先；注意 Codex 默认读取上限 32 KiB）。

## 0. 快速开始（命令优先）

```bash
# 环境：Node ≥22.18（或 24）、pnpm；不要新增运行时依赖
pnpm install                                   # 仅 typecheck / 构建 / Android 需要

node scripts/check-boundaries.mjs              # 架构门禁（≤400 行/文件、依赖白名单、UTF-8）
npm run typecheck                              # 类型零错误
node --test "apps/app/**/*.test.ts"            # UI/数据层单测
node apps/shell/build-frontend.mjs             # 构建前端（Tauri 的 frontendDist）
node scripts/check-bundle.mjs                  # 产物体检（无 node: 内置、无 .map）
pnpm exec playwright test                      # e2e（Pixel 7 视口 + 触摸）

# 本地看界面（构建产物，不是 dev server）
node apps/shell/build-frontend.mjs
pnpm --filter @storylantern/app exec vite preview --port 15199 --strictPort
```

## 1. 硬约束（违反即失败）

- **运行时零第三方依赖**：界面只允许 React；`typescript`、`@playwright/test` 是仅有的 devDependency。不要 `pnpm add` 运行时包。
- **单文件 ≤400 行**；`apps/app/src/main.tsx` 已约 392 行（贴着上限），**不许再变长**：要加页面先抽组件/路由分发。
- 文本文件必须 UTF-8；不伪造：不用假数据/示例功能冒充实现，不在报告或提交信息里写没跑过的结论。
- **术语**：英文 design token 统一称**设计变量（样式变量）**，不写"令牌"。
- 中文优先；界面文案中英双语，中文为主。

## 2. 当前 UI 实现状态（先读，别重造）

- **卡片模型已落地**（ADR-0011，`packages/cards`）：角色 / 场景 / 物品 / 典籍四类卡 + 会话开局配置 + 运行时补丁；
  角色列表/会话读的是**卡片兼容视图**（`data/character-compat.ts`），旧 `scenario`/开场白在 CompatStash 草稿里。
- **卡片启停与激活**（`packages/cards/src/activation.ts`）：库级启停（op `card.library`）+ 会话资源池
  `SessionSetup.mounts` + 会话 `overrides`；没参与的卡连同原因进「本次请求」面板。新卡片功能不要另造"注册列表"。
- 角色编辑器：`screens/CharacterEditScreen.tsx` + `screens/character-edit/*`（基本信息/身份/人格/语言/示例/状态变量/高级+启停）。
- 世界页（第三标签）：`screens/WorldScreen.tsx`（L1 列表 + 类型筛选 + 新建）+ `screens/world-edit/`
  （场景/物品/典籍编辑器；纯表单逻辑在 `world-form.ts`）。路由：`#/world`、`#/worldcard/<kind>/<id>`。
- 会话创建：`#/session/new` → `screens/SessionCreateScreen.tsx`（成员/世界池/处境/开场模式），
  写 `session.create + session.setup + 可选开场消息`（`createWithSetup`，纯函数在 `data/session-create-ops.ts`）。
- 酒馆导入/导出：`data/import-cards.ts` / `data/export-cards.ts`（能映射的映射；`scenario`/开场白进 CompatStash 草稿；
  `character_book` → 典籍卡 + 世界包）。`ImportScreen` 走卡片仓储，不再写旧 characters/lorebooks。
- 条件表达式：`packages/cards/src/expr.ts`；规则块 `data/prompt-rules.ts`、典籍块 `data/prompt-lore.ts`。
  **未知变量/类型不匹配是错误**（跳过并计数），不许静默当 false。
- 设置页已三级分层：`screens/SettingsScreen.tsx`（约 65 行薄壳）+ `settings/SettingsHome.tsx`（L1）+ 6 个分区页 `settings/{Model,Appearance,Sync,Data,Advanced,About}Settings.tsx`。新增设置项**放进对应分区页**，不要往外壳加内容。
- 设置行复用 `ui/SettingsRow.tsx`（label + 当前值 + 箭头/行内控件，≥44px）。
- 设计变量在 `styles.css` 顶部 `:root`（间距/字阶/圆角/阴影/层级/动效/聚焦环/触控/语义色，暗亮 system 三态）。
- 无障碍基线已全局提供：`:focus-visible`、`prefers-reduced-motion` 归零、`.sr-only`。
- 视觉设定：四类卡共用 `screens/visuals-edit/VisualsSection.tsx` + `data/visuals-form.ts`；
  **caption 是给模型的入口，图可后补**（`VisualAsset.path` 可选；有图必须 `asset://<sha256>`）。
  图片上传/资产同步**尚未接线**，界面只能手填 asset 引用——不要在文档里说已支持上传。
- 已知限制：物品 `behaviors` 与角色 `rules` 仍无编辑 UI（数据与求值器已就绪）；世界包编辑器未做（只读清单）；
  L3 无独立 URL（设置分区）；详见 ADR-0011 与 `docs/SETTINGS-IA.md §8`。
- **hash 路由必须对实体 id 编解码**（`router.ts` 的 `encodePart`/`decodePart`）：id 不保证是 ASCII，漏了会出现"找不到这张卡片"。

## 3. 代码边界

| 层 | 目录 | 可以写 | 禁止 |
|---|---|---|---|
| 原语 | `apps/app/src/ui/` | 可复用组件（单件 ≤80 行） | 业务逻辑、`data/` 依赖 |
| 屏幕 | `apps/app/src/screens/`、`apps/app/src/settings/` | 读 store、调 action、组合原语 | 直接 `localStorage`/`fetch`/op 日志 |
| 数据 | `apps/app/src/data/` | 纯逻辑（必须能在 Node 测） | React / DOM |
| 组合/路由 | `apps/app/src/app/`、`main.tsx` | 路由、store、运行时 | 业务 UI；让 `main.tsx` 变长 |

能写成纯函数的必须放 `data/` 并配 Node 测试；屏幕只做"展示 + 事件转发"。

## 4. UI 规则（must）

**样式**：只用设计变量，禁止字面量与 `#hex`。

| 类别 | 变量 |
|---|---|
| 间距 | `--space-1..10`（4/8/12/16/20/24/32/40/48/64）、`--gap-inline`、`--gap-stack`、`--pad-screen`、`--pad-card` |
| 字阶/行高 | `--text-xs(12)/-sm/-md/-lg/-xl`、`--leading-*`；**禁止 <12px** |
| 圆角 | `--radius-sm/--radius/--radius-lg/--radius-pill` |
| 颜色 | `--bg/--surface/--surface-2/--border/--text/--dim/--muted/--accent/--accent-text/--accent-soft/--danger/--danger-text/--ok/--warn`（三态都要有值） |
| 阴影/层级/动效 | `--shadow-1/2`；`--z-*`；`--dur-*/--ease-standard` |
| 无障碍 | `--focus-ring`、`--tap-min(44px)`、`--selection-bg` |

**组件**：交互原语必须覆盖 hover/active/focus-visible/disabled/loading/invalid；图标按钮有 `aria-label`；输入走 `Field`；弹层要有焦点陷阱 + Esc + 滚动锁 + `--z-*` 分档；**一屏一个主按钮**；空态用 `EmptyState` 五要素。

**层级**：最多 3 层（L1 根级 → L2 列表/分区，**每页 ≤7 行** → L3 详情/编辑）；L2 行 = 标题 + **当前值/状态** + 箭头（不写解释）。

**i18n**：禁止硬编码中文/英文（含 aria/placeholder/title）；文案进 `i18n/catalog-{zh,en}-*.ts` 分片后合并到 `messages.ts`；Markdown 不解析（不要 `**`/链接语法）；英文按中文 +40% 预留；失败文案四段式（现象→原因→下一步→兜底）。

## 5. 新增界面（步骤）

1. `app/router.ts` 加路由（`parseRoute`、`parentOf`、底栏高亮）；
2. `screens/XxxScreen.tsx` 或 `settings/XxxSettings.tsx`，套 `AppShell`；
3. 只读 `store`，写走 `store.actions.*`；异步结果必须可见（Banner/Toast/行内状态），**禁止静默 catch**；
4. 文案进 catalog 分片；
5. 样式只用设计变量（BEM 类名，加在 `styles.css` 对应段落）；
6. 纯逻辑抽 `data/` + Node 测试；交互加 e2e 断言（打开、关键点击、无 pageerror）；
7. Playwright（Pixel 7）截图到 `docs/screenshots/`，文档引用；
8. 跑 §6 全部门禁。

## 6. 验证（必须全绿并逐条贴输出）

```bash
node scripts/check-boundaries.mjs && npm run typecheck
node --test "apps/app/**/*.test.ts"
node apps/shell/build-frontend.mjs && node scripts/check-bundle.mjs
pnpm exec playwright test
```

**真机验证（UI 改动必做，不能只靠浏览器）**：

```bash
adb devices
node scripts/build-android.mjs --channel=prod --abi=arm64   # 同 applicationId + 测试密钥 → 可覆盖安装、保留数据
adb -s <serial> install -r .apk-out/storylantern-arm64-debug.apk
adb -s <serial> shell am start -n app.storylantern/.MainActivity
# 截图必须二进制安全（不要用 PowerShell 的 > 重定向，会坏 PNG）
adb -s <serial> shell screencap -p /sdcard/shot.png && adb -s <serial> pull /sdcard/shot.png docs/screenshots/device/xx.png
adb -s <serial> logcat -d -t 400 | grep -E "FATAL EXCEPTION|ANR in"   # 必须为空
```

判据：目标页面在真机上渲染正确（当前值、安全区、无截断）、无 FATAL/ANR、返回栈正常。

## 7. Code Review Rules（Codex 的 GitHub Review 会读这一节）

- 组件里出现字面量颜色/字号/间距/圆角/z-index → **flag**（正确做法：改用 §4 的设计变量）。
- 屏幕直接 `localStorage`/`fetch`/读 op 日志 → flag（走 `data/` 端口）。
- 静默 `catch` 或失败无可见反馈 → flag（四段式文案 + 可见状态）。
- 单文件 >400 行、`main.tsx` 变长 → flag（拆组件/纯函数）。
- 新增硬编码中英文案 → flag（进 catalog 分片）。
- 改动 UI 但没跑 e2e 或没真机验证 → flag（§6）。
- 用假数据/示例功能冒充实现 → block（违反诚实纪律）。

## 8. 禁止清单

1. 新增运行时依赖；改 Rust/wire/op 日志/同步逻辑（不在 UI 范围）；
2. `innerHTML`/`dangerouslySetInnerHTML`；
3. 单文件 >400 行 或 让 `main.tsx` 变长；
4. 用示例/假数据冒充功能；
5. 提交信息写没验证过的结论。

## 9. 本仓库真实踩过的坑

| 坑 | 正确做法 |
|---|---|
| 未定义设计变量（`--accent-soft`）→ 界面冒兜底蓝 | 新变量在 `:root` + 亮/system 都定义 |
| 11px 小字（`0.69rem`） | 最低 `--text-xs`(12px) |
| 键盘弹起盖住 `position: fixed` 元素 | 用 `height: var(--app-height)` 或相对 `.app` 定位 |
| 空态 CTA 与 FAB 两个主按钮 | 一屏一主按钮；空态有 CTA 时隐藏 FAB |
| 设置页越改越长（曾 398 行） | 迁到 `settings/` 分区页 |
| 文案里的 `**` 原样显示 | Markdown 不解析 |
| e2e 用中文文案选择器 → en CI 挂 | 用 id/结构选择器 |
| 用 PowerShell `>` 重定向抓 adb 截图 → PNG 损坏 | `screencap` + `adb pull` |

## 10. 汇报格式

```
1) 改动文件（按层归类，标行数）
2) 用户可见变化（哪些屏/哪些行，当前值怎么显示）
3) 自验（逐条命令 + 退出码/关键输出 + 截图路径；UI 改动附真机截图）
4) 未做 / 风险（如实写）
```

## 11. 后续范围（本文件当前只有 UI）

数据层（op 日志/物化/仓储/迁移）、宿主（Rust/wire/SQLite）与安全纪律、同步协议与测试、插件开发、构建发布/CI。

## 12. 路径速查

| 要改什么 | 去哪 |
|---|---|
| 设计变量/全局样式 | `apps/app/src/styles.css` 顶部 |
| 通用组件 / 设置行 | `apps/app/src/ui/components.tsx`、`apps/app/src/ui/SettingsRow.tsx` |
| 设置首页/分区 | `apps/app/src/settings/` |
| 角色编辑器 | `apps/app/src/screens/CharacterEditScreen.tsx`、`screens/character-edit/` |
| 世界页 / 场景·物品·典籍编辑器 | `apps/app/src/screens/WorldScreen.tsx`、`screens/world-edit/` |
| 卡片模型 / 校验 / 激活 / brief | `packages/cards/src/` |
| 屏幕 | `apps/app/src/screens/` |
| 路由 | `apps/app/src/app/router.ts` |
| 文案 | `apps/app/src/i18n/catalog-*.ts` |
| e2e / 截图 | `e2e/mobile.spec.ts`、`docs/screenshots/` |
| 设计规范 / 分层 / 工程规则 | `docs/DESIGN.md`、`docs/SETTINGS-IA.md`、`docs/FRONTEND-RULES.md`、`docs/AGENT-UI-GUIDE.md` |

## 13. 参考（本文件的写法依据）

- [AGENTS.md 开放规范](https://agents.md/)：无必填字段；常用节 = 项目概览/构建与测试命令/代码风格/测试说明/安全事项/PR 说明；**命令优先、紧凑**；就近文件优先；用户当轮指令覆盖本文件。
- [OpenAI Codex 文档：Custom instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md.md)：发现顺序（全局 `~/.codex/AGENTS.md` → 项目根 → 逐级下钻，`AGENTS.override.md` 优先）；**默认 32 KiB 上限**；支持 `## Code Review Rules`；建议让 agent"复述已加载的指令"来验证。
- [Tembo：What Is AGENTS.md? How to Write One in 2026](https://www.tembo.io/blog/agents-md)：写命令不写散文；当作"给新同事的话"；**精简优于穷举**；不重复 linter 规则；提交入库、随架构变化更新、避免引用已删除脚本。
- [Claude Code 文档：How Claude remembers your project](https://code.claude.com/docs/en/memory)：Claude Code 读 `CLAUDE.md`（未列入 AGENTS.md 官方兼容清单）；团队通常保持两份内容一致、只追加工具特有内容。
