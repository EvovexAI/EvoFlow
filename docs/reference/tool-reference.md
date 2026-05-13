# 内置工具参考

## 概述

EvoFlow 的工具系统由 `get_available_tools()` 组装，包含以下来源：
1. `config.yaml` 中定义的自定义工具
2. MCP 服务器提供的工具
3. 内置工具
4. 社区工具
5. 子 Agent 工具

## 内置工具

| 工具 | 说明 | 何时加载 |
|------|------|---------|
| `present_files` | 使输出文件对用户可见（仅限 `/mnt/user-data/outputs`） | 始终 |
| `ask_clarification` | 请求用户澄清（被 ClarificationMiddleware 拦截 → 中断对话） | 始终 |
| `view_image` | 读取图片为 base64 | 仅当模型 `supports_vision: true` |
| `task` | 委派给子 Agent | 仅当 `subagent_enabled: true` |
| `write_todos` | 写入待办列表 | 仅当 `is_plan_mode: true` |
| `invoke_acp_agent` | 调用外部 ACP Agent | 仅当配置了 `acp_agents` |

## 沙箱工具

| 工具 | 说明 |
|------|------|
| `bash` | 执行 Shell 命令（带路径翻译和错误处理） |
| `ls` | 目录列表（树形，最多 2 层） |
| `read_file` | 读取文件内容（可选行范围） |
| `write_file` | 写入/追加文件，自动创建目录 |
| `str_replace` | 字符串替换（单次或全部出现） |

## 社区工具

| 工具 | 说明 | 配置 |
|------|------|------|
| `web_search` | Tavily 网络搜索（默认 5 条结果） | `TAVILY_API_KEY` |
| `web_fetch` | Jina Reader 网页抓取（4KB 限制） | `JINA_API_KEY` |
| `firecrawl` | Firecrawl 网页爬取 | `FIRECRAWL_API_KEY` |
| `image_search` | DuckDuckGo 图片搜索 | 无需 |

## MCP 工具

MCP 工具以 `mcp__{server_name}__{tool_name}` 格式动态加载。启用/禁用通过 `extensions_config.json` 控制。

## 工具组装流程

```
get_available_tools()
  ├── config.yaml 中的 tools[] / tool_groups[]
  ├── MCP 工具（从 extensions_config.json，懒加载 + mtime 缓存）
  ├── 内置工具（present_files, ask_clarification, view_image）
  ├── subagent: task（如果启用）
  └── community: web_search, web_fetch, firecrawl, image_search
```

## 相关参考

- [配置参考](config-reference.md)
- [API 参考](api-reference.md)
