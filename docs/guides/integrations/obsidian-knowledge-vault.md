# Obsidian Knowledge Vault 集成

EvoFlow 将 **Obsidian Vault** 作为一等 Knowledge Vault：笔记仍以普通 Markdown、YAML Frontmatter 与 `[[wikilinks]]` 保存在本地 Vault 中；Obsidian 仅作人工编辑界面；智能体通过单一高层工具 `knowledge(action=…)` 访问，底层复用成熟开源 MCP 服务。

> **边界**：Knowledge Vault ≠ `memory.json` 用户记忆，也 ≠ 面板「知识库」上传文档 RAG（`search_knowledge_base`）。

## 架构

```text
Obsidian (Markdown / YAML / wikilinks)
        │
        ├─ obsidian-hybrid-search@0.13.22   (检索 / 读 / 索引)
        └─ obsidian-mcp-server@3.2.9       (写 / 标签 / 属性；MVP 不含删除与命令执行)
                │
                └─ MCP (managed stdio 或 external HTTP)
                        │
                        ▼
              ObsidianKnowledgeProvider
                        │
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
   knowledge tool   Skill/Agents  Gateway / EvoPanel
```

## 只读模式（推荐）

1. EvoPanel → **知识库** → **Obsidian Vault** → 连接 Vault。
2. 用原生目录选择器选择 Vault 根目录。
3. 访问方式保持 **只读**。
4. 开发环境先安装项目内 MCP 依赖：`make setup-kb-mcp`（安装到 `backend/packaging/kb-mcp`，版本钉在该目录的 `package.json`）。面板「安装并初始化」也会装到同一位置。
5. 无需启动 Obsidian，也无需 API Key。
6. Agent 可使用单一工具：`knowledge`（`action=search|read|graph|status`）。

## 读写模式

1. 在 Obsidian 安装并启用 [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) 插件。
2. 复制 API Key，在 Vault 设置中选择 **读写**，粘贴 Key（仅存为秘密引用，API 不回显）。
3. 配置允许写入目录（默认 `00-Inbox`）与默认 Inbox。
4. 写入服务不可用时：检索仍可用，写入返回 `obsidian_not_running`，**不会**改写你保存的 accessMode。

## Embedding

| 模式 | 说明 |
|------|------|
| `local` | 默认；由 OHS 本地模型处理，不要求云端 Key |
| `openai_compatible` | 需 Base URL / Model / API Key（秘密引用） |

语义不可用时，Provider 可降级到 `fulltext` / `title`，知识库整体仍可用。

## 运行模式

### Managed STDIO（默认）

由 EvoFlow 管理 MCP 子进程（**参数数组启动，不拼接 shell**）。

| 模式 | 行为 |
|------|------|
| **开发** | 优先使用仓库内 `backend/packaging/kb-mcp`（`make setup-kb-mcp`）；未安装时可回退 `npx`（`EVOFLOW_KB_MCP_LAUNCH=npx`） |
| **生产** (`private` / 打包 `EVOFLOW_PACKAGED=1`) | 启动 `node <绝对路径>/dist/...js`，包来自打包进安装包的 `tools/kb-mcp` 或 `{EVOFLOW_HOME}/runtime/kb-mcp`；**禁止**启动时在线 `npx -y` |

固定版本（与 `backend/packaging/kb-mcp/package.json` 一致）：

- 检索：`obsidian-hybrid-search@0.13.22` → `dist/src/server.js`
- 写入：`obsidian-mcp-server@3.2.9` → `dist/index.js`
- 工具前缀：`OBSIDIAN_PREFIX=evo_kb_`（实际工具名：`evo_kb_search` / `evo_kb_read` / `evo_kb_reindex` / `evo_kb_status`）

**Node 运行时**：当前安装包尚未捆绑 Node sidecar。生产模式按序查找：

1. `EVOFLOW_KB_NODE`
2. `{EVOFLOW_HOME}/runtime/node`（Windows: `node.exe`；macOS/Linux: `bin/node`）
3. 系统 PATH 中的 `node`（仅用于执行**已安装的私有包**，不会在启动时联网安装）

