---
name: mcp-terminal
description: "【已废弃】历史技能：通过 terminal stdio 调 MCP。现用原生 mcp__server__tool，见 tools-mcp 指南。仅 debug 保留。"
homepage: https://modelcontextprotocol.io
metadata:
  {
    "evoflow":
      {
        "emoji": "🔌",
        "requires": { "bins": ["npx", "node"] },
      },
  }
---

---

> **⚠️ 已废弃（2026-08）**  
> EvoFlow 已与 原生运行时：**MCP 工具是原生 function 工具**，名称为 ``mcp__<服务器>__<工具>``，由 Agent 直接调用。  
> **不要**再为本技能启用 terminal JSON-RPC 路径；飞书等请配 MCP 连接器并在角色「能力 → MCP 模块」勾选。  
> 本技能仅保留供离线脚本/debug，新任务勿加载。

# MCP Terminal（legacy）

通过 **`terminal`** 工具以 stdio 模式调用 MCP 服务器，无需系统内置 MCP 集成。

## 原理

MCP（Model Context Protocol）服务器可以通过 stdio（标准输入/输出）方式启动，Agent 通过 `terminal` 向子进程写入 JSON-RPC 请求并读取响应。

```
Agent → terminal → npx <mcp-server-package> → stdin/stdout JSON-RPC
```

## 辅助脚本（推荐）

技能自带 Node.js 辅助脚本，位于 `scripts/` 目录下，跨平台兼容（Windows / macOS / Linux）。

> 运行脚本时，路径相对于项目根目录：`node skills/public/mcp-terminal/scripts/<script>`

### mcp-list.js — 列出工具

```bash
node skills/public/mcp-terminal/scripts/mcp-list.js <package> [args...]
```

**示例：**
```bash
# 列出飞书 MCP 工具
node skills/public/mcp-terminal/scripts/mcp-list.js @lark-opendata/lark-mcp

# 列出文件系统 MCP 工具（带路径参数）
node skills/public/mcp-terminal/scripts/mcp-list.js @modelcontextprotocol/server-filesystem /path/to/allowed/dir
```

### mcp-call.js — 调用工具

```bash
node skills/public/mcp-terminal/scripts/mcp-call.js <package> <tool> [jsonArgs] [extraArgs...]
```

**示例：**
```bash
# 发送飞书消息
node skills/public/mcp-terminal/scripts/mcp-call.js @lark-opendata/lark-mcp feishu_message_send '{"receive_id":"oc_xxxx","content":"你好","msg_type":"text"}'

# 读取文件
node skills/public/mcp-terminal/scripts/mcp-call.js @modelcontextprotocol/server-filesystem read_file '{"path":"/tmp/test.txt"}'

# 带环境变量（GitHub MCP）
# macOS / Linux
node skills/public/mcp-terminal/scripts/mcp-list.js @modelcontextprotocol/server-github
# 先设置环境变量：
# export GITHUB_TOKEN="your_token"

# Windows PowerShell
# $env:GITHUB_TOKEN="your_token"
```

### 脚本优势 vs 原始管道

| 对比项 | 原始 `echo \| npx` | 辅助脚本 |
|--------|-------------------|----------|
| JSON 转义 | 各 shell 规则不同，易出错 | Node.js 原生构造，零转义问题 |
| 错误处理 | 需手动解析 | 自动检测 `error` 字段并格式化 |
| 超时控制 | 依赖 terminal timeout | 可内置超时逻辑 |
| 跨平台 | 需注意 shell 差异 | 天然跨平台 |
| 可读性 | JSON 内嵌在 shell 命令中 | 参数分离，清晰明了 |

## 原始方式（直接管道）

如果不想用脚本，也可以用原始 `echo | npx` 方式：

### 1. 列出 MCP 服务器的可用工具

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | npx -y <mcp-server-package> [args...]
```

### 2. 调用 MCP 工具

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"<tool_name>","arguments":{...}}}' | npx -y <mcp-server-package> [args...]
```

### 3. 解析响应

MCP 服务器返回 JSON-RPC 响应，格式为：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "结果内容..."
      }
    ]
  }
}
```

## 飞书 / lark-mcp 使用指南

### 前置条件

lark-mcp 包已安装或可通过 npx 获取。首次运行会自动引导 OAuth 认证流程。

### 列出飞书工具

```bash
# 推荐：用辅助脚本
node skills/public/mcp-terminal/scripts/mcp-list.js @lark-opendata/lark-mcp

