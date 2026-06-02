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

在 EvoPanel 中：

- 顶栏场景选 **「任务规划」**（推荐，会与 Plan 协作联动）
- 或底部模式菜单开启 **Plan（任务协作）**（`collabOn` + `is_plan_mode`）

计划正文持久化在 **主任务表**（`plan` 工具写入 `plan_goal` / `plan_steps` 等），**不**使用工作区 `plan.md` 文件。

### 界面：计划落库后看什么

1. **plan 工具块**：成功时展示目标与步骤数摘要（非空 body）
2. **输入框上方确认条**：「查看计划」「开始执行」「修改计划」及子任务摘要
3. **协作侧栏**：`plan` 成功落库后即可出现子任务列表（状态多为 `planned`）；点击「开始执行」并授权后才真正派发执行
4. **「查看计划」弹窗**：从 `GET /api/tasks/:id` 读表；工具 output 作 fallback

勿依赖助手气泡里的「计划已就绪，请点击开始执行」——执行确认由确认条承担。

### 子任务何时创建、何时算完成

| 时机 | 行为 |
|------|------|
| **`plan` 成功** | 后端 `sync_subtasks_from_plan_steps` 一次性创建/更新子任务（**无需**再 `create_subtasks`） |
| **侧栏展示** | plan 定稿后即可列出子任务；非「点开始执行才创建」 |
| **开始跑** | 用户授权 + `start_execution`（或网关自动 dispatch）→ 子任务 `executing`，worker 委派 |
| **算完成** | Worker 调用 `subtask_outcome_report` 后后端标 `completed`；侧栏以 API/WS 快照为准，不因委派返回 `ok` 即显示已完成 |

依赖链（`depends_on`）在上游 `completed` 后由后端 **auto follow-up** 启动下一波，通常无需对每个 Step 再调 `start_execution`。

## 执行阶段

Plan 模式下的协作流程包含以下阶段：

| 阶段 | 说明 |
|------|------|
| `planning` | Agent 正在制定计划（先 `list_agents`，再在每步写明执行人） |
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
| `ask_clarification` | 向用户提问 |
| `list_agents` | 列出可用 Agent（写 Plan 前为每步选定执行人） |
| `tool_search` | 工具搜索 |
| `plan` | 提交结构化计划（`goal` + `steps[]`，见工具 schema） |
| `supervisor` | 超级总控智能体调度 |
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

### Smoke：三步链子任务传递（plan → supervisor）

在**已迁移**的 dev 环境（`plan_goal` 等列存在）下：

1. **plan 后**：消息区 plan 摘要 + 底部确认条；侧栏 3 个子任务（`planned`）；`PlanDetailView` 可见步骤与依赖。
2. **开始执行**：仅 Step1 进入 `executing`；勿在委派返回 `ok` 时期望侧栏已 `completed`。
3. **Step1 `subtask_outcome_report` 后**：Step2 应自动 follow-up；`get_status` 的 `blocked` 不应含 `invalid_dep:1`；DB 中 `worker_profile.depends_on` 为 `Subtask_*` id 而非 `"1"`。
4. **刷新页面**：侧栏与确认条应从历史工具 + `task-progress` 快照恢复。

后端回归：`uv run pytest tests/test_plan_subtask_depends_on_chain.py -q`（harness 包目录）。

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
