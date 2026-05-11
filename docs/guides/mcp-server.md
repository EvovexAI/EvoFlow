# MCP 服务器配置

## 适用场景
通过 Model Context Protocol (MCP) 扩展 EvoFlow 的能力，接入文件系统、数据库、GitHub 等外部服务。

## 前置条件
- EvoFlow 已运行
- 了解要接入的 MCP 服务器的启动方式

## 什么是 MCP

Model Context Protocol 是 Anthropic 提出的开放协议，允许 AI 应用以统一方式接入外部工具和数据源。MCP 服务器暴露标准化的工具接口，EvoFlow 自动发现并将其注册为 Agent 可用的工具。

## 步骤

### 1. 配置文件

MCP 服务器配置在 `extensions_config.json`（项目根目录）：

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

### 2. 传输类型

#### stdio（标准输入输出）

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

#### SSE（Server-Sent Events）

通过 HTTP SSE 连接到远程 MCP 服务器。

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

#### HTTP

通过 HTTP POST 连接到远程 MCP 服务器。

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

### 3. OAuth 认证

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

### 4. 运行时热重载

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

### 5. 完整示例

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

---

**最后验证**：2026-05-10；适用范围：默认分支。
