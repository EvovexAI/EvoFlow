# Discussions 与 Good First Issue

## Discussions 建议分类

在 [GitHub Discussions](https://github.com/EvovexAI/EvoFlow/discussions) 启用后，推荐使用这些分类（名称可按仓库设置微调）：

| 分类 | 用途 |
|------|------|
| **Q&A** | 安装、配置、Plan/Goal「怎么用」——不是缺陷跟踪 |
| **Ideas** | 功能脑暴；较大想法可升格为 [RFC](rfc.md) |
| **Show and tell** | 你用 EvoFlow + Skill 做出的工作流 / 截图 |
| **RFC** | 按 [RFC 模板](rfc.md) 贴提案（若未单独分类，可放 Ideas 并标题加 `[RFC]`） |
| **Announcements** | 维护者发版与政策（只读为主） |

**不要**用 Discussion 报安全漏洞 → [SECURITY.md](../../SECURITY.md)。  
**可复现的缺陷** → Issue（Bug 模板），不要只开 Discussion。

分诊约定见 [SUPPORT.md](../../SUPPORT.md)。

## Good First Issue

适合新人的任务特征：

- 范围小、不碰发版/签名/公仓同步  
- 验收标准写在 Issue 正文  
- 标签：`good first issue`（可选再加 `docs` / `skills` / `help wanted`）

### 维护者如何孵化

1. 从文档断链、错别字、Skill 元数据、小 UI 文案里拆任务  
2. Issue 写清：改哪些路径、怎么本地验证、不要动哪些目录  
3. 打上 `good first issue`；认领后可再标 `in progress`（若使用）  
4. PR 用常规 [分支与检查](branching-and-checks.md)；Review 时多给上下文链接  

### 贡献者如何挑

1. 筛标签 [`good first issue`](https://github.com/EvovexAI/EvoFlow/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)  
2. 评论「我来做」避免重复  
3. 按 [CONTRIBUTING.md](../../CONTRIBUTING.md) 开 `docs/*` 或 `fix/*` 分支  

当前公开仓若 Issue 较少，可先从 **文档 Quick Links 断链检查** 或 **补一条 Skill 用户说明** 自行开 Documentation Issue 再 PR。

## 相关

- [贡献者指南](index.md)
- [添加 Skill](add-skill.md)
- [RFC](rfc.md)
