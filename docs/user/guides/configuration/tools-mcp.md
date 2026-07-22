# 工具与 MCP 配置指南

> **比如你想让 AI 能帮你在 GitHub 上操作**：
>
> 1. 在 MCP 市场一键安装 GitHub MCP
> 2. 配置 GitHub Token
> 3. 在聊天里说"帮我看看这个 repo 最近的 issue"——AI 直接调用 GitHub API 查询
>
> 技能是"领域知识包"（告诉 AI 怎么做），工具是"内置能力"（read/write/terminal），MCP 是"外部服务"（GitHub API、Notion、PostgreSQL 等）。三者互补，可在一个角色上同时配置。

EvoFlow 给 Agent 提供能力的方式分**三层**：内置工具、技能、MCP。本文统一介绍三者的分工，然后展开 MCP 的配置。

---

> **💡 5 分钟配好你的第一个 MCP**
>
> 1. 侧栏「智能体」→ 顶栏 Tab **连接器**（或直达 `#/tools`）
> 2. 切到「市场」Tab，搜索 `github`
> 3. 点「安装」→ 自动写入配置
> 4. 切回「已安装」Tab，打开启用开关
> 5. 去「智能体」编辑当前角色，在「能力 → MCP 模块」勾选刚装的 MCP
> 6. 回到聊天，让 AI「帮我看看 GitHub 上的 Issue」——搞定
>
> 如果市场里没有你要的，往下看手动配置方式。

---

## 一、三者怎么选

| 维度 | 内置工具（Tools） | 技能（Skills） | MCP |
|------|------------------|---------------|-----|
| **形态** | EvoFlow 代码内置函数 | 文件夹 + `SKILL.md` | 外部进程 / HTTP 服务 |
| **来源** | 框架自带，无需配置 | `skills/public/` + `skills/custom/` | 用户自行配置 / 市场安装 |
| **加载** | 启动时注册，按**场景**渐进暴露 | 进 Agent 时按 frontmatter 注入说明 | 配置启用后启动时连接 |
| **触发** | 模型显式调用 | 模型读到说明后**自行决定**调用 | 模型显式调用 |
| **典型例子** | `read`、`terminal`、`web_search`、`worker` | `deep-research`、`pdf`、`superpowers-*` | GitHub MCP、Notion MCP、Postgres MCP |
| **更新方式** | 改代码需重启 | 改文件夹即生效 | 改配置后热重载 |
| **谁来管理** | 框架开发者 | 你 + 社区 + 内置 | 你 + 社区 + 内置 |

**选择建议**：

- 想让 Agent 做**通用基础动作**（读文件、跑命令、搜网络）→ 用**内置工具**（已自带）
- 想让 Agent 掌握一类**结构化能力**（写 PPT、生图、深度调研）→ 装**技能**
- 想让 Agent 接**第三方服务**（GitHub、Notion、Slack、自家内部系统）→ 配 **MCP**

---

## 二、内置工具

EvoFlow 内置一组工具，**按场景渐进暴露**给 Agent——避免一次性把上百个工具描述塞进上下文浪费 Token。面板里的「智能体 → 连接器」主要用于管理 MCP；内置工具本身不需要在 UI 开关，会随你在聊天里选的**场景**自动启用。

### 常用内置工具速览

| 类别 | 工具 | 一句话定位 |
|------|------|-----------|
| **文件读写** | `read` | 读单个文件（支持 offset/limit 分页） |
| | `write` | 写文件（支持覆盖与新建） |
| | `replace` | 精确替换文件中的字符串 |
| | `delete` | 删除单文件（高风险） |
| **检索** | `rg` | ripgrep 内容检索 |
| | `find` | 按文件名 glob 查找 |
| | `search_code_index` | 代码索引检索（符号、引用、类型） |
| **命令** | `terminal` | 同步执行 shell 命令 |
| | `process` | 启动 / 监控 / 终止后台进程 |
| **联网** | `web_search` | 网页搜索（AI 日报 / 53AI / 通用搜索） |
| | `web_fetch_enhanced` | 抓单页转 Markdown |
| **并行执行** | `worker` | 一次跑多个 search / write / replace / delete |
| **图像** | `view_image` | 加载本地图片让模型看像素 |
| **任务** | `todo` | 轻量待办，对话内可见 |
| **协作** | `subagent` | 派发只读探索任务给子代理 |
| | `supervisor` | 跨会话多任务调度（Plan 模式核心） |
| | `plan` | 落库完整计划，配 supervisor 用 |
| **场景与发现** | `scenario` | 激活 / 切换场景（工作区 / 媒体 / Plan…） |
| | `tool_search` | 检索并启用尚未挂载的工具 |
| **可观测性** | `mind_map` | 实时落知识图谱，便于排障与回放 |
| **澄清** | `ask_clarification` | 结构化向用户提问 |

