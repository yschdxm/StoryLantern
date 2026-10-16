# 变更记录

这个项目**不用 changesets 之类的工具**：根 `package.json` 的依赖是零运行时依赖、开发依赖只有 TypeScript，
为了发行再引一套工具链不划算。变更记录就按"**人写 + 机器验**"来维护：

- 每个阶段的**事实与数字**写在 `docs/M*-STATUS.md` 里（按小节编号，带实测输出，不是宣传稿）；
- 这张表只记**里程碑级别的、面向使用者的**变化；
- "怎么发"见 `docs/RELEASE.md`；每条版本都必须是 `npm run release:check` 全绿之后才写进来。

## Unreleased

**M0–M5（内核 / 领域模型 / 上下文管线 / 提供商 / 记忆 / 调优助手）已完成**，详见：

- `docs/M0-PROGRESS.md`、`docs/M1-*.md`、`docs/M2-*.md`、`docs/M3-STATUS.md`、`docs/M4-STATUS.md`；
- 关键事实（都能在对应文档里核到）：一切皆插件（内核之外没有非插件代码）；
  装配可解释、发送字节 == 展示字节；Agent 只在侧信道给建议、写入必须经批准且可撤销；
  同步跑在哑存储上（网盘目录 / NAS WebDAV / S3 / SMB），端到端加密 + 每段签名 + 幂等重放。

**M6 同步**：`sync-core` + 五个后端（内存 / 文件夹 / WebDAV / S3 / SMB 路线）+ 能力探测与降级 +
扫码配对 + 撤销设备 + 快照链（整份 + 增量）+ 整体备份的导出与恢复。实测记录见 `M4-STATUS.md`
第五十九～八十四节；具体网盘客户端的差异（**文档依据，非实测**）见 `docs/WEBDAV-PROVIDERS.md`。

**M7 插件生态与发行**：仓外插件验证（`fixtures/external-plugin` + 源码级断言它只用公开 `plugin-api`）；
可复现构建检查（`scripts/check-reproducible-build.mjs`：同源构建两次、逐文件比 sha256）。

## 尚未发布任何版本

仓库根 `version` 仍是 `0.0.0`、`private: true`，**还没有打过 tag、没有签名产物、没有上架任何商店**。
什么时候算可以发第一版：见 `docs/RELEASE.md` 的"发布门槛"。
