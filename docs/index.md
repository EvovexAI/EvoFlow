# 文档中心

欢迎来到 EvoFlow 文档中心。

## 在线阅读（MkDocs）

本地构建静态站点（需 Python 与依赖）：

```bash
pip install -r requirements-docs.txt
mkdocs serve
```

生产构建（断链即失败）：

```bash
make docs-build
```

站点导航由仓库根目录 [`mkdocs.yml`](https://github.com/EvovexAI/EvoFlow/blob/main/mkdocs.yml) 维护。

## 快速导航

| 你是？ | 从这里开始 |
|--------|-----------|
| 想下载安装包 | [下载与构建](getting-started/downloads.md) |
| 第一次听说 EvoFlow | [项目介绍](getting-started/introduction.md) |
| 想快速上手 | [5 分钟快速上手](getting-started/quick-start.md) |
| 刚装好，想试试 | [完成第一个任务](getting-started/first-task.md) |
| 知道基础用法，想深入 | [教程系列](tutorials/configure-models.md) |
| 遇到具体问题要解决 | [操作指南](guides/evopanel-guide.md) |
| 查配置项或 API | [参考文档](reference/api-reference.md) |
| 想了解设计理念 | [概念解释](explanation/why-evoflow.md) |
| 运维与自托管 | [运维手册](guides/operations-handbook.md) |

## 文档分类

本项目的对外文档遵循 [Diátaxis](https://diataxis.fr/) 框架：

| 分类 | 说明 |
|------|------|
| **教程 Tutorials** | 手把手教学，适合学习新功能 |
| **指南 Guides** | 解决具体问题，直奔主题 |
| **参考 References** | 完整的技术参考，查配置项和 API |
| **解释 Explanations** | 理解设计理念和架构原理 |

## 常见问题

- [常见问题 FAQ](faq.md)