完整工具清单见 [工具参考](../../../system/reference/tool-reference.md)。

### 场景与工具集

每个场景对应一组工具白名单。常见映射：

| 场景 | 解锁的核心工具 |
|------|---------------|
| **日常对话** | 仅 `scenario`、`tool_search`、`ask_clarification` 等编排工具 |
| **workspace（工作空间）** | + `read`、`write`、`replace`、`delete`、`terminal`、`process`、`rg`、`find`、`search_code_index`、`worker`、`view_image`、`mind_map`、`web_search`、`web_fetch_enhanced` |
| **plan（Plan 模式）** | + `plan`、`supervisor`、`subagent` |
| **创意媒体** | + 各厂商生图 / 生视频 / TTS 相关工具 |

详细映射见 [工作空间](../chat/workspace.md) 与各场景文档。

### 给 Agent 精细授权工具

即使场景把工具暴露给主智能体，**每个 Agent 还可以**在「智能体 → 能力 → 工具」分区再做一道白名单：

- 默认继承场景的工具集
- 高风险工具（`terminal`、`delete`、`write`）可针对单个 Agent 单独取消
- 内置 `project-*` 系列项目角色按职责精细授权（如 `project-software-tester` 不给 `delete`）

---

## 三、什么是 MCP

Model Context Protocol（MCP）是 Anthropic 提出的开放协议，让 AI 应用以**统一方式**接入外部工具与数据源。MCP 服务器暴露标准化的工具接口，EvoFlow 启用后自动注册为 Agent 可用的工具。

EvoFlow 支持三种 MCP 传输类型：

| 类型 | 形态 | 适合场景 |
|------|------|---------|
| **stdio** | 本地子进程（如 `npx`、`python`） | 文件系统、Git、本地数据库等本机能力 |
| **SSE** | 远程 Server-Sent Events 流 | 跨机器订阅式服务 |
| **streamable-http** | 远程 HTTP 流式服务 | 标准 REST 风格的远程 MCP |


---

## 四、基础使用（GUI）

### 页面入口

侧栏 **智能体**（`#/expert`）→ 顶栏 Tab **连接器**（直达 `#/tools` 亦可）进入 MCP 服务器管理，含两个 Tab：「已安装」和「市场」。

### 管理已安装 MCP

「已安装」Tab 列出所有已配置的 MCP 服务器：

- 每张卡片展示：名称、类型（stdio / SSE / streamable-http）、功能描述、运行状态
- **启用开关**：禁用后所有 Agent 都无法访问该 MCP，**优先级高于 Agent 白名单**
- **删除按钮**（仅非系统内置）
- 搜索框按名称 / 描述过滤
- 状态下拉筛选：全部 / 已启用 / 已禁用
- 「**导入配置**」按钮：通过 JSON 批量导入

### 安装新 MCP

#### 方式一：从市场安装

1. 切到「市场」Tab，自动加载 **Glama MCP 目录**（空关键词时同时展示 EvoFlow 精选）
2. 搜索框输入关键词（如 `github`、`filesystem`、`postgres`）
3. 卡片右下角「安装」→ Gateway 从 **官方 MCP Registry** 解析安装配置并写入本地
4. 已安装的可在「已安装」Tab 启用并分配给 Agent

