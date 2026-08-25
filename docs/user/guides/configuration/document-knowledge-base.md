# 上传文档（RAG）— 已下线

> **本能力已下线。** 请改用侧栏 **[知识库（Obsidian Vault）](knowledge-vault.md)** [[guides/configuration/knowledge-vault|知识库]]（`#/knowledge/vaults`）。
>
> 旧路由 `#/knowledge` / `#/knowledge/:id` 会自动跳转到知识库页。Agent 请使用 `knowledge(action=…)`，不再提供 `search_knowledge_base`。

零散 PDF/Word 可先放入 Obsidian / Markdown 目录，再连接为知识库；会话级附件仍走聊天 Composer（见 [文件上传](../chat/file-upload.md) [[guides/chat/file-upload|文件上传]]）。

| 能力 | 入口 | Agent 工具 |
|------|------|------------|
| **知识库**（Vault） | `#/knowledge/vaults` | `knowledge(action=…)` |
| **资产中心**（偏好/经验/反思） | `#/assets` | 对话自动整理 / `assets` 工具 |
| **会话文件上传** | 聊天 Composer | 单次会话解析 |

详见 [知识库](knowledge-vault.md) [[guides/configuration/knowledge-vault|知识库]]、[资产中心](asset-center.md) [[guides/configuration/asset-center|资产中心]]。

---

## 相关阅读

- [[guides/configuration/knowledge-vault|知识库（Obsidian Vault）]] — 连接本机笔记库的全新方案
- [[guides/configuration/asset-center|资产中心]] — 偏好、经验与反思
- [[guides/integrations/obsidian-knowledge-vault|Obsidian Vault 集成]] — 底层架构与 MCP 细节
- [[guides/chat/file-upload|文件上传]] — 会话级附件解析
