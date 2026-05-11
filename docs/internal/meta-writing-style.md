# 文档写作规范

本规范适用于仓库内 **对外可见** 的 Markdown（`docs/` 下纳入 MkDocs 的页面）。`docs/internal/` 中的历史草稿可放宽格式，但仍须标注是否与当前实现一致。

## 原则

1. **可验证**：涉及端口、环境变量、URL、支持列表、API 路径的句子，必须能指向代码、`config.example.yaml` 或 `docs/reference/generated/openapi-gateway.json`。
2. **单一事实来源**：同一主题不要复制长文；使用 [ssot.md](ssot.md) 中的主文档链接。
3. **体裁清晰**：教程（教步骤）、指南（解决问题）、参考（查表）、解释（讲原理）— 参见 [Diátaxis](https://diataxis.fr/)。
4. **不冒充产品能力**：未在 `backend/app` / `evopanel` 实现的功能，不得写在「已支持」类表格中；可放在「路线图」并标明非当前行为。

## 页面元信息

建议在文末增加简短块（与代码审阅节奏一致即可）：

```markdown
---
**最后验证**：YYYY-MM-DD 或 commit hash；**适用范围**：默认分支 / 某发行版。
```

## MkDocs 常用语法

- 使用 `admonition` 扩展呈现提示（Material 主题原生支持），例如：

```markdown
!!! note "说明"
    补充上下文，而非重复正文。
```

- 代码块注明语言；涉及终端命令时写清工作目录（仓库根或 `backend/`）。

## 文件命名

- 对外教程、指南、参考：使用**小写英文**与连字符，例如 `operations-handbook.md`，便于 URL 稳定。
- 已存在的**中文文件名**可逐步保留，新增文件优先英文 slug。

---

更完整的历史模板见仓库内 `docs/internal/technical/00-写作规范.md`（不参与站点构建；[GitHub 上查看](https://github.com/aiyintai/evoflow/blob/main/docs/internal/technical/00-写作规范.md)）。

**最后验证**：2026-05-09。