# 或原始方式
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | npx -y @lark-opendata/lark-mcp
```

返回的 tools 列表包含工具名称、描述和参数 schema，例如：
- `feishu_bitable_list_records` — 列出多维表格记录
- `feishu_bitable_create_record` — 创建多维表格记录
- `feishu_docx_get_document` — 获取飞书文档
- `feishu_message_send` — 发送消息
- `feishu_calendar_create_event` — 创建日历事件
- 等等

### 调用飞书工具

```bash
# 推荐：用辅助脚本
node skills/public/mcp-terminal/scripts/mcp-call.js @lark-opendata/lark-mcp feishu_message_send '{"receive_id":"oc_xxxx","content":"你好，这是一条来自 MCP 的消息","msg_type":"text"}'

# 或原始方式
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"feishu_message_send","arguments":{"receive_id":"oc_xxxx","content":"你好，这是一条来自 MCP 的消息","msg_type":"text"}}}' | npx -y @lark-opendata/lark-mcp
```

```bash
# 列出多维表格记录
node skills/public/mcp-terminal/scripts/mcp-call.js @lark-opendata/lark-mcp feishu_bitable_list_records '{"app_token":"xxxx","table_id":"xxxx"}'
```

### 飞书 OAuth 认证

首次运行 lark-mcp 时，终端会输出 OAuth 认证 URL。Agent 需要：

1. 将认证 URL 展示给用户
2. 提示用户在浏览器中打开并完成授权
3. 认证成功后，token 会缓存到本地，后续调用无需重复认证

## 通用 MCP 服务器示例

### 文件系统 MCP

```bash
# 列出工具
node skills/public/mcp-terminal/scripts/mcp-list.js @modelcontextprotocol/server-filesystem /path/to/allowed/dir

# 读取文件
node skills/public/mcp-terminal/scripts/mcp-call.js @modelcontextprotocol/server-filesystem read_file '{"path":"/path/to/file.txt"}'
```

### GitHub MCP

```bash
# macOS / Linux — 环境变量要放在 npx 前面（管道中只对所在命令生效）
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | GITHUB_TOKEN="your_token" npx -y @modelcontextprotocol/server-github
```

```powershell
# Windows PowerShell
$env:GITHUB_TOKEN="your_token"; echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | npx -y @modelcontextprotocol/server-github
```

## 跨平台注意事项

### 核心命令（全平台通用）

`echo '...' | npx -y <package>` 在 **macOS / Linux / Windows** 上均可用。`echo` 和管道 `|` 是所有 shell 都支持的基础功能。

辅助脚本 `node scripts/xxx.js` 更是天然跨平台。

### 各平台差异

| 操作 | macOS / Linux (bash/zsh) | Windows (PowerShell) | Windows (cmd) |
|------|--------------------------|----------------------|----------------|
| 环境变量 | `KEY=val command` | `$env:KEY="val"; command` | `set KEY=val && command` |
| JSON 字符串 | 单引号 `'...'` | 单引号 `'...'` 或双引号 `"..."` 转义 | 双引号 `"..."` |
| 多命令链接 | `&&` | `;` | `&&` |
| 路径分隔符 | `/` | `\` | `\` |

### 推荐做法

1. **优先用辅助脚本**：`node scripts/mcp-list.js <pkg>` — 避免 shell JSON 转义问题，全平台一致。
2. **cmd.exe 注意**：cmd 不支持单引号字符串，`echo '...'` 会原样输出引号。如果必须在 cmd 下使用原始方式，请用双引号并转义内部引号：`echo "{"""key""":"""val"""}"`。建议优先使用 PowerShell 或辅助脚本。
3. **环境变量**：需要设置 token 时，按平台选择对应语法（见上表）。
4. **超时设置**：MCP 工具调用可能耗时较长，`terminal` 的 timeout 参数建议设 30-60 秒。
5. **首次启动慢**：`npx -y` 首次运行会下载包，后续使用会缓存，速度更快。
6. **认证持久化**：OAuth token 会缓存到本地文件系统，同一台机器上后续调用无需重复认证。
7. **错误处理**：如果返回 `{"error":...}`，检查参数是否正确、认证是否有效。

## 适用场景

| 场景 | 说明 |
|------|------|
| 飞书消息发送 | 通过 lark-mcp 发送文本/富文本消息到飞书群聊或用户 |
| 飞书文档操作 | 读取、创建、更新飞书文档 |
| 飞书多维表格 | 查询和操作飞书多维表格（Bitable）记录 |
| 飞书日历 | 创建、查询、更新飞书日历事件 |
| 飞书通讯录 | 查询用户、部门信息 |
| 其他 MCP 服务 | 任何通过 stdio 方式提供的 MCP 服务器 |
