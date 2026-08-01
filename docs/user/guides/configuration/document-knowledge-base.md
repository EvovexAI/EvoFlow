# 上传文档（RAG）— 已下线

> **本能力已下线。** 请改用侧栏 **[知识库（Obsidian Vault）](knowledge-vault.md)** [[guides/configuration/knowledge-vault|知识库]]（`#/knowledge/vaults`）。
>
> 旧路由 `#/knowledge` / `#/knowledge/:id` 会自动跳转到知识库页。Agent 请使用 `knowledge(action=…)`，不再提供 `search_knowledge_base`。

零散 PDF/Word 可先放入 Obsidian / Markdown 目录，再连接为知识库；会话级附件仍走聊天 Composer（见 [文件上传](../chat/file-upload.md) [[guides/chat/file-upload|文件上传]]）。

| 能力 | 入口 | Agent 工具 |
|------|------|------------|
| **知识库**（Vault） | `#/knowledge/vaults` | `knowledge(action=…)` |
| **记忆文件** | `#/memory` | 对话自动注入 / 回忆 |
| **会话文件上传** | 聊天 Composer | 单次会话解析 |

详见 [知识库](knowledge-vault.md) [[guides/configuration/knowledge-vault|知识库]]、[记忆管理](memory-management.md) [[guides/configuration/memory-management|记忆管理]]。

---

## 相关阅读

- [[guides/configuration/knowledge-vault|知识库（Obsidian Vault）]] — 连接本机笔记库的全新方案
- [[guides/configuration/memory-management|记忆管理]] — 用户偏好与事实记忆
- [[guides/integrations/obsidian-knowledge-vault|Obsidian Vault 集成]] — 底层架构与 MCP 细节
- [[guides/chat/file-upload|文件上传]] — 会话级附件解析
