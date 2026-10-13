# StoryForge

本地优先的 AI 角色扮演与创作工作台。核心特征：**一切皆插件**（内核之外没有非插件代码）、**结构化上下文管线**（可解释、可复现）、**Agent 只做调优**（写入皆提案 + 审批 + 可撤销）、**同步跑在哑存储上**（网盘目录 / NAS WebDAV 即可，无需服务器）。

计划与决策见 [docs/PLAN.md](docs/PLAN.md) 与 [docs/adr/](docs/adr/README.md)。

## 目录

| 路径 | 作用 |
| --- | --- |
| `packages/kernel` | 插件内核：Context / Service / `inject` / `effect` / 事件 / Config / 组合加载器 |
| `packages/oplog` | Op 编解码、HLC、段打包（压缩 + 校验 + 签名 + 加密）、幂等重放与物化 |
| `packages/sync-core` | 同步引擎、manifest 索引、设备名单、GC 判定 |
| `packages/plugin-api` | 插件作者唯一依赖（随后落地） |
| `plugins/*` | 产品特性，每个目录 = 一个可独立发布的 npm 包 |
| `bundles/*` | 组合层：只含 patch 与依赖声明 |
| `apps/*` | 应用产物（`app` SPA / `shell` Tauri / `relay` 可选中继） |
| `docs/` | 计划、ADR、进度台账 |

## 开发（零依赖即可跑测试）

仓库内的 `packages/kernel`、`packages/oplog`、`packages/sync-core` 与 `plugins/*` **不依赖任何第三方运行时库**，测试只用 Node 内置模块。Node ≥ 22.18 可直接运行 TypeScript（类型擦除），因此：

```bash
node --version          # 需要 >= 22.18，推荐 24.x
npm test                # = node --test packages plugins
npm run check           # 边界门禁 + 全部测试
```

类型检查需要安装依赖（可选）：

```bash
pnpm install
pnpm run typecheck
```

## 约定（硬性）

- 导入路径必须带 `.ts` 扩展名（Node 类型擦除不做扩展名重写）。
- 不使用 `enum` / `namespace` / 构造函数参数属性（保证可擦除）；类型导入一律 `import type`。
- 单文件 ≤ 400 行；`packages/oplog`、`packages/sync-core` 禁止 `any`。
- 插件不得 import 宿主客户端基础包；不得越过自己的槽位写 DOM；不得直连数据库（走 Service）。
- 协作与提交：一个提交只做一件事；根配置与 `docs/` 由不同负责人分头写，避免重叠。

## 许可

AGPL-3.0-or-later。参考了 SillyTavern 生态的**数据格式与行为语义**（角色卡 CCv2/CCv3、世界书、聊天 JSONL、预设），代码为 clean-room 实现。
