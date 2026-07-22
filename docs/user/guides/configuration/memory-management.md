# 记忆管理

> **比如你告诉 AI"我叫小明，喜欢用 Python，工作做后端开发"**：
>
> AI 会记住这些信息。下次你再跟它聊天，它知道：
> - 你叫小明，不用再自我介绍
> - 你偏好 Python，代码建议会用 Python 举例
> - 你做后端，技术方案会偏后端语境
>
> 每个自定义角色拥有独立的记忆文件，互不污染。你可以在"记忆管理"面板查看、编辑或删除特定记忆。

## 前置条件
- EvoFlow 已运行
- 记忆功能已开启（默认开启，可在 `config.yaml` 中 `memory.enabled: true` 确认）

## 记忆是什么

简单说，记忆就是 AI 记住的"关于你的事实"——比如你的名字、工作背景、偏好。每个自定义角色有独立的记忆文件，互不污染。

> 记忆存的是"偏好和事实"，跟[上传文档（RAG）](document-knowledge-base.md)（存文档内容）和[知识库（Vault）](knowledge-vault.md)（存笔记）不同。三者分工见文末的表格。

工作原理：每次对话结束后，AI 自动从对话中提取有用信息，异步写入记忆文件。整个过程不需要你手动操作——你只需要在面板里查看、编辑或删除记忆就行。

> 底层机制（更新队列、防抖、原子写入）见[记忆系统原理](../../explanation/memory-system.md)。

## 在面板中管理记忆

EvoFlow 桌面端提供以下记忆管理功能：

- **侧栏 → 记忆**：查看当前记忆数据（用户上下文、事实列表）
- **编辑记忆**：手动修改或删除特定事实
- **清空记忆**：重置所有记忆数据
- **导入/导出**：导出 `memory.json` 文件备份，或导入外部记忆文件
- **按 Agent 管理**：每个自定义 Agent 有独立的记忆文件

### 通过 API 查询

```bash
# 获取记忆数据
curl http://localhost:8001/api/memory

# 获取记忆状态
curl http://localhost:8001/api/memory/status
```

## 外部记忆插件（可选）

EvoFlow 支持外接记忆插件（如 Honcho），实现跨平台记忆同步：

```yaml
memory:
  external_provider: ""           # 插件标识（空=禁用）
  external_sync_enabled: false    # 内置记忆更新后同步到外部插件
  external_prefetch_enabled: false  # 模型调用前从外部插件预取记忆
```

## 验证是否生效

```bash
# 检查记忆状态
curl http://localhost:8001/api/memory/status

# 开始对话，询问 Agent "你记得关于我的什么？"
# Agent 应返回记忆中存储的事实
```

## 常见问题

**Q: 记忆没有更新？**
检查 `memory.enabled: true`。确认对话中包含用户消息和 AI 回复（仅有工具调用不会触发更新）。等待 `debounce_seconds` 后再检查。

**Q: 事实太多，想让 Agent 只记住重要的？**
提高 `fact_confidence_threshold`（如 0.8）或降低 `max_facts`。

**Q: 如何清除所有记忆？**
通过面板「记忆」页面点击"清空记忆"，或手动重置 `memory.json` 文件。

**Q: 上传文件的信息被存入了记忆？**
系统会自动过滤包含文件上传描述的事实，避免跨会话残留临时文件引用。

## 相关文档
- [EvoFlow 桌面端使用指南](evopanel-guide.md)
- [上传文档（RAG）](document-knowledge-base.md) — 向量知识库，不是 memory.json
- [知识库（Vault）](knowledge-vault.md) — Obsidian / Markdown 本地库
- [会话文件上传](../chat/file-upload.md) — 仅当前线程
