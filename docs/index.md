# EvoFlow 文档

面向用户的操作文档在此维护；贡献与源码流程见仓库根目录治理文件。

## Quick Links

| | |
| --- | --- |
| 🚀 [下载与安装包](user/getting-started/downloads.md) | Windows / macOS / Linux 安装包 |
| 📖 [5 分钟快速上手](user/getting-started/quick-start.md) | 从打开面板到跑通第一个任务 |
| 🗺️ [产品总览](user/getting-started/product-overview.md) | 人群 · 问题 · 功能地图 |
| ⚙️ [配置模型](user/tutorials/configure-models.md) | Provider 与 API Key |
| 💬 [Plan 模式](user/guides/chat/plan-mode.md) | 长任务规划与协作 |
| 🤖 [Agent / 团队](user/guides/configuration/agent-management.md) | 智能体与预设团队 |
| 📚 [技能管理](user/guides/configuration/skill-management.md) | `SKILL.md` 技能包 |
| 🔌 [工具与 MCP](user/guides/configuration/tools-mcp.md) | 扩展工具 |
| 📨 [IM 渠道](user/guides/integration/im-channels.md) | 飞书 / 微信等 |
| 🔒 [安全护栏](user/guides/security/guardrails.md) | 本地安装注意点 |
| ❓ [FAQ](user/guides/faq.md) | 常见问题 |
| 🏗️ [为什么用 EvoFlow](user/explanation/why-evoflow.md) | 概念与边界 |
| 🤝 [贡献者指南](contribute/index.md) | 仓库地图 · 分支 · Skill · 渠道 · RFC |
| 🌱 [Good First Issue / Discussions](contribute/discussions-and-good-first-issues.md) | 新人任务与社区分类 |
| 🔁 [社区闭环](contribute/community-ops.md) | 与主流开源对齐的运营清单 |
| 📋 [CONTRIBUTING.md](../CONTRIBUTING.md) | 环境搭建与 PR 总流程 |
| 🆘 [获取帮助](../SUPPORT.md) | Issue / Discussions / 邮件 |
| 🛡️ [安全披露](../SECURITY.md) | 漏洞报告（勿公开 Issue） |
| 👥 [维护者](../MAINTAINERS.md) | Review / 发版职责 |
| 🤖 [llms.txt](llms.txt) | 给 LLM / Agent 用的文档索引 |

## 文档中心

更完整的用户目录：[文档中心](user/index.md)

| 分区 | 说明 |
|------|------|
| [快速开始](user/getting-started/introduction.md) | 介绍 · 下载 · 安装 · 上手 |
| [教程](user/tutorials/configure-models.md) | 分步教程 |
| [操作指南](user/guides/README.md) | 对话 / 任务 / 配置 / 集成 |
| [案例](user/cases/index.md) | 用法案例 |
| [概念说明](user/explanation/why-evoflow.md) | 体系与设计意图 |

本树仅含**用户文档与配图**。研发/设计/需求等非公开材料不在本仓公开树中（见 [docs/README.md](README.md)）。

## 本地构建 MkDocs

```bash
pip install -r requirements-docs.txt
mkdocs serve
```

生产构建（断链即失败）：`make docs-build`
