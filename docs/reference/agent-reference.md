# Agent 类型与配置参考

## 概述

EvoFlow 支持多种 Agent 类型：
- **Lead Agent（主智能体）**：入口点，负责整体任务协调
- **Custom Agents（自定义智能体）**：用户创建的专用智能体
- **Subagents（子智能体）**：由主智能体委派的后台工作 Agent
- **ACP Agents（ACP 外部智能体）**：通过 ACP 协议调用的外部 Agent

## Lead Agent（主智能体）

**入口点**：`make_lead_agent(config: RunnableConfig)` 在 `langgraph.json` 中注册。

**核心机制**：
- 动态模型选择：通过 `create_chat_model()` 支持 thinking/vision
- 工具加载：通过 `get_available_tools()` 组合沙箱、内置、MCP、社区和子 Agent 工具
- 系统提示：通过 `apply_prompt_template()` 注入技能、记忆和子 Agent 指令

**运行时配置**（通过 `config.configurable`）：

| 参数 | 类型 | 说明 |
|------|------|------|
| `thinking_enabled` | bool | 启用模型的扩展思考模式 |
| `model_name` | string | 选择特定 LLM 模型 |
| `is_plan_mode` | bool | 启用 TodoList 中间件 |
| `subagent_enabled` | bool | 启用任务委派工具 |

## Custom Agents（自定义智能体）

自定义智能体存储在 `agents/{agent_code}/` 目录下，每个包含：

| 文件 | 说明 |
|------|------|
| `config.yaml` | 智能体配置 |
| `SOUL.md` | 智能体人格与行为准则 |

**config.yaml 字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `agent_code` | string | 智能体标识符（hyphen-case，小写） |
| `agent_name` | string | 中文显示名 |
| `description` | string | 智能体描述 |
| `model` | string | 模型覆盖 |
| `tool_groups` | list | 工具组白名单 |
| `tools` | list | 内置工具白名单 |
| `mcp_servers` | list | MCP 服务器名称 |
| `skills` | list | 注入系统提示词的技能名列表；**缺省或省略 = 不注入任何技能**（需在配置中显式列举才会出现在 `<skill_system>` 中） |
| `system_prompt` | string | 系统提示词 |

**内置虚拟 Agent**：

| agent_code | 说明 |
|------------|------|
| `main` | 默认主智能体 |
| `claude-code` | Claude Code 客户端代理 |

## Subagents（子智能体）

内置子智能体：

| 类型 | 说明 | 可用工具 |
|------|------|----------|
| `general-purpose` | 通用多步任务 | 除 task 外的所有工具 |
| `bash` | 命令执行专家 | bash 工具 |

**执行机制**：
- 双线程池：`_scheduler_pool`（3 workers）+ `_execution_pool`（3 workers）
- 最大并发：`MAX_CONCURRENT_SUBAGENTS = 3`
- 超时：默认 15 分钟（可按智能体覆盖）
- 事件：`task_started`、`task_running`、`task_completed`/`task_failed`/`task_timed_out`

## ACP Agents

通过 `invoke_acp_agent` 工具调用的外部 Agent：

```yaml
acp_agents:
  claude_code:
    command: npx
    args: ["-y", "@zed-industries/claude-agent-acp"]
    description: Claude Code
  codex:
    command: npx
    args: ["-y", "@zed-industries/codex-acp"]
    description: Codex CLI
```

每个 ACP Agent 使用独立的线程工作空间 `{base_dir}/threads/{thread_id}/acp-workspace/`，通过虚拟路径 `/mnt/acp-workspace/` 访问。

## Agent API

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/agents` | 列出所有智能体 |
| GET | `/api/agents/check?name=xxx` | 检查智能体名称 |
| GET | `/api/agents/{name}` | 获取智能体详情（含 SOUL.md） |
| POST | `/api/agents` | 创建智能体 |
| PUT | `/api/agents/{name}` | 更新智能体 |
| DELETE | `/api/agents/{name}` | 删除智能体 |

## 相关参考

- [agent-system.md](../explanation/agent-system.md) - Agent 系统架构解释
- [api-reference.md](./api-reference.md) - Gateway API 参考
