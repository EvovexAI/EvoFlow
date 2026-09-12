# 代码知识库（Codebase Wiki）

面向贡献者与 AI Agent 的**模块级源码地图**，回答「代码在哪、模块怎么协作」。用户怎么用产品请看 [docs/user/](../user/)。

## 入口

| 文档 | 说明 |
|------|------|
| [`.codebasewiki/README.md`](../../.codebasewiki/README.md) | 知识库约定与维护方式 |
| [模块地图](../../.codebasewiki/index/index.md) | 按架构层分组的 58 个模块 |
| [系统架构](../../.codebasewiki/index/architecture.md) | C4 总览与主路径 |
| [仓库地图](repo-map.md) | 改哪里、测哪里（贡献速查） |

## 目录结构

```text
.codebasewiki/
├── README.md
├── index/           # 人读导航 + module-map.json
└── codebase/{module}/
    ├── overview.md … concerns.md   # 每模块 7 份事实文档
    └── path-map.json               # 文件清单
```

## 何时更新

- 新增/拆分重要包目录后：补充或重建对应 `codebase/{module}/`
- 大改公共 API 后：更新该模块 `overview` / `architecture` / `integrations`，并改 `last_updated`
- 提交前可选：仓库根有 `wiki-config.yaml` 时运行

```bash
python .claude/skills/codebase-wiki/scripts/wiki_audit.py --config ./wiki-config.yaml
```

（`.claude/skills/` 默认不入库；本地可用 codebaseproject 的 `deploy.py` 部署技能。）

## 与 MkDocs 的关系

本页挂在贡献者导航下，便于发现。**完整模块正文在 `.codebasewiki/`**（公开源码树可读，不进入 MkDocs 全站渲染，以免与用户文档混排）。
