# 工具与 MCP 配置指南

## 适用场景

通过 Model Context Protocol (MCP) 扩展 EvoFlow 的能力，接入文件系统、数据库、GitHub、搜索引擎等外部服务。本文档分两部分：

- **基础使用**：通过 EvoPanel 界面管理 MCP（推荐普通用户）
- **进阶配置**：直接编辑 `extensions_config.json` 配置文件（适合开发者、批量管理、CI/CD 场景）

## 什么是 MCP

Model Context Protocol 是 Anthropic 提出的开放协议，允许 AI 应用以统一方式接入外部工具和数据源。MCP 服务器暴露标准化的工具接口，EvoFlow 自动发现并将其注册为 Agent 可用的工具。

---

# 一、基础使用（GUI）

## 页面入口

点击左侧菜单栏「扩展」分类下的「工具管理」进入 MCP 服务器管理页面，包含两个 Tab：「已安装」和「市场」。

## 管理已安装 MCP 服务器

进入「已安装」Tab 可以查看所有已经配置的 MCP 服务器：

- 每个 MCP 卡片展示名称、类型（stdio/SSE/streamable-http）、功能描述、运行状态
- 卡片右上角的开关可以快速启用/禁用对应 MCP，禁用后所有 Agent 都无法访问该 MCP 服务器
- 非系统内置的自定义 MCP 可以点击卡片右下角的删除按钮删除
- 顶部搜索框支持按 MCP 名称/描述过滤
- 右侧状态下拉可以筛选查看「全部」「已启用」「已禁用」MCP
- 点击「导入配置」按钮可以通过 JSON 格式批量导入 MCP 服务器配置

## 安装新 MCP 服务器

### 方式一：从 MCP 市场安装

1. 切换到「市场」Tab，自动加载热门公开 MCP 服务器
2. 顶部搜索框输入关键词搜索需要的 MCP
3. 找到需要的 MCP 后，点击卡片右下角的「安装」按钮，自动完成配置和启用
4. 安装完成后按钮变为「已安装 ✓」，可在已安装 Tab 查看和管理

### 方式二：手动配置自定义 MCP

1. 在「已安装」Tab 点击页面右上角的「添加 MCP」按钮
2. 选择 MCP 类型，填写对应配置：
   - **stdio 类型（本地进程）**：命令（如 npx、python）、参数、描述
   - **SSE 类型**：URL（SSE 服务地址）、描述
   - **streamable-http 类型**：URL（HTTP 流式服务地址）、描述
3. 点击确认即可完成添加，MCP 自动启用

## 给 Agent 配置 MCP 权限

安装后的 MCP 需要在 Agent 配置中启用才能使用：

1. 进入左侧「Agent 管理」页面，编辑对应 Agent
2. 切换到「MCP 模块」Tab
3. 勾选需要让该 Agent 访问的 MCP 服务器，或勾选「全部可用」使用所有已启用的 MCP
4. 保存即可生效，后续该 Agent 对话时会根据需求自动调用对应 MCP 服务器的能力

## 常见 MCP 配置示例（GUI 输入）

### 1. 文件系统 MCP（stdio 类型）

```json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/working/directory"],
  "description": "本地文件系统访问能力"
}
```

### 2. 远程 SSE 服务 MCP

```json
{
  "type": "sse",
  "url": "http://localhost:3000/sse",
  "description": "远程 SSE 服务能力"
}
```

### 3. 流式 HTTP 服务 MCP

```json
{
  "type": "streamable-http",
  "url": "http://localhost:8080/mcp",
  "description": "远程 HTTP 流式服务能力"
}
```

---

# 二、进阶配置（JSON 文件直接编辑）

## 配置文件位置

MCP 服务器配置在项目根目录下的 `extensions_config.json`：

```json
{
  "mcpServers": {
    "server_name": {
      "enabled": true,
      "type": "stdio|sse|http",
      ...
    }
  },
  "skills": {}
}
```

## 传输类型完整示例

### stdio（标准输入输出）

通过子进程启动 MCP 服务器，通过 stdin/stdout 通信。

