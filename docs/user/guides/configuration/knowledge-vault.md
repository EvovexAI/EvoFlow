# 知识库（Obsidian Vault）

> **比如你一直在用 Obsidian 记笔记，现在想让 AI 直接查你的笔记**：
>
> 1. 在"知识库"页面连接你的 Obsidian Vault 文件夹
> 2. 在聊天里问"我之前关于 API 设计的那篇笔记里写了什么？"——AI 直接搜索你的笔记并回答
> 3. 支持双链关系：AI 能顺着笔记的 `[[链接]]` 找到相关内容
>
> 跟[上传文档（RAG）](document-knowledge-base.md)的区别：Vault 连接本地笔记目录，保留原文件与双链；上传文档做向量 RAG，适合零散 PDF/Word。

连接本机 **Obsidian Vault** 或任意 Markdown 文件夹，做全文 / 语义检索、预览与局部链接图。侧栏入口：**知识库**（`#/knowledge/vaults`）。页眉英文副标题为 Knowledge Vault。

系统会自动注册只读内置库 **「EvoFlow 用户指南」**（内容来自产品文档 `docs/user`），供小V与 Agent 检索用法/概念；你仍可继续连接自己的 Vault。内置库卡片带「内置」标记，不可删除（可停用）。

CLI（检索内置 / 已连接 Vault，默认全文）：

```bash
evoflow knowledge vaults
evoflow knowledge recall "知识库"
evoflow knowledge list --vault evoflow-user-guide
evoflow knowledge get guides/configuration/knowledge-vault.md
```

> **边界**  
> - 本页 ≠ 侧栏「上传文档」RAG（`#/knowledge`，工具 `search_knowledge_base`）  
> - 本页 ≠ 「记忆文件」`memory.json`  
> - 笔记文件仍在你选的本地目录；EvoFlow 只存连接配置与索引缓存  
> 架构与 MCP / API 细节见 [Obsidian Knowledge Vault 集成](../integrations/obsidian-knowledge-vault.md)。

---

## 前置条件

1. 本机已有 Obsidian Vault，或普通 Markdown 目录
2. （生产/打包环境）本机可用 **Node**，用于跑检索 MCP；面板「添加并初始化」会安装钉版本依赖
3. 开发环境也可先执行：`make setup-kb-mcp`

---

## 快速开始

1. 侧栏点 **知识库**
2. 点 **连接知识库**
3. 填 **名称**，用 **选择文件夹** 选 Vault 根目录
4. 点 **添加并初始化**（后台安装 MCP 并建索引）
5. 点卡片进入全屏工作区：左侧浏览 / 搜索，右侧读笔记
6. 需要时：**重建索引** 或 **增量更新**

聊天中 Agent 通过单一工具 `knowledge`（`action=search|read|graph|…`）访问已连接且启用的 Vault。

---

## Hub 列表 `#/knowledge/vaults`

| 控件 | 说明 |
|------|------|
| **刷新** | 重新加载列表 |
| **连接知识库** | 打开添加向导 |
| 卡片 | 进入该 Vault 全屏工作区 |
| 卡片菜单 | **编辑** / **重建索引** / **测试连接** / **删除** |

**删除**只移除 EvoFlow 里的连接配置，**不会**删除你磁盘上的 Vault 文件。

---

## 连接 / 编辑向导

面板简化向导主要暴露：

| 字段 | 必填 | 说明 |
|------|------|------|
| **名称** | 是 | 如：我的知识库 |
| **Vault 目录** | 是 | Obsidian 库根或 Markdown 文件夹 |

创建后默认走本地检索管线（常见为本地 embedding）。读写模式、Local REST API Key、远程 MCP URL 等高级项见 [集成说明](../integrations/obsidian-knowledge-vault.md)；写入相关 UI 可能默认关闭（可用本地开关打开，见集成文档 / 面板设置）。

---

## 工作区

进入卡片后隐藏全局侧栏，专注阅读。

### 浏览

| 控件 | 说明 |
|------|------|
| 搜索文件名… | 过滤目录树 |
| 刷新目录 | 重新拉文件树 |
| 文件树 | 点开笔记 |

### 搜索

| 控件 | 说明 |
|------|------|
| 搜索框 | 标题、内容、标签等 |
| **全文** / **语义** / **混合** / **标题** | 检索模式（语义/混合需向量就绪） |
| **Top K** | 5 / 10 / 15 / 20 |
| 结果卡片 | 打开对应笔记 |

### 笔记阅读器

| 控件 | 说明 |
|------|------|
| **编辑** / **预览** | 视图切换 |
| **链接** | 局部关系图 |
| **打开** | 在 Obsidian 中打开（若已安装） |
| **保存** | 可写模式下落盘（Ctrl+S） |
| 状态 | 保存中 / 未保存 / 已同步 / 只读 |

### 索引与运维

| 操作 | 说明 |
|------|------|
| **重建索引** | 全量重建 |
| **增量更新** | 同步新增或修改的笔记 |
| **测试连接** | 检查检索服务 |
| **打开文件夹** | 系统文件管理器打开 Vault |

常见状态文案：**索引就绪（含语义）**、**全文就绪（语义不可用）**、**重建中**、**尚未建索引**、**检索异常**、**已禁用** 等。

---

## 常见问题

**Q：和「上传文档」选哪个？**  
已有 Obsidian / 本地笔记库、要保留双链与原文件 → **知识库**。零散 PDF/Word 要做成企业 RAG → **上传文档**。

**Q：添加并初始化失败？**  
看是否缺 Node、或需 `make setup-kb-mcp` / 面板重试初始化。错误码如 `node_runtime_missing` 时按提示安装，勿静默忽略。

**Q：语义搜灰掉 / 只能全文？**  
向量未就绪时会降级全文/标题；可重建索引或检查 embedding 配置（集成文档）。

**Q：Agent 读不到笔记？**  
确认 Vault **已启用**、索引非异常；当前智能体是否具备 `knowledge` 工具权限。

---

## 相关阅读

- [Obsidian Knowledge Vault 集成](../integrations/obsidian-knowledge-vault.md) — MCP、读写、安全
- [上传文档（RAG）](document-knowledge-base.md)
- [记忆管理](memory-management.md)
- [面板使用指南](evopanel-guide.md)
