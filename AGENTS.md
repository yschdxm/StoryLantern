# AGENTS.md

> 本文件是给 **coding agent** 的仓库级指令。当前**只写了 UI（界面层）部分**；数据层、宿主（Rust）、同步协议、插件、构建发布等部分后续补充。
> 详细长文见：`docs/AGENT-UI-GUIDE.md`（界面开发指南）、`docs/DESIGN.md`（设计系统）、`docs/SETTINGS-IA.md`（页面层级与设置分层）、`docs/FRONTEND-RULES.md`（工程规则）、`docs/FEATURES.md`（功能×代码位置×截图总表）。

## 0. 项目与硬约束（动手前必须知道）

- 叙灯 / Story Lantern：**手机优先**的 AI 角色扮演 / 小说客户端。界面在 `apps/app`（React + Vite），宿主是 Tauri（Rust）。
- **运行时零第三方依赖**：界面只允许 React；不要 `pnpm add` 任何运行时包。`@playwright/test`、`typescript` 是仅有的 devDependency。
- **单文件 ≤400 行**（`scripts/check-boundaries.mjs` 会拦）；依赖方向有白名单；文本文件必须 UTF-8。
- 中文优先：界面文案中英双语，中文是主语言。
- **术语**：英文 **design token 统一称「设计变量（样式变量）」**，不要写"令牌"（会和鉴权 token 混淆）。
- 不伪造：不要用假数据/示例功能冒充实现；没验证过的结论不要写进报告或提交信息。

## 1. 当前界面实现状态（别重复造轮子）

- **设置页已三级分层**：`screens/SettingsScreen.tsx`（约 65 行薄壳）+ `settings/SettingsHome.tsx`（L1 首页）+ 6 个分区页 `settings/{Model,Appearance,Sync,Data,Advanced,About}Settings.tsx`。新增设置项 → 放进对应分区页，**不要往外壳里加内容**。
- **行组件已存在**：`ui/SettingsRow.tsx`（label + 当前值 + 箭头/行内控件，触控 ≥44px）。设置类界面复用它，不要自己拼一行 flex。
- **设计变量已建立**（`apps/app/src/styles.css` 顶部 `:root`）：间距/字阶/圆角(pill)/阴影/层级/动效/聚焦环/触控/语义色（暗、亮、system 三态）。
- **无障碍基线已有**：全局 `:focus-visible`、`prefers-reduced-motion` 归零、`.sr-only`。
- 已知限制：L3 无独立 URL（返回会从 L3 跳回 L1）、无 `Select` 原语（原生 select 长标签可能截断）——见 `docs/SETTINGS-IA.md §8`。

## 2. 代码边界（先判断你的改动属于哪一层）

| 层 | 目录 | 可以写 | 禁止 |
|---|---|---|---|
| 原语组件 | `apps/app/src/ui/` | Button/Field/Sheet/SettingsRow 等可复用件 | 业务逻辑、`data/` 依赖 |
| 屏幕 | `apps/app/src/screens/`、`apps/app/src/settings/` | 读 store、调 action、组合原语 | 直接 `localStorage` / `fetch` / op 日志 |
| 数据/领域 | `apps/app/src/data/` | 纯逻辑（必须能在 Node 里测试） | React / DOM |
| 组合与路由 | `apps/app/src/app/`、`apps/app/src/main.tsx` | 路由、全局 store、运行时 | 业务 UI；**`main.tsx` 已 378 行，不许变长** |

判据：能写成纯函数的部分必须放 `data/` 并配 Node 测试；屏幕只做"展示 + 事件转发"。

## 3. 样式：只用设计变量，禁止字面量

