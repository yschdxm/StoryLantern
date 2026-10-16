# 夹具（fixtures）

真实格式的样本文件，用来让导入行为**可验证**，而不是靠人肉试。
（**现状要说准**：目前只有**导入器**，还没有导出器 —— 所以"导入/导出往返无损"这条要求**尚未做到**，
这些样本当前支撑的是导入侧的语义与性能测试。）

## 目录约定

| 目录 | 内容 | 用途 |
|---|---|---|
| `cards/` | 角色卡：PNG（内嵌 CCv2 `chara` / CCv3 `ccv3`）、CCv2 JSON、CCv3 JSON | 导入器：逐字段解析正确 |
| `lorebooks/` | 世界书：ST 原生（`entries` 为 uid→条目 map）、CCv3 独立 lorebook（数组形式 + decorators） | 世界书扫描与合并语义 |
| `chats/` | 聊天 JSONL（首行 header + `mes`/`swipes`/`swipe_info`/`is_system`/`extra`），含群聊与 10 万条长聊天各一 | 导入性能与语义 |
| `presets/` | Chat Completion 预设（`prompts[]`/`prompt_order[]`/采样参数）、Text Completion 预设 | 提示词装配对齐 |
| `regex/` | 正则脚本（placement：USER_INPUT/AI_OUTPUT/WORLD_INFO/REASONING） | 正则语义 |
| `malformed/` | 畸形输入（截断 PNG、坏 JSON、坏 JSONL、超深嵌套） | **必须明确失败且不丢数据** |

## 关于版权与脱敏

样本只保留**格式结构**，内容一律由脚本生成或替换为占位文本：
角色卡里的立绘、真实用户聊天记录、私人设定都不入库。
`tools/make-fixtures.mjs` 负责生成这些样本，可重复执行且结果确定（固定随机种子）。

## 怎么用

```bash
node fixtures/tools/make-fixtures.mjs              # 重新生成全部样本
node --test "packages/importer/**/*.test.ts"       # 导入器：语义 + 性能 + 畸形输入
```
