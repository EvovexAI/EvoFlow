# 文件上传

> **比如你手头有份 PDF 合同，想让 AI 帮你分析**：
>
> 1. 在聊天框点"附件"按钮，上传合同 PDF
> 2. AI 自动读取内容，你说"帮我总结一下这份合同的关键条款和风险点"
> 3. AI 基于 PDF 内容直接回答
>
> 支持 PDF、PowerPoint、Excel、Word 格式，单文件最大 100MB。上传后自动转成 Markdown，AI 就能读。文件不会长期保存，适合一次性分析。
>
> **功能关系**：文件上传是**当前会话的附件**，不是长期知识库——如果需要可反复检索的向量库，使用[上传文档（RAG）](../configuration/document-knowledge-base.md)；如果要连接 Obsidian/Markdown 笔记，使用[知识库（Vault）](../configuration/knowledge-vault.md)。三者覆盖不同粒度的知识管理需求。

## 适用场景
向 EvoFlow **会话**上传文档文件（PDF、PPT、Excel、Word），让 Agent 基于文件内容回答问题或执行分析。

> 这是**当前线程**的附件，不是长期知识库。  
> - 要做成可反复检索的向量库 → [上传文档（RAG）](../configuration/document-knowledge-base.md)  
> - 要连接 Obsidian / Markdown 笔记 → [知识库（Vault）](../configuration/knowledge-vault.md)

## 前置条件
- EvoFlow 已运行
- 已知目标 `thread_id`

## 方式一：通过聊天界面（推荐）

1. 在对话输入框（Composer）中点击 **附件** 按钮（📎 或 +）
2. 选择本机文件，支持多选
3. 文件上传后，Agent 会自动识别并可在回复中引用内容

> 文件上传后会被 `markitdown` 自动转换为 Markdown，Agent 可直接读取。

## 方式二：通过 API

```bash
# 上传单个文件
curl -X POST http://localhost:2026/api/threads/{thread_id}/uploads \
  -F "files=@/path/to/document.pdf"

# 上传多个文件
curl -X POST http://localhost:2026/api/threads/{thread_id}/uploads \
  -F "files=@/path/to/document.pdf" \
  -F "files=@/path/to/presentation.pptx" \
  -F "files=@/path/to/spreadsheet.xlsx"
```

**响应示例：**
```json
{
  "success": true,
  "files": [
    {
      "filename": "document.pdf",
      "size": 1234567,
      "path": ".evo-flow/threads/{thread_id}/user-data/uploads/document.pdf",
      "virtual_path": "/mnt/user-data/uploads/document.pdf",
      "markdown_file": "document.md",
      "markdown_path": ".evo-flow/threads/{thread_id}/user-data/uploads/document.md"
    }
  ]
}
```

### 列出已上传文件

```bash
curl http://localhost:2026/api/threads/{thread_id}/uploads/list
```

### 删除文件

```bash
curl -X DELETE http://localhost:2026/api/threads/{thread_id}/uploads/document.pdf
```

## 自动文档转换

使用 `markitdown` 自动将以下格式转换为 Markdown：

| 格式 | 扩展名 |
|------|--------|
| PDF | `.pdf` |
| PowerPoint | `.ppt`, `.pptx` |
| Excel | `.xls`, `.xlsx` |
| Word | `.doc`, `.docx` |

转换后的 `.md` 文件保存在同目录下，Agent 可通过 `read_file` 工具直接读取。

## 存储结构

```
backend/.evo-flow/threads/
└── {thread_id}/
    └── user-data/
        └── uploads/
            ├── document.pdf      # 原始文件
            ├── document.md       # 转换后的 Markdown
            └── ...
```

**线程隔离**：每个 thread 的文件存储在独立目录，不可跨线程访问。

## 限制

- **最大文件大小**：100MB（可通过 nginx `client_max_body_size` 调整）
- **路径安全**：自动验证文件路径，防止目录遍历攻击

## 常见问题

**Q: 文件上传失败？**
检查文件大小是否超过 100MB 限制。确认磁盘空间充足。查看 Gateway 日志。

**Q: 文档转换失败？**
确认 `markitdown` 已正确安装（`uv run python -c "import markitdown"`）。加密或损坏的文档可能无法转换，但原文件仍会保存。

**Q: Agent 看不到上传的文件？**
确认 thread_id 正确。检查 UploadsMiddleware 是否已注册（默认已注册）。

## 相关文档
- [沙箱模式配置](../configuration/sandbox-config.md)
- [工具与 MCP 配置](../configuration/tools-mcp.md)
