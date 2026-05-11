# Plan 模式使用

## 适用场景
在 Agent 执行复杂任务前，先进行规划阶段，让 Agent 列出任务步骤再逐一执行。适用于多步骤任务、代码重构、研究分析等场景。

## 前置条件
- EvoFlow 已运行
- 理解 Plan 模式与 TodoList 的区别

## 什么是 Plan 模式

Plan 模式包含两个独立但相关的机制：

1. **TodoList 中间件**：提供 `write_todos` 工具，Agent 可用它创建和管理待办事项列表
2. **PlanGuard 中间件**：在规划阶段限制 Agent 只能调用只读/澄清类工具，防止在规划完成前执行副作用操作

## 如何启用

Plan 模式通过运行时配置（`RunnableConfig.configurable`）按请求启用，不是全局配置：

```python
from langchain_core.runnables import RunnableConfig

config = RunnableConfig(
    configurable={
        "thread_id": "example-thread",
        "thinking_enabled": True,
        "is_plan_mode": True,  # 启用 Plan 模式
    }
)
```

在 EvoPanel 中，通过界面切换 Plan 模式开关。

## 执行阶段

Plan 模式下的协作流程包含以下阶段：

| 阶段 | 说明 |
|------|------|
| `planning` | Agent 正在制定计划 |
| `plan_ready` | 计划已制定，等待用户确认 |
| `awaiting_exec` | 用户确认，准备执行 |
| `executing` | 执行阶段（不再受 PlanGuard 限制） |

## PlanGuard 只读保护

在 `planning`、`plan_ready`、`awaiting_exec` 阶段，`PlanGuardMiddleware` 会拦截副作用性工具调用，仅保留以下工具：

| 工具 | 用途 |
|------|------|
| `read_file` | 读取文件 |
| `list_dir` | 列出目录 |
| `search_content` | 内容搜索 |
| `present_files` | 展示文件 |
| `ask_clarification` | 向用户提问 |
| `list_agents` | 列出可用 Agent |
| `tool_search` | 工具搜索 |
| `plan` | 提交结构化计划 |
| `supervisor` | 主管调度 |
| `scenario` | 场景切换 |
| `task` | 委派子任务 |

被拦截的工具调用会被剥离，Agent 收到空响应并调整行为。

## TodoList 工具

启用 Plan 模式后，Agent 自动获得 `write_todos` 工具：

### 何时使用
- 复杂的多步骤任务（3+ 个步骤）
- 用户明确要求使用待办列表
- 非平凡的、需要规划的任务

### 何时不使用
- 简单单步任务
- 纯对话或信息查询

### 任务状态

| 状态 | 说明 |
|------|------|
| `pending` | 待执行 |
| `in_progress` | 执行中（可并行多个） |
| `completed` | 已完成 |

## 通过 API 启用

### LangGraph 流式运行

```bash
curl -X POST http://localhost:2024/api/langgraph/threads/{thread_id}/runs/stream \
  -H "Content-Type: application/json" \
  -d '{
    "assistant_id": "lead_agent",
    "input": {"messages": [{"type": "human", "content": "分析这个项目的架构"}]},
    "context": {
      "thinking_enabled": true,
      "is_plan_mode": true
    }
  }'
```

### API 模式对照

通过 context 参数控制：

| 模式 | thinking_enabled | is_plan_mode | subagent_enabled |
|------|-------------------|--------------|-------------------|
| Flash | false | false | false |
| Standard | true | false | false |
| Pro | true | true | false |
| Ultra | true | true | true |

## 何时使用

| 场景 | 推荐模式 |
|------|----------|
| 快速问答 | Flash（关闭 Plan） |
| 信息检索 | Standard（关闭 Plan） |
| 研究分析 | Pro（启用 Plan + 思考） |
| 复杂多步骤任务 | Ultra（启用 Plan + 思考 + 子代理） |

## 验证是否生效

1. 在 Plan 模式下发送一个多步骤任务（如 "帮我分析这个代码库并写一份架构报告"）
2. 观察 Agent 是否先调用 `write_todos` 创建任务列表
3. 检查 Agent 是否在执行前完成了规划阶段
4. 在 `planning` 阶段尝试让 Agent 执行写操作，应被 PlanGuard 拦截

## 常见问题

**Q: Plan 模式会影响简单任务的速度吗？**
不会强制 Agent 使用 TodoList。对于简单任务，Agent 会自行判断不需要列表，直接执行。

**Q: 可以跳过规划阶段直接执行吗？**
设置 `is_plan_mode: false` 即可。或在规划完成后通过阶段转换进入执行。

**Q: PlanGuard 拦截了所有写操作吗？**
不是。它只拦截副作用性工具（如 `bash`、`write_file`），保留只读和规划类工具。

**Q: 子代理（subagent）在 Plan 模式下能用吗？**
可以。`task` 工具在规划阶段是允许的，主会话只负责调度，实际工作委派给子代理执行。

## 相关文档
- [记忆管理](./memory-management.md)

---

**最后验证**：2026-05-10；适用范围：默认分支。