| 类别 | 可用变量 | 规则 |
|---|---|---|
| 间距 | `--space-1..10`（4/8/12/16/20/24/32/40/48/64）、`--gap-inline`、`--gap-stack`、`--pad-screen`、`--pad-card` | 禁止 `padding: 13px` 这类刻度外值 |
| 字号/行高 | `--text-xs(12)/-sm(14)/-md(16)/-lg(18)/-xl(20)`、`--leading-tight/normal/loose` | **禁止 <12px** |
| 圆角 | `--radius-sm(8)/--radius(12)/--radius-lg(16)/--radius-pill` | 不再新增第四种圆角 |
| 颜色 | `--bg/--surface/--surface-2/--border/--text/--dim/--muted/--accent/--accent-text/--accent-soft/--danger/--danger-text/--ok/--warn` | 组件里**禁止 `#hex`**；暗/亮/system 三态必须都有值 |
| 阴影 | `--shadow-1`、`--shadow-2` | 弹层用 2 |
| 层级 | `--z-sticky/--z-fab/--z-appbar/--z-sheet-backdrop/--z-sheet/--z-modal-backdrop/--z-modal/--z-toast` | 禁止裸数字 |
| 动效 | `--dur-fast/normal/slow`、`--ease-standard` | 必须响应减少动效（已全局归零） |
| 无障碍 | `--focus-ring`、`--tap-min(44px)`、`--selection-bg` | 可点元素 ≥`--tap-min` |

新增变量必须：属于上表某类别、有档位、暗/亮/system 三态都定义、并在 `docs/DESIGN.md §1` 登记。**不要为单个屏幕造一次性变量**。类名用 BEM（`.settings-home__row`），加在 `styles.css` 对应段落。

## 4. 组件与状态要求

现有原语（`apps/app/src/ui/components.tsx`）：`Button / IconButton / EmptyState / Banner / LoadingState / ListRow / Sheet / SheetItem / ConfirmDialog / Field / TextInput / TextArea`；设置行用 `ui/SettingsRow.tsx`。

- 每个交互原语必须覆盖：hover / active / **focus-visible** / disabled / loading / invalid（适用者）。
- 图标按钮必须 `aria-label`；输入必须经 `Field`（label + hint + error 三态）。
- 弹层必须：`role="dialog"` + `aria-modal`、焦点陷阱、Esc 关闭、背景滚动锁、z-index 用变量分档。
- 一屏**一个主按钮**；空状态用 `EmptyState` 五要素（title / hint / action / 可选 secondary / 可选 example）。
- 新建可复用件放 `ui/`（单件 ≤80 行），屏幕只组合。

## 5. 页面层级（最多 3 层）

L1 根级（底栏 4 标签 + 聊天）→ L2 页面/分区（列表页，**每页 ≤7 行**）→ L3 详情/编辑。

- L2 每行 = 标题 + **当前值/状态**（不是解释） + 箭头；
- 返回逐级；从聊天页「去设置」返回要回到原会话；
- 设置入口只有一处、叫「设置」；版本/许可放「关于」；高级项不前置（折叠在「高级与开发者」）。

## 6. 新增一个界面（标准流程）

1. **路由**：`app/router.ts` 加/改 route（含 `parseRoute`、`parentOf`、底栏高亮）；
2. **屏幕**：`screens/XxxScreen.tsx` 或 `settings/XxxSettings.tsx`，套 `AppShell`（标题/返回/动作区）；
3. **状态**：只读 `store`；写操作调 `store.actions.*`；异步结果必须落成可见状态（Banner/Toast/设置行），**禁止静默 catch**；
4. **文案**：进 `i18n/catalog-zh-*.ts` / `catalog-en-*.ts` 分片（`catalog-zh.ts` 已到 400 行上限），合并进 `messages.ts`；
5. **样式**：只用设计变量，BEM 类名；
6. **测试**：纯逻辑抽到 `data/` 写 Node 测试；交互加 e2e 断言（能打开、关键点击有效、无 pageerror）；
7. **截图**：Playwright（Pixel 7）截新图到 `docs/screenshots/`，并在文档引用；
8. **门禁**：见 §8，全绿才算完成。

新增设置项额外检查：属于哪个 L1 分组？L2 显示什么当前值？行内控件还是进 L3？中英文案？触控 44？危险操作有确认？

## 7. i18n 与文案

- 组件里**禁止**中英文字面量（含 `aria-label`、`placeholder`、`title`）；
- key 命名 `<area>.<对象>.<状态>`（`settings.sync.lastAt`）；新增文案优先放到对应分片文件；
- **Markdown 不解析**：文案里不要写 `**加粗**` / `[链接]()`（会原样显示）；
- 英文按中文长度 **+40%** 预留；
- 失败文案四段式：**现象 → 原因 → 下一步 → 兜底**；不要把宿主/WebCrypto 原文直接抛给用户。