缺少 Node 或私有包时，面板显示明确错误（`node_runtime_missing` / 需 `make setup-kb-mcp` 或点击「安装并初始化」），**不会静默失败**。

同一 Vault 复用长期运行实例；删除配置或禁用时释放子进程。应用升级时需重新 `make setup-kb-mcp` /「安装并初始化」以对齐固定版本；卸载安装包**不会**删除用户 Vault 目录（Vault 在用户自选路径）。OHS 索引缓存在 OS 用户缓存目录 / 运行时目录，可随数据目录清理。

### External HTTP

高级用户可填写本机 MCP URL（默认仅允许 `127.0.0.1` / `localhost`）。连接非本机地址需显式确认 `allowRemoteHttp`。

## 路径与安全

- 仅允许 Vault **相对路径**；禁止 `..`、绝对路径、空字节与符号链接逃逸。
- 写入同时受 EvoFlow allowlist 与 MCP Server allowlist 约束。
- 默认只读；写工具标记为 session 级审批（与 PlanGuard / tool approval 兼容）。
- 注入模型上下文时使用 `<knowledge-source>` 边界；笔记中的注入话术只作正文。
- MVP **不**向智能体开放删除与 Obsidian 命令执行工具。

## 高层工具

智能体目录只注册 **一个** 工具：`knowledge`。用 `action` 区分操作：

| action | 作用 |
|--------|------|
| `search` | hybrid / semantic / fulltext / title |
| `read` | 读取笔记（带知识边界包装） |
| `graph` | 局部关系图 depth≤3 |
| `write` | create / append / patch / frontmatter / tags（需 read_write vault） |
| `ingest` | 查重后写入 Inbox（需 read_write vault） |
| `status` | 连接与索引状态 |

旧名 `knowledge_search` 等在角色白名单中会映射到 `knowledge`。写类 action 在无读写 Vault 时返回明确错误。

预设子智能体：`knowledge-retriever`（只读）、`knowledge-curator`（可写，仍受 Vault 约束）。

## Gateway API

前缀：`/api/knowledge/vaults`

- `GET/POST /` — 列表 / 创建
- `GET/PUT/DELETE /{id}` — 详情 / 更新 / **仅删配置**
- `POST /{id}/test` · `GET /{id}/status` · `POST /{id}/install` · `POST /{id}/reindex`
- `POST /{id}/search` · `read` · `graph` · `ingest` · `open`

删除配置时：**不**删除 Vault 文件、**不**修改 `.obsidian`。

## 平台注意

- **Windows**：路径盘符 / 反斜杠已规范化；请确保 `node` / `npm` / `npx`（或 `npx.cmd`）在 PATH。
- **macOS / Linux**：同上；目录选择走 Tauri 原生对话框。
- 网络不可用或包下载失败时返回 `package_install_failed` / `node_runtime_missing`。

## 隐私

- API Key 仅存 `evoflow_app_settings` 秘密表项，不以明文写入 Vault 配置。
- 日志与错误会脱敏；Agent Trace 记录路径与操作类型，默认不落完整私密正文。
- 不会把 Vault 整库注入 System Prompt，也不会写入 `memory.json`。

## 完全移除

在面板删除 Vault **连接配置**即可停止 MCP 并清除 EvoFlow 侧秘密引用。Vault 本体保留。

## 第三方依赖（通过 npm 调用，非内嵌源码）

| 项目 | 版本 | 仓库 |
|------|------|------|
| obsidian-hybrid-search | 0.13.22 | https://github.com/flowing-abyss/obsidian-hybrid-search |
| obsidian-mcp-server | 3.2.9 | https://github.com/cyanheads/obsidian-mcp-server |

许可证以上游仓库为准；EvoFlow **不**声称第三方代码归属本项目。版本常量见 `evoflow.knowledge.vault.constants`。

## 示例配置（无真实 Key）

```json
{
  "id": "personal",
  "name": "personal",
  "vaultPath": "D:/Notes/MyVault",
  "accessMode": "read_only",
  "launchMode": "managed_stdio",
  "allowedWritePaths": ["00-Inbox"],
  "defaultInboxPath": "00-Inbox",
  "embeddingMode": "local",
  "obsidianApiKeySecretRef": "vault_personal_obsidian_api_key"
}
```
