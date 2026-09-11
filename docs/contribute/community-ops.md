# 社区闭环（对齐主流开源 / Hermes）

本文是**运营动作清单**，不是产品功能说明。文档骨架见 [贡献者指南](index.md)；提问分诊见 [SUPPORT.md](../../SUPPORT.md)。

## 闭环

```text
发现 → 讨论 → 实现 → 检查 → 合并 → 发布 → 反馈
```

| 环节 | 做法（沿用行业惯例） | 本仓库落点 |
|------|----------------------|------------|
| 发现 | Issues + Discussions + 社群 | 公仓 Issues；[Discussions](https://github.com/EvovexAI/EvoFlow/discussions)；微信见 README |
| 讨论 | 小改 Issue；大改 RFC / Ideas | [RFC](rfc.md)；Discussion 分类 Q&A / Ideas / Show and tell |
| 实现 | 短生命周期分支 + 小 PR | [分支与检查](branching-and-checks.md) |
| 检查 | CI 必绿 | lint / unit / docs workflows；`make ci-local` |
| 合并 | PR → squash → `main` | 公仓 `main` 已开 PR review 保护 |
| 发布 | tag + 安装包 + 短 Release notes | 维护者：`scripts/maintainer/`；同步 docs 面 |
| 反馈 | 看 Issue / Discussions；孵化 good first issue | 标签 `good first issue` / `help wanted` / `rfc` |

## 公仓已对齐的动作

- Discussions **已开启**（[EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow)）
- 标准标签含 `good first issue`、`help wanted`、`rfc` 等
- `main`：**要求 PR + 至少 1 次 review**；禁止 force-push；要求对话已解决
- 已投放若干 `good first issue`（文档向）供新人认领

## 维护者每次发版最少做

1. 打 tag / 跑桌面打包（maintainer 脚本或 Actions）  
2. GitHub Release 写 **用户能看懂的 5～10 行** notes（可链 PRODUCT-NOTES）  
3. 同步公仓文档面（sync-public），**不要**提前改坏 `update/latest.json`  
4. 若有破坏性配置，在 Discussions Announcements 留一句  

## 不要自己发明

- 另起一套分支模型（无必要不上 GitFlow）  
- 另写行为准则 / 安全披露（已用 Covenant + SECURITY）  
- 把运营做成第二产品站——用户 docs + 贡献 docs + 根治理 md 三层即可  

产品创新；**运营抄作业并执行上表。**
