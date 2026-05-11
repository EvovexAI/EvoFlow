# 中间件执行链

## 背景

在 LangGraph Agent 的每次执行周期中，需要对输入、输出、状态进行各种处理。如果把这些逻辑混入 Agent 的核心逻辑，会导致代码难以维护和测试。中间件模式将这些横切关注点（cross-cutting concerns）分离为独立的组件，按严格顺序执行。

## 设计理念

EvoFlow 的中间件设计遵循以下原则：

1. **严格顺序**：中间件的执行顺序是固定的，每个中间件依赖前一个中间件的输出
2. **条件启用**：部分中间件仅在特定配置下启用（如 plan_mode、subagent_enabled）
3. **生命周期钩子**：中间件可在 `before_model`（模型调用前）和 `after_model`（模型调用后）两个阶段介入

## 中间件执行链

以下是 13 个中间件的执行顺序，每个中间件的阶段（before/after）和条件：

| 序号 | 中间件 | 阶段 | 条件 | 职责 |
|------|--------|------|------|------|
| 1 | **ThreadDataMiddleware** | before | 始终 | 创建每线程目录（workspace/uploads/outputs），注入路径映射 |
| 2 | **UploadsMiddleware** | before | 始终 | 追踪新上传的文件并注入到对话 |
| 3 | **SandboxMiddleware** | before | 始终 | 获取沙箱实例，将 sandbox_id 存入状态 |
| 4 | **DanglingToolCallMiddleware** | after | 始终 | 为缺少响应的 tool_calls 注入占位 ToolMessage（如用户中断场景） |
| 5 | **GuardrailMiddleware** | after | `guardrails.enabled` | 工具调用授权，拒绝时返回错误 ToolMessage |
| 6 | **SummarizationMiddleware** | before | `summarization.enabled` | 接近 token 上限时压缩上下文 |
| 7 | **TodoListMiddleware** | before | `is_plan_mode` | 添加 write_todos 工具，支持任务跟踪 |
| 8 | **TitleMiddleware** | after | `title.enabled` | 首次完整交互后生成对话标题 |
| 9 | **MemoryMiddleware** | after | `memory.enabled` | 过滤对话并推入异步记忆更新队列 |
| 10 | **ViewImageMiddleware** | before | `supports_vision` | 将图片转 base64 注入模型输入 |
| 11 | **SubagentLimitMiddleware** | after | `subagent_enabled` | 截断超限的 task 调用（MAX_CONCURRENT_SUBAGENTS = 3） |
| 12 | **PlanGuardMiddleware** | after | 特定 collab_phase | 在规划阶段过滤有副作用的工具调用 |
| 13 | **ClarificationMiddleware** | after | 始终 | 拦截 ask_clarification 调用，通过 `Command(goto=END)` 中断 |

## 为什么顺序很重要？

中间件的顺序是经过精心设计的：

- **ThreadData 第一**：其他中间件依赖线程目录已创建
- **Sandbox 早于工具调用**：Guardrail 需要沙箱上下文来做授权决策
- **Summarization 在工具调用前**：先压缩上下文，再执行工具逻辑，减少不必要的处理
- **Memory 在 Title 后**：标题生成是优先操作，记忆更新可以异步进行
- **Clarification 最后**：确保其他中间件有机会处理 ask_clarification 之前的事件

## 中间件生命周期

每个中间件实现以下接口之一或两个：

```python
def before_model(self, state: ThreadState, config: RunnableConfig) -> ThreadState:
    """模型调用前的处理"""
    return state

def after_model(self, state: ThreadState, config: RunnableConfig) -> ThreadState:
    """模型调用后的处理"""
    return state
```

## 条件中间件详解

### GuardrailMiddleware

当 `guardrails.enabled` 为 true 时，每个工具调用经过 provider 评估：
- `AllowlistProvider`（内置，零依赖）：通过 `denied_tools` 列表拒绝特定工具
- OAP provider（如 `aport-agent-guardrails`）：基于 Open Agent Passport 规范
- 自定义 provider：任何实现 `evaluate`/`aevaluate` 方法的类

### SummarizationMiddleware

触发条件可配置：
- `type: tokens`：token 数达到阈值
- `type: messages`：消息数达到阈值
- `type: fraction`：占模型最大输入的百分比

### SubagentLimitMiddleware

检查模型响应中的 `task` 工具调用数量。如果超过 `MAX_CONCURRENT_SUBAGENTS`，截断多余的调用并注入错误 ToolMessage，告知 Agent 并发限制已到达。

### ClarificationMiddleware

当检测到 `ask_clarification` 工具调用时，通过 `Command(goto=END)` 中断执行流，将控制权交还给用户。这是链中最后一个中间件，确保之前的所有处理都已完成。

## 自定义中间件

可以通过修改 `lead_agent/agent.py` 中的中间件列表来添加自定义中间件。自定义中间件需要：

1. 实现 `before_model` 和/或 `after_model` 方法
2. 接收 `ThreadState` 和 `RunnableConfig`，返回修改后的 `ThreadState`
3. 插入到正确的位置（考虑与其他中间件的依赖关系）

## 延伸阅读

- [agent-system.md](./agent-system.md) - Agent 系统架构
- [context-engineering.md](./context-engineering.md) - 上下文工程（与 SummarizationMiddleware 相关）

---

**最后验证**：2026-05-10；适用范围：默认分支。
