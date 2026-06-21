# 文件上传

## 适用场景
向 EvoFlow 会话上传文档文件（PDF、PPT、Excel、Word），让 Agent 基于文件内容回答问题或执行分析。

## 前置条件
- EvoFlow 已运行
- 已知目标 `thread_id`

## 步骤

### 1. 上传文件

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
      "artifact_url": "/api/threads/{thread_id}/artifacts/mnt/user-data/uploads/document.pdf",
      "markdown_file": "document.md",
      "markdown_path": ".evo-flow/threads/{thread_id}/user-data/uploads/document.md",
      "markdown_virtual_path": "/mnt/user-data/uploads/document.md"
    }
  ]
}
```

### 2. 列出已上传文件

```bash
curl http://localhost:2026/api/threads/{thread_id}/uploads/list
```

### 3. 删除文件

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

## Agent 如何感知上传文件

`UploadsMiddleware` 在每次 Agent 请求前自动注入文件列表：

```xml
<uploaded_files>
The following files have been uploaded and are available for use:

- document.pdf (1.2 MB)
  Path: /mnt/user-data/uploads/document.pdf
- document.md (45.3 KB)
  Path: /mnt/user-data/uploads/document.md
</uploaded_files>
```

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

## 路径映射

| 层面 | 路径 |
|------|------|
| Agent 使用（虚拟路径） | `/mnt/user-data/uploads/document.pdf` |
| 实际存储 | `backend/.evo-flow/threads/{thread_id}/user-data/uploads/document.pdf` |
| 前端访问（artifact URL） | `/api/threads/{thread_id}/artifacts/mnt/user-data/uploads/document.pdf` |

非本地沙箱模式下，文件会自动同步到沙箱容器的 `/mnt/user-data/uploads/` 目录。

## 限制

- **最大文件大小**：100MB（可通过 nginx `client_max_body_size` 调整）
- **路径安全**：自动验证文件路径，防止目录遍历攻击
- **输入验证**：拒绝目录路径作为上传输入

## 验证是否生效

```bash
# 上传文件
curl -X POST http://localhost:2026/api/threads/test-thread/uploads \
  -F "files=@test.pdf"

# 列出文件
curl http://localhost:2026/api/threads/test-thread/uploads/list

# 在对话中引用
# 向 Agent 发送 "请总结我上传的 PDF 文件内容"
```

## 常见问题

**Q: 文件上传失败？**
检查文件大小是否超过 100MB 限制。确认磁盘空间充足。查看 Gateway 日志。

**Q: 文档转换失败？**
确认 `markitdown` 已正确安装（`uv run python -c "import markitdown"`）。加密或损坏的文档可能无法转换，但原文件仍会保存。

**Q: Agent 看不到上传的文件？**
确认 thread_id 正确。检查 UploadsMiddleware 是否已注册（默认已注册）。非本地沙箱场景下确认文件已同步到容器。

## 相关文档
- [沙箱模式配置](../configuration/sandbox-config.md)
- [工具与 MCP 配置](../configuration/tools-mcp.md)
