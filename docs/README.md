# docs/ — 文档分层（开源门面）

EvoFlow 文档按读者与是否可公开划分。**公共镜像只同步用户可见文档**；内部设计与值班产物留在私仓。

| 目录 | 读者 | 公仓 |
|------|------|------|
| [`user/`](user/) | 终端用户 | ✅ 同步 |
| [`assets/`](assets/) | 用户文档配图/演示媒体 | ✅ 同步（随 user 引用） |
| [`system/`](system/) | 开发 / 运维 / 内部设计 | ❌ 仅私仓（含 `internal/`、`developer/`、`reference` 等） |
| [`roles/`](roles/) | 智能体值班产出（运行时） | ❌ 不同步；目录可空，由运行时写入 |

本文件与 [`index.md`](index.md) 为文档总览入口。

## 判定规则

1. **用户会跟着产品点一遍** → `user/`
2. **接口、架构、需求、验收、内部 SOP** → `system/`（默认不公开）
3. **智能体值班写出的方案/报告** → `roles/<agent_code>/<YYYYMMDD-HH>/`（非 SSOT，勿手改目录名）

运营知识库 Markdown SSOT 在 ContentOS，不在本仓；指针见 [`system/internal/contentos-ops-knowledge-pointer.md`](system/internal/contentos-ops-knowledge-pointer.md)。

## MkDocs

根目录 `mkdocs.yml`：`docs_dir: docs`。导航只收录 `user/`（及站点首页）。整树排除 `system/**`、`roles/**`。

## 公共同步

`sync-public` / `local-publish -SyncPublic` 拷贝 `docs/` 后会剥离所有非公开子树（见 workflow 注释），保证公仓文档面干净。
