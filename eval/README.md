# 离线评估集（eval）

分两类，目的不同：

| 目录 | 评什么 | 是否需要网络 |
|---|---|---|
| `perf/` | **性能预算**：把预算指标变成可运行断言（FAIL 即退出码 1） | 否 |
| `context/` | **装配语义**：同一份输入下，块图与最终 messages 是否与期望一致（golden 快照） | 否 |
| `long-chat/` | **长对话与检索**：探针题（人名/关系/时间线）、引用核对、摘要注入 | 有密钥时打真实模型；没有就 **skip**（不假跑） |
| `sync/` | **同步**：两台设备在真实/模拟后端上的收敛 | 否（模拟后端） |

## 原则

1. **可离线复现**：模型响应一律录制为夹具（VCR 风格），测试不依赖网络与模型随机性。
2. **断言结构而非字面文本**：查"是否命中正确引用/是否包含关键事实"，不比对整段生成文本。
3. **固定种子**：夹具生成与抽样都用固定种子，任何人在任何机器上得到同一结果。
4. **绝不用更容易的近似冒充原指标**：没实现的指标一律标 SKIP，并写清它属于哪个里程碑。

## 运行

```bash
node eval/perf/budgets.mjs          # 性能预算
node --test "eval/**/*.test.ts"     # 语义评估（有测试的部分）
```

更新 golden 快照（改完务必 review diff 再提交）：

```bash
# POSIX / bash
UPDATE_GOLDEN=1 node --test "eval/**/*.test.ts"
```

```powershell
# PowerShell
$env:UPDATE_GOLDEN='1'; node --test "eval/**/*.test.ts"; Remove-Item Env:\UPDATE_GOLDEN
```
