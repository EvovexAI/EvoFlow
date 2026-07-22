# 自动化任务调度

> **本文偏运维参考。日常操作以[自动化操作指南](scheduled-tasks.md)为准。**
>
> **比如你有这样的需求**：自动化任务跑完后，下次还想接着上次的上下文继续（sticky 线程模式）。或者想直接编辑 TOML 文件来管理大量任务。这些在本文讲。

> **读法**：日常在面板怎么点，以 [自动化操作指南](scheduled-tasks.md) 为准。本文偏运维 / TOML / API。  
> **存储**：当前以 Gateway 库表为主（如 `evoflow.db` 中的 automations / runs）；`~/.evoflow/tasks/automations/*.toml` 多为遗留或导入路径。推送字段以 `push_channel` + `push_target_id` 为主，旧 `feishu_chat_id` 可能仍兼容。触发时刻以五字段 **`schedule` cron** 为准。

## 适用场景

需要定期让 Agent 自动执行任务，例如每日晨报、定时数据汇总、周期性报告生成等。

## 前置条件

- EvoFlow 正在运行
- 已配置至少一个模型

## 调度器工作原理

Gateway 内置的 `AutomationScheduler` 运行在 asyncio 事件循环中，按 tick 间隔扫描所有 `.toml` 任务文件，匹配到触发时间后自动执行。

## TOML 任务格式

任务文件位于 `~/.evoflow/tasks/automations/*.toml`。

### 完整字段参考

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `name` | string | 是 | — | 任务名称 |
| `prompt` | string | 是 | — | 发送给 Agent 的 prompt |
| `schedule` | string | 否 | — | cron 表达式（如 `0 8 * * *`） |
| `rrule` | string | 否 | — | RRULE 格式（替代 cron） |
| `status` | string | 否 | `active` | `active` / `paused` / `completed` |
| `workspace` | string | 否 | — | Agent 工作目录路径 |
| `max_duration_minutes` | int | 否 | 60 | 执行时长上限 |
| `langgraph_run` | bool | 否 | `false` | 是否调用 LangGraph Agent |
| `langgraph_thread_mode` | string | 否 | `fresh` | `fresh`（每次新线程）/ `sticky`（复用） |
| `langgraph_thread_id` | string | 否 | — | sticky 模式使用的线程 ID |
| `langgraph_timeout_seconds` | int | 否 | 600 | LangGraph 调用超时 |
| `feishu_push_enabled` | bool | 否 | `false` | 是否推送飞书 |
| `feishu_chat_id` | string | 否 | — | 飞书聊天 ID |
| `memory_enabled` | bool | 否 | `false` | 是否使用记忆 |
| `valid_from` | string | 否 | — | 有效起始时间 |
| `valid_until` | string | 否 | — | 有效截止时间 |
| `once_fired` | bool | 否 | `false` | 一次性任务是否已触发 |

### 示例：每日晨报

```toml
name = "每日晨报"
prompt = "总结今天的科技新闻"
schedule = "0 8 * * *"
workspace = "/path/to/workspace"
feishu_push_enabled = true
feishu_chat_id = "oc_xxxxx"
langgraph_thread_mode = "fresh"
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `EVOFLOW_AUTOMATION_SCHEDULER` | `1` | 设为 `0` 禁用调度器 |
| `EVOFLOW_AUTOMATIONS_DIR` | `~/.evoflow/tasks/automations` | 任务目录 |
| `EVOFLOW_AUTOMATION_TICK_SECONDS` | `30` | 扫描间隔 |
| `EVOFLOW_AUTOMATION_LANGGRAPH_TIMEOUT` | `600` | LangGraph 超时秒数 |
| `EVOFLOW_AUTOMATION_LANGGRAPH_MAX_CONCURRENT` | `2` | 最大并发执行数 |
| `EVOFLOW_AUTOMATION_LANGGRAPH_RECURSION_LIMIT` | `800` | LangGraph 递归限制 |
| `EVOFLOW_AUTOMATION_PLAN_MODE` | `0` | 自动化是否启用 plan 模式 |
| `EVOFLOW_AUTOMATION_CHAT_LINK_TEMPLATE` | — | 飞书卡片链接模板（含 `{thread_id}`） |

## 验证是否生效

```bash
# 查看调度器状态
curl http://localhost:8001/api/automation/scheduler/status

# 查看 Gateway 日志中的调度信息
make docker-logs-gateway | grep automation

# 手动触发任务
curl -X POST http://localhost:8001/api/automation/{id}/run
```

## 常见问题

### 如何手动触发任务？

在 EvoFlow 中点击任务的"立即执行"按钮，或通过 Gateway API `POST /api/automation/{id}/run`。

### 并发执行会怎样？

最多 `EVOFLOW_AUTOMATION_LANGGRAPH_MAX_CONCURRENT` 个任务同时运行，超出任务排队等待。

### sticky 线程模式是什么？

`sticky` 模式复用 `langgraph_thread_id`，适合需要保持对话上下文的任务。首次执行后自动保存 `langgraph_thread_id` 到 TOML 文件。如果保存的线程 ID 失效，自动创建新的。`fresh` 每次创建新线程。

### 一次性的 `once` 任务只执行了一次？

正常行为。`once_fired = true` 后不再触发，`status` 自动设为 `paused`。需手动重置才能重新执行。

### 任务创建后不执行？

确认 `status = "active"`。确认 IM 渠道服务正在运行（调度器依赖 ChannelService）。后端仅评估 `schedule` 字段（5 字段 cron），不评估 `rrule`。

### 调度器如何关闭？

设置环境变量 `EVOFLOW_AUTOMATION_SCHEDULER=0`（或 `false`/`off`/`disabled`），重启 Gateway。

## 执行历史

每次执行记录写入 `~/.evoflow/tasks/automations/{task_id}_history.jsonl`：

```json
{"run_id": "task_id_ab", "started_at": "2025-01-15T09:30:00", "trigger_type": "schedule", "status": "success", "output": "langgraph: ok thread=xxx", "error": "", "duration_seconds": 0, "langgraph_thread_id": "xxx", "langgraph_run": true}
```

## 相关文档

- [创建定时自动化任务](../../tutorials/automation-task.md)
- [IM 消息渠道配置](../integration/im-channels.md) — 飞书推送需要
