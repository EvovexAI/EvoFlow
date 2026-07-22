# docs/ — 三知识库约定

EvoFlow 仓库文档按 **三个独立知识库根** 划分，便于分别挂载为 Obsidian Knowledge Vault（或内置预置库），互不混检。

| 知识库根 | 读者 | 内容 |
|----------|------|------|
| [`user/`](user/) | 终端用户 | 操作指南、教程、上手、FAQ、概念说明、用法案例 |
| [`system/`](system/) | 开发 / 运维 / 系统 Agent | 技术设计、需求、API/配置参考、接口与内部约定 |
| [`roles/`](roles/) | 智能体员工产出 | 值班岗位按小时写入的方案/报告/纪要（运行时产物，非 SSOT） |

共享资源（不单独成库）：

- [`assets/`](assets/) — 截图与媒体，供 `user/` / `system/` 引用
- 本文件与 [`index.md`](index.md) — 总览入口（MkDocs 首页）

## 判定规则

1. **用户会跟着面板点一遍** → `user/`
2. **接口字段、表结构、中间件、需求验收、架构实现** → `system/`
3. **智能体值班写出的方案/报告** → `roles/<agent_code>/<YYYYMMDD-HH>/`（路径由运行时约定，勿手改目录名）
4. 同一主题可有用户操作版 + 系统实现版，用链接互指；SSOT 见 [`system/internal/meta-ssot.md`](system/internal/meta-ssot.md)

## 与产品能力对应

| 能力 | 建议挂载 |
|------|----------|
| **系统内置用户指南**（启动自动注册，只读） | `docs/user/` → Vault id `evoflow-user-guide` |
| 用户自建指南知识库 | 自选本地 Obsidian 目录 |
| 系统内部知识库（预置 / 自建 Vault） | `docs/system/`（尚未内置，可手动挂载） |
| 智能体产出库（按工作空间） | `docs/roles/` |
| 上传文档 RAG | 另一套能力，勿与上述 Vault 混用 |
| `memory.json` | 会话记忆，不是文档库 |

内置库运行时落在 `{EVOFLOW_HOME}/knowledge/vaults/evoflow-user-guide/`，由 Gateway 启动时从包内 `docs/user` 同步；小V的 `xiaomi_knowledge_search` 会检索所有已启用 Vault（含该内置库）。

Vault 建议 ignore：`.obsidian/**`、`*.db`、`*.db-*`、大体量媒体（按需）。

## MkDocs

站点仍从仓库根 `mkdocs.yml` 构建，`docs_dir: docs`；导航同时收录 `user/` 与 `system/` 中对外可读页，**排除** `system/internal/**`、`system/presentations/**`、`roles/**`。
