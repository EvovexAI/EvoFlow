# 子 Agent 委派机制

> **比如你让 AI"调研 3 家 AI Agent 平台，出对比报告"**：
>
> AI 不会自己一个一个查。它会同时派 3 个子 AI：
> - 子 AI 1 查 LangGraph 的资料
> - 子 AI 2 查 CrewAI 的资料
> - 子 AI 3 查 AutoGen 的资料
>
> 3 个一起查，查完汇总给你。这就是子 AI 委派——把复杂任务拆成多路并行，效率更高。
>
> 每轮最多 3 个子 AI 同时跑，默认超时 15 分钟。读完本文你会了解子 AI 的调度机制、并发限制和超时配置。
>
> **功能关系**：子 Agent 是 [Agent 系统](agent-system.md) 的扩展能力——Lead Agent 通过 `task` 工具委派子任务，子 Agent 共享主 Agent 的线程上下文但拥有独立的执行环境。与 [外部 ACP Agent](agent-system.md) 不同，子 Agent 运行在内置 LangGraph 线程中，通过 SSE 事件实时反馈进度。并发控制机制（`SubagentLimitMiddleware`）是 Lead Agent 中间件链的一部分。

## 背景

当 Lead Agent 面对复杂的多步骤任务时，串行执行效率低下。子 Agent 系统允许 Lead Agent 将独立任务委派给后台工作的专用 Agent，实现并行处理。

## 设计理念

子 Agent 系统的核心设计围绕三个原则：**并发可控、执行独立、状态可追踪**。

1. **并发可控**：限制同时运行的子 Agent 数量，防止资源耗尽
2. **执行独立**：每个子 Agent 有独立的线程和上下文
3. **状态可追踪**：通过 SSE 事件实时反馈执行进度

## 架构

### 双线程池

子 Agent 执行引擎使用两个独立的线程池：

| 线程池 | Worker 数 | 职责 |
|--------|-----------|------|
| `_scheduler_pool` | 3 | 调度：接受任务、分配子 Agent、管理队列 |
| `_execution_pool` | 3 | 执行：实际运行子 Agent 的 LangGraph 对话 |

双池设计将调度和执行分离，避免调度逻辑阻塞执行，也避免执行压力影响调度决策。

### 内置子 Agent

| 类型 | 说明 | 可用工具 |
|------|------|----------|
| `general-purpose` | 通用型，处理多步骤复杂任务 | 除 task 外的所有工具（防止递归委派） |
| `bash` | 命令执行专家 | 仅 bash 工具 |

子 Agent 的注册表在 `SubagentRegistry` 中管理，支持动态扩展。

## 执行流程

```
Lead Agent 调用 task() 工具
        ↓
SubagentLimitMiddleware 检查并发限制
  ├── 未超限 → 放行
  └── 超限   → 截断多余的 task 调用
        ↓
SubagentExecutor 接收任务
        ↓
调度池分配调度 worker
        ↓
执行池分配执行 worker
        ↓
创建独立线程，启动 LangGraph 对话
        ↓
SSE 事件广播：task_started → task_running → task_completed/failed/timed_out
        ↓
结果返回给 Lead Agent
```

## 并发控制

### SubagentLimitMiddleware

在 Lead Agent 的模型响应后（`after_model` 阶段），检查 `task` 工具调用数量：

- 如果 `task` 调用数 <= `MAX_CONCURRENT_SUBAGENTS`（3），全部放行
- 如果超过，只保留前 3 个，截断其余的并注入错误 ToolMessage

这确保模型即使一次性生成多个 task 调用，也不会超过并发限制。

### 超时机制

- 全局默认超时：900 秒（15 分钟）
- 可按子 Agent 覆盖（`subagents.agents.<name>.timeout_seconds`）
- 超时后发送 `task_timed_out` 事件

## SSE 事件

子 Agent 执行过程通过 SSE 推送三类事件：

| 事件 | 说明 | 数据 |
|------|------|------|
| `task_started` | 任务开始执行 | task_id, subagent_type |
| `task_running` | 任务执行中 | task_id, 中间状态 |
| `task_completed` | 任务成功完成 | task_id, 结果 |
| `task_failed` | 任务失败 | task_id, 错误信息 |
| `task_timed_out` | 任务超时 | task_id |

## 为什么选择 3 作为默认并发数？

- 太少：无法充分利用并行能力，复杂任务仍需串行等待
- 太多：资源竞争加剧，每个子 Agent 获取的上下文可能受限
- 3 是经验值：在大多数场景下，3 个并行子 Agent 足以覆盖"研究 + 编码 + 验证"的典型分工

## 与外部 Agent（ACP）的区别

| 特性 | 子 Agent | ACP Agent |
|------|----------|-----------|
| 运行方式 | 内置 LangGraph 线程 | 外部进程（npx 等） |
| 上下文 | 共享主 Agent 的线程上下文 | 独立工作空间（只读） |
| 通信 | 通过 SSE 事件 | 通过 ACP 协议（stdin/stdout） |
| 工具集 | 固定（general-purpose / bash） | 由外部 Agent 决定 |

## 配置

```yaml
subagents:
  timeout_seconds: 900
  agents:
    general-purpose:
      timeout_seconds: 1800  # 复杂任务可延长到 30 分钟
    bash:
      timeout_seconds: 300   # 命令执行通常较快
```

## 延伸阅读

- [Agent 系统架构](agent-system.md) — Agent 主循环与中间件
- [技能系统](skill-system.md) — 技能加载与注入
