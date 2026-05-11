# Agent 系统架构解释

## 背景

EvoFlow 的 Agent 系统是整个平台的核心。理解 Agent 如何被创建、配置和执行，是开发和维护系统的基础。

## 设计理念

EvoFlow 的 Agent 系统设计围绕一个核心思想：**Agent 应该是可组合、可配置、可隔离的**。

- **可组合**：工具、模型、技能、记忆作为独立模块，按需组装
- **可配置**：通过 config.yaml 和运行时参数控制 Agent 行为
- **可隔离**：每个线程（thread）拥有独立的环境，互不干扰

## Agent 创建流程

### 入口点

```python
from evoflow.agents.lead_agent.agent import make_lead_agent
```

`make_lead_agent(config: RunnableConfig)` 是 LangGraph 注册的入口点。整个创建过程：

1. **模型选择**：通过 `create_chat_model()` 从 `config.yaml` 中的 models 列表选取模型
2. **工具组装**：通过 `get_available_tools()` 组合所有可用工具
3. **中间件配置**：按固定顺序构建 13 个中间件
4. **系统提示生成**：通过 `apply_prompt_template()` 注入技能、记忆、子 Agent 指令

### 动态模型选择

`create_chat_model(name, thinking_enabled)` 支持：
- 通过 `config.configurable.model_name` 运行时选择模型
- `thinking_enabled` 标志触发 per-model 的 `when_thinking_enabled` 覆盖
- `supports_vision` 标志决定是否添加 view_image 工具
- 缺失的 provider 模块会给出安装提示（如 `uv add langchain-google-genai`）

### 工具组装

```
get_available_tools()
  ├── 1. config.yaml 中定义的工具（resolve_variable 解析）
  ├── 2. MCP 工具（懒加载，mtime 缓存失效）
  ├── 3. 内置工具（present_files, ask_clarification, view_image）
  └── 4. 子 Agent 工具（task，如果 subagent_enabled）
```

### 系统提示注入

系统提示包含以下部分：
- Agent 角色描述
- 可用工具列表
- 已启用技能的 SKILL.md 内容
- 记忆上下文（前 15 条事实 + 用户上下文）
- 子 Agent 委派说明
- SOUL.md 内容（自定义 Agent 的人格）

## ThreadState 数据模型

ThreadState 扩展了 LangGraph 的 AgentState：

| 字段 | 说明 | Reducer |
|------|------|---------|
| `sandbox` | 沙箱实例 | - |
| `thread_data` | 线程数据（路径映射） | - |
| `title` | 对话标题 | - |
| `artifacts` | 输出的制品文件 | merge_artifacts（去重） |
| `todos` | 待办列表 | - |
| `uploaded_files` | 上传的文件 | - |
| `viewed_images` | 已查看的图片 | merge_viewed_images（合并/清除） |

## 运行时控制

Agent 行为通过 `config.configurable` 运行时参数控制：

| 参数 | 效果 |
|------|------|
| `thinking_enabled: true` | 模型启用扩展思考 |
| `model_name: "gpt-4o"` | 切换到指定模型 |
| `is_plan_mode: true` | 启用 TodoList 中间件 |
| `subagent_enabled: true` | 启用 task 委派工具 |

## 自定义 Agent

自定义 Agent 存储在 `agents/{agent_code}/` 目录：

```
agents/
├── main/                    # 默认主 Agent
│   ├── config.yaml          # 模型、工具、技能配置
│   └── SOUL.md              # Agent 人格
├── data-analyst/            # 自定义数据分析师
│   ├── config.yaml
│   └── SOUL.md
└── claude-code/             # 内置虚拟 Agent
    └── (virtual)
```

创建后，自定义 Agent 通过 LangGraph 的 `assistant_id` 路由：当 assistant_id 不是 `lead_agent` 时，系统加载对应 Agent 的配置并用其工具/模型覆盖默认值。

## 与其他模块的交互

```
                    ┌─────────────┐
                    │   Models    │
                    └──────┬──────┘
                           │
┌──────────┐    ┌──────────▼──────────┐    ┌─────────────┐
│ Skills   │───→│    Lead Agent       │←───│   Memory    │
└──────────┘    └──────────┬──────────┘    └─────────────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
       ┌──────▼──────┐ ┌───▼────┐ ┌────▼─────┐
       │  Sandbox    │ │  MCP   │ │Subagents │
       └─────────────┘ └────────┘ └──────────┘
```

## 延伸阅读

- [middleware-chain.md](./middleware-chain.md) - 中间件执行链
- [subagent-system.md](./subagent-system.md) - 子 Agent 委派机制
- [context-engineering.md](./context-engineering.md) - 上下文工程

---

**最后验证**：2026-05-10；适用范围：默认分支。