## 8. 验证（提交前必须全绿，逐条贴输出）

```bash
node scripts/check-boundaries.mjs      # 架构/行数/编码
npm run typecheck                      # 类型零错误
node --test "apps/app/**/*.test.ts"    # 屏幕/数据层单测
node apps/shell/build-frontend.mjs     # 前端构建
node scripts/check-bundle.mjs          # 产物无 Node 内置模块 / 无 .map
pnpm exec playwright test              # e2e（Pixel 7 视口 + 触摸）
```

截图（Pixel 7、构建产物 + `vite preview --port 15199`）：

```bash
node apps/shell/build-frontend.mjs
pnpm --filter @storylantern/app exec vite preview --port 15199 --strictPort
# Playwright: page.screenshot({ path: 'docs/screenshots/NN-xxx.png' })
```

## 9. 禁止清单（违反即打回）

1. 引入第三方运行时依赖；改 Rust / wire / op 日志 / 同步逻辑（不在 UI 范围内）；
2. 组件里写字面量颜色/字号/间距/圆角/z-index；
3. `innerHTML` / `dangerouslySetInnerHTML`；直接 `localStorage` / `fetch`（走 `data/` 端口）；
4. 静默 `catch`，或"失败了但界面没变化"；
5. 单文件 >400 行；让 `main.tsx` 变长；
6. 用示例/假数据填充界面冒充功能；
7. 提交信息写没验证过的结论（例如"测试通过"而没跑）。

## 10. 本仓库真实踩过的坑（别再踩）

| 坑 | 正确做法 |
|---|---|
| 用了未定义的设计变量（`--accent-soft`）→ 界面冒出兜底蓝色 | 新变量在 `:root` 与亮/system 都定义 |
| 11px 小字（`0.69rem`） | 最低 `--text-xs`（12px） |
| 键盘弹起时 `position: fixed` 元素被盖住 | 弹层/输入栏用 `height: var(--app-height)` 或相对 `.app` 定位 |
| 空状态 CTA 与 FAB 两个主按钮打架 | 一屏一主按钮；空态有 CTA 时隐藏 FAB |
| 文案硬编码中文 | 全部走 i18n，中文进分片 |
| 设置页越改越长（曾 398 行） | 迁到 `settings/` 分区页，每文件 ≤400 行 |
| 中文文案里的 `**` 原样显示 | Markdown 不解析，去星号 |
| e2e 用中文文案选择器 → CI（en 环境）失败 | 用 id / 结构选择器（如 `input.fill('set')` 而不是 `'设置'`） |

## 11. 汇报格式（给 Lead / 用户）

```
1) 改动文件（按层归类，标行数）
2) 用户可见变化（哪些屏/哪些行，当前值怎么显示）
3) 自验（逐条命令 + 退出码/关键输出 + 截图路径）
4) 未做 / 风险（如实写，不要抹平）
```

## 12. 后续待补（本文件当前只有 UI 部分）

- 数据层规则（op 日志、物化、仓储接口、迁移）；
- 宿主（Rust / wire / SQLite）与安全纪律；
- 同步协议（段/密钥环/名单/GC/恢复）与测试要求；
- 插件开发（插件契约、bundle patch、依赖白名单）；
- 构建/发布/CI（三渠道、版本纪律、签名、校验和）。

---

**路径速查**

| 要改什么 | 去哪 |
|---|---|
| 设计变量/全局样式 | `apps/app/src/styles.css` 顶部 |
| 通用组件 | `apps/app/src/ui/components.tsx` |
| 设置行 | `apps/app/src/ui/SettingsRow.tsx` |
| 设置首页/分区 | `apps/app/src/settings/` |
| 屏幕 | `apps/app/src/screens/` |
| 路由 | `apps/app/src/app/router.ts` |
| 文案 | `apps/app/src/i18n/catalog-*.ts` |
| e2e | `e2e/mobile.spec.ts` |
| 截图 | `docs/screenshots/` |