```json
{
  "mcpServers": {
    "filesystem": {
      "enabled": true,
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/files"],
      "env": {},
      "description": "Provides filesystem access within allowed directories"
    },
    "github": {
      "enabled": true,
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "$GITHUB_TOKEN"
      },
      "description": "GitHub MCP server for repository operations"
    }
  }
}
```

### SSE（Server-Sent Events）

```json
{
  "mcpServers": {
    "remote-server": {
      "enabled": true,
      "type": "sse",
      "url": "https://example.com/mcp/sse",
      "description": "Remote MCP server via SSE"
    }
  }
}
```

### HTTP

```json
{
  "mcpServers": {
    "http-server": {
      "enabled": true,
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": {},
      "description": "Remote MCP server via HTTP"
    }
  }
}
```

## OAuth 认证（HTTP/SSE）

HTTP/SSE 类型的服务器支持 OAuth 2.0 自动令牌获取和刷新。

支持的授权类型：

- `client_credentials` — 使用 client_id/client_secret 获取令牌
- `refresh_token` — 使用 refresh_token 刷新访问令牌

```json
{
  "mcpServers": {
    "secure-server": {
      "enabled": true,
      "type": "http",
      "url": "https://api.example.com/mcp",
      "oauth": {
        "enabled": true,
        "token_url": "https://auth.example.com/oauth/token",
        "grant_type": "client_credentials",
        "client_id": "$MCP_OAUTH_CLIENT_ID",
        "client_secret": "$MCP_OAUTH_CLIENT_SECRET",
        "scope": "mcp.read",
        "refresh_skew_seconds": 60
      }
    }
  }
}
```

**OAuth 工作机制：**

- 令牌自动缓存，到期前自动刷新（`refresh_skew_seconds` 定义提前刷新的缓冲时间）
- Authorization 头自动注入到每个 MCP 请求
- 敏感值通过环境变量引用（`$VAR` 格式），不要明文写入

## 运行时热重载

通过 Gateway API 修改 MCP 配置后，LangGraph 自动检测文件变更（mtime 对比）并重新加载工具，**无需重启服务**：

```bash
# 通过 Gateway API 更新配置
curl -X PUT http://localhost:8001/api/mcp/config \
  -H "Content-Type: application/json" \
  -d '{
    "mcpServers": {
      "new-server": {
        "enabled": true,
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"],
        "description": "PostgreSQL access"
      }
    }
  }'

# 获取当前配置
curl http://localhost:8001/api/mcp/config
```

## 完整示例（多服务器组合）

```json
{
  "mcpServers": {
    "filesystem": {
      "enabled": true,
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/docs"],
      "env": {},
      "description": "File system access"
    },
    "postgres": {
      "enabled": false,
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"],
      "env": {},
      "description": "PostgreSQL database"
    },
    "brave-search": {
      "enabled": true,
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": {
        "BRAVE_API_KEY": "$BRAVE_API_KEY"
      },
      "description": "Web search via Brave"
    }
  },
  "skills": {}
}
```

## 验证是否生效

```bash
# 查看 Gateway 上注册的 MCP 配置
curl http://localhost:8001/api/mcp/config

# 在对话中让 Agent 列出可用工具，确认 MCP 工具已加载
```

## 常见问题

**Q: MCP 工具没有出现在 Agent 工具列表中？**
检查 `"enabled": true` 是否设置正确。查看 Gateway 日志确认 MCP 服务器启动无错误。

**Q: stdio 类型的 MCP 服务器启动失败？**
确保 `command` 在 PATH 中可用。对于 `npx` 命令，确认 Node.js 已安装。

**Q: OAuth 令牌刷新失败？**
检查 `token_url` 是否正确，`client_id`/`client_secret` 是否有效。查看日志中的 OAuth 错误信息。

**Q: 修改了 `extensions_config.json` 文件但没生效？**
文件需保存到项目根目录。Gateway 通过 mtime 检测变更，等待几秒后自动加载。也可通过 API 热更新。

## 相关文档

- [MCP 官方文档](https://modelcontextprotocol.io)
- [沙箱模式配置](./sandbox-config.md)
- [AI 助手对话](../chat/basic-functions.md)

