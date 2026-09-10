# EvoFlow 文档

面向用户的操作文档在本站公开维护。

| 入口 | 说明 |
|------|------|
| [文档中心](user/index.md) | 用户指南总览 |
| [产品总览](user/getting-started/product-overview.md) | 人群 · 问题 · 功能地图 |
| [快速上手](user/getting-started/quick-start.md) | 5 分钟入门 |
| [操作指南](user/guides/README.md) | 对话 / 任务 / 配置 / 集成 |
| [教程](user/tutorials/configure-models.md) | 分步教程 |
| [案例](user/cases/index.md) | 用法案例 |
| [概念说明](user/explanation/why-evoflow.md) | 为什么用 EvoFlow |
| [FAQ](user/guides/faq.md) | 常见问题 |

### 文档约定（摘要）

| 目录 | 读者 | 是否进入公共镜像 |
|------|------|------------------|
| `user/` | 终端用户 | ✅ 公开 |
| `assets/` | 用户文档配图/演示媒体 | ✅ 公开 |
| `system/` | 开发 / 运维 / 内部设计 | ❌ 仅私有仓 |
| `roles/` | 智能体值班产出（运行时） | ❌ 不同步 |

判定：用户跟着面板点一遍 → `user/`；接口/架构/需求/验收 → `system/`（私有）；值班方案报告 → `roles/`。

分层细则见 [README.md](README.md)。

## 本地构建 MkDocs

```bash
pip install -r requirements-docs.txt
mkdocs serve
```

生产构建（断链即失败）：`make docs-build`