> **市场来源**：搜索来自 [Glama](https://glama.ai/mcp/servers)；一键安装配置优先解析 [官方 MCP Registry](https://registry.modelcontextprotocol.io)。Glama 不可用时回退到 EvoFlow 精选列表。第三方 MCP 请自行评估安全性，**stdio 类会在本机起子进程**。

#### 方式二：手动添加自定义 MCP

1. 「已安装」Tab → 右上角「添加 MCP」
2. 选类型并填配置：
   - **stdio**：`command`（如 `npx`、`python`）+ `args` + `env`（可选）
   - **SSE**：`url`（SSE 服务地址）
   - **streamable-http**：`url` + 可选 `headers`
3. 确认后 MCP 自动启用

#### 方式三：直接编辑 JSON

适合批量管理、CI/CD 场景——见 [六、进阶配置（JSON）](#六进阶配置json)。

### 给 Agent 配置 MCP 权限

安装 ≠ 可用——还要在角色级别勾选：

1. 「智能体」编辑目标 Agent
2. 切到「能力 → MCP 模块」分区
3. 勾选可调用的 MCP（或"全部可用"）
4. 保存生效

未勾选的 MCP **不会出现在该 Agent 的工具列表**——这是 EvoFlow 的最小权限原则。

---

## 五、常用 MCP 速查

| MCP | 类型 | 用途 | 启动命令 |
|-----|------|------|---------|
| **filesystem** | stdio | 受限目录的文件读写 | `npx -y @modelcontextprotocol/server-filesystem /path/to/dir` |
| **github** | stdio | GitHub 仓库 / Issue / PR | `npx -y @modelcontextprotocol/server-github`，需 `GITHUB_TOKEN` |
| **postgres** | stdio | PostgreSQL 查询 | `npx -y @modelcontextprotocol/server-postgres postgresql://...` |
| **brave-search** | stdio | Brave 网页搜索 | `npx -y @modelcontextprotocol/server-brave-search`，需 `BRAVE_API_KEY` |
| **slack** | stdio | Slack 收发消息 | `npx -y @modelcontextprotocol/server-slack`，需 `SLACK_BOT_TOKEN` |
| **puppeteer** | stdio | 浏览器自动化 | `npx -y @modelcontextprotocol/server-puppeteer` |
| **memory** | stdio | 持久化键值存储 | `npx -y @modelcontextprotocol/server-memory` |
| **sequential-thinking** | stdio | 复杂推理辅助 | `npx -y @modelcontextprotocol/server-sequential-thinking` |
| **lark / 飞书** | stdio | 飞书消息、文档、日历 | 见 [飞书集成](../integration/feishu-integration.md) |
| **自建 HTTP MCP** | streamable-http | 公司内部系统接入 | 自定义 URL + OAuth |

> 列表会随 MCP 生态更新；最新清单见 [MCP 官方目录](https://modelcontextprotocol.io/clients) 与「市场」Tab。

### 敏感值用环境变量引用

无论 GUI 或 JSON 配置，**密钥都不要明文写**：

```json
{
  "env": {
    "GITHUB_TOKEN": "$GITHUB_TOKEN",
    "BRAVE_API_KEY": "$BRAVE_API_KEY"
  }
}
```

`$VAR` 语法会在运行时从 EvoFlow 进程环境读取。设置环境变量的方式：

- 「**设置 → 环境变量**」Tab 集中维护（推荐）
- 启动 EvoFlow 前用系统 `export` / `setx`
- `.env` 文件（仅本地开发）


---

## 六、进阶配置（JSON）

适合批量管理、CI/CD 与版本控制场景——把 MCP 配置当代码管。

### 配置文件位置

项目根目录的 `extensions_config.json`：

```json
{
  "mcpServers": {
    "server_name": {
      "enabled": true,
      "type": "stdio|sse|streamable-http"
    }
  },
  "skills": {}
}
```

### stdio 完整示例

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

### SSE / streamable-http

```json
{
  "mcpServers": {
    "remote-sse": {
      "enabled": true,
      "type": "sse",
      "url": "https://example.com/mcp/sse",
      "description": "Remote MCP via SSE"
    },
    "remote-http": {
      "enabled": true,
      "type": "streamable-http",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer $MCP_TOKEN"
      },
      "description": "Remote MCP via HTTP"
    }
  }
}
```

### OAuth 认证（HTTP / SSE）

支持 OAuth 2.0 自动令牌获取与刷新：

```json
{
  "mcpServers": {
    "secure-server": {
      "enabled": true,
      "type": "streamable-http",
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

**机制要点**：

- 支持 `client_credentials` / `refresh_token` 两种授权类型
- 令牌自动缓存，到期前按 `refresh_skew_seconds` 提前刷新
- Authorization 头自动注入到每个 MCP 请求
- 敏感值通过 `$VAR` 引用，避免明文落盘

### 运行时热重载

修改 `extensions_config.json` 后无需重启——LangGraph 通过 mtime 检测变更，几秒内自动加载新配置。也可走 Gateway API：

```bash
# 更新配置
curl -X PUT http://localhost:8001/api/mcp/config \
  -H "Content-Type: application/json" \
  -d @extensions_config.json

# 获取当前配置
curl http://localhost:8001/api/mcp/config
```

---

## 七、调用排查

MCP 配好了，但不确定是否真被 Agent 调用？三步排查：

### 1. 在对话里直接问

让 Agent 列出可用工具：

```
请列出你当前可以调用的所有 MCP 工具。
```

Agent 会返回当前 session 实际加载的工具清单。如果你期望的 MCP 不在列表里：

- 「智能体 → 连接器」检查该 MCP 是否启用
- 「智能体」检查当前角色是否勾选了该 MCP
- 检查所在场景是否暴露了 MCP 模块

### 2. 看「会话调试」

左侧菜单「运维 → 会话调试」`/observability`：

- 按会话 / 任务 / Agent 维度查工具调用轨迹
- 每次 MCP 调用展示入参出参 JSON、耗时、是否报错
- Top N 调用耗时排行可发现拖慢对话的 MCP

### 3. 看 Gateway 日志

```bash
# 看 MCP 注册情况
make docker-logs-gateway | grep -i mcp

# 看 MCP 调用错误
make docker-logs-gateway | grep -i "mcp.*error"
```

stdio MCP 启动失败时，Gateway 启动日志会带具体报错（如 npx 找不到、env 变量未设）。

---

## 八、常见问题

**Q：装了 MCP 但 Agent 没看到对应工具？**
依次检查：
1. 「智能体 → 连接器」该 MCP 是否启用
2. 「智能体」当前角色 MCP 模块是否勾选
3. 当前会话所在场景是否暴露 MCP（部分极简场景会屏蔽）
4. 重启 Gateway 或等待 mtime 热重载

**Q：stdio MCP 启动失败？**
确保 `command` 在 PATH 中可用。`npx` 需 Node.js 已装；`python -m xxx` 需对应模块已 pip 安装。看 Gateway 日志最直接。

**Q：OAuth 令牌刷新失败？**
检查 `token_url`、`client_id`、`client_secret` 是否有效。日志会打印 OAuth 错误码（401 / 403 / invalid_grant 等）。

**Q：修改 `extensions_config.json` 没生效？**
文件须保存到项目根目录，Gateway 通过 mtime 检测，等几秒。或直接 `curl PUT /api/mcp/config` 强制热更。

**Q：怎么限制单个 MCP 的并发？**
当前框架对 MCP 调用并发没有专门节流，但**模型层**的并发由场景与 Agent 配置控制。若某 MCP 容易被高频调用拖慢，建议在该 MCP 服务端自己加速率限制。

**Q：能不能让自己写的 MCP 出现在「市场」？**
当前市场是 EvoFlow 团队整理的精选清单，**不对外开放自助提交**。你可以：
- 用「方式二：手动添加」配进面板
- 把 `extensions_config.json` 加进团队仓库的 git，让队友 clone 后直接生效
- 联系 EvoFlow 团队提交收录建议

**Q：MCP 报警敏感数据会被发到第三方吗？**
本地 stdio MCP **完全在你本机运行**，不会出网（除非该 MCP 自己访问网络）。远程 SSE / HTTP MCP 会按其 URL 出网，配置前请确认服务可信。

**Q：怎么彻底禁用某个 MCP 的某些工具？**
MCP 服务器自己暴露的工具粒度由其实现决定，EvoFlow 当前**不能屏蔽单个 MCP 的子工具**。若有强需求，可用 `mcp-terminal` 技能转发，在脚本里过滤后再喂给 Agent。

---

## 相关阅读

- [MCP 官方文档](https://modelcontextprotocol.io)
- [智能体管理](agent-management.md) — 给角色配权限
- [技能管理](skill-management.md) — Skill 与 MCP 的差异
- [会话调试](../../../system/reference/architecture.md) — 工具调用排查
- [沙箱模式配置](sandbox-config.md)
- [飞书集成](../integration/feishu-integration.md)
