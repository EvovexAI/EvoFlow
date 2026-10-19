# 上传文档（旧 RAG 入口）

单独的「上传文档 RAG」页面已并入侧栏 **知识库**。请按 [知识库](knowledge-base.md) 新建库并上传 PDF、Office 或 Markdown。

`#/knowledge` 打开的就是这个知识库首页，不再跳到已删除的 Vault 页。会话里拖文件仍然只属于当前对话，见 [文件上传](../chat/file-upload.md)。

---

## 开发者备注：两套 knowledge API 不互通

| API | 体系 | 谁在用 |
|-----|------|--------|
| `/api/knowledge`（dataset） | 旧上传文档残留 | 旧脚本。新实例列表为空是正常的 |
| `/api/knowledge/owned` | **现在的知识库** | 面板知识库页，以及员工 / 智能体检索 |

AI 检索只读 owned 知识库。给旧 dataset 同步文件，面板里的「问 AI」和员工绑定库都不会看到。
