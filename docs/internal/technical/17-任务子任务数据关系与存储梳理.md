# 任务/子任务数据关系与存储梳理

本文梳理 EvoFlow 当前「主任务 + 子任务 + 子任务实时流 + 子任务产出数据」的数据模型、写入/读取链路、落盘目录格式，以及各层之间的关系。

## 1. 范围与结论

- 面向对象：`main task`、`subtask`、`subtask runtime stream`、`task memory`。
- 对外语义：以 `task/subtask` 为中心（API 响应不强调 project 概念）。
- 当前唯一展示真值策略：
  - 状态：以 `evoflow_collab_tasks` / `evoflow_collab_subtasks` 为准（经 `ProjectStorage` 加载为内存 bundle）。
  - 内容摘要：以 `evoflow_task_details`（task memory）为准（默认写入关闭时以 subtask 行为主）。
  - 可观测指标（模型调用、token、工具次数）：以 `evoflow_observability.db` 的 `evoflow_obs_*` 表为准，按 `thread_id` 聚合。
  - 读取接口（如 `/api/task-memory/tasks/{subtaskId}`）会互补并回填落盘。

## 2. 存储位置（Host 侧）

根目录：`{base_dir}`（见 `Paths.base_dir`，默认 `$HOME/.evoflow`）

- **主应用库**（任务、子任务、会话、配置）
  - 文件：`{base_dir}/data/app/evoflow.db`
  - 任务相关表：`evoflow_collab_tasks`、`evoflow_collab_subtasks`、`evoflow_collab_task_execution_history` 等
  - 任务记忆表：`evoflow_task_details`、`evoflow_task_detail_facts`
  - 线程协作表：`evoflow_thread_collab`（及关联子表）
  - 聊天会话表：`evoflow_chat_sessions`、`evoflow_chat_messages`（含 per-message token / model_name）
- **观测库**（模型/工具调用、trace、生命周期事件）
  - 文件：`{base_dir}/data/observability/evoflow_observability.db`
  - 表：`evoflow_obs_model_invocations`、`evoflow_obs_tool_invocations`、`evoflow_obs_task_lifecycle_events` 等
- **线程工作区**（沙箱挂载，非任务状态真值）
  - 目录：`{base_dir}/threads/{thread_id}/user-data/`
- **任务流快照日志**（调试/回放引导，可选）
  - 目录：`{base_dir}/task_stream_logs/`
  - 文件：`{main_task_id}.jsonl`

> 说明：`main_task_id` 即 bundle 存储键（与对外 `task_id` 一致）。历史 `projects/project_*.json` 已迁移至 SQLite，不再作为运行时数据源。

## 3. 四类核心数据

### 3.1 主任务/子任务行（SQLite collab 表）

存储在 `evoflow.db`：

- 主任务：`evoflow_collab_tasks`（`main_task_id` = bundle id）
- 子任务：`evoflow_collab_subtasks`
- 运行时经 `ProjectStorage.load_project()` 组装为 `{ id, tasks[], ... }` bundle 供 API 使用
- 典型字段：
  - `id/name/status/progress/thread_id`
  - 子任务补充：`assigned_to/result_json/error_text/extra_json`（含 `subtask_thread_id`、`auto_retry_count` 等）

用途：

- 任务状态主真值（尤其是终态：`completed/failed/cancelled/timed_out`）
- `/api/tasks/{task_id}/subtasks` 直接读取这一层
- **仅用于关联观测数据**：`thread_id` → `evoflow_obs_*` 聚合（不在 UI 展示队列重试等运维字段）

### 3.2 任务记忆（task_details）

表：`evoflow_task_details` / `evoflow_task_detail_facts`（同在 `evoflow.db`）

- 典型字段：`status/progress/current_step/output_summary/facts`
- 主任务可做聚合（由子任务 memory 汇总）
- 默认 `task_memory_persistence_enabled()` 为 off 时，以 subtask 行为 UI 真值

用途：

- 子任务详情弹窗、总结摘要、facts 语义层数据
- `/api/task-memory/tasks/{id}` 读取这一层（并做互补）

### 3.3 线程协作态（thread_collab）

表：`evoflow_thread_collab`（及 `evoflow_thread_collab_scenarios`、`evoflow_thread_collab_sidebar_steps`）

- 典型字段：`collab_phase/bound_task_id/sidebar_supervisor_steps`
- 仅表示线程执行阶段与绑定关系，不承载子任务终态真值

用途：

- 前端是否需要挂 task-stream
- 侧栏时间线恢复

### 3.4 可观测指标（observability）

库：`evoflow_observability.db`

- 模型调用：`evoflow_obs_model_invocations`（`thread_id`, `model`, `usage_json`, `latency_ms`）
- 工具调用：`evoflow_obs_tool_invocations`
- 任务生命周期：`evoflow_obs_task_lifecycle_events`（`main_task_id`, `subtask_id`, `event`）
- API：`GET /api/observability/models?thread_id=`、`GET /api/observability/threads/{id}/insights`
- 任务级展示：按主任务 `thread_id` + 子任务 `subtask_thread_id` 列表聚合（计划中的 `GET /api/tasks/{id}/observability`）

### 3.5 实时流与快照日志

- 实时：
  - `task_tool` / `claude_session` 产生 `task_started/task_running/task_completed/...`
  - 经 `broadcast_collab_task_event(...)` 推到网关 SSE
- 快照：
  - `/api/collab/threads/{thread_id}/task-stream` 周期输出 `task_progress`（含 `snapshot + memory`）
  - 同步写 `task_stream_logs/{main_task_id}.jsonl` 供回放引导

## 4. 写入链路（统一后）

已统一子任务写模型：`persist_subtask_runtime_snapshot(...)`

- 写入目标：
  - `evoflow_collab_subtasks`（状态/进度/result/error，经 bundle 写回）
  - `evoflow_task_details`（status/progress/output_summary/current_step，启用时）
- 调用方：
  - `task_tool`（运行中增量 + 终态）
  - `supervisor -> claude_session` 路径（失败/完成）

额外终态语义：

- 子任务终态后会触发根任务进度 rollup（`rollup_root_task_progress_from_subtasks`）
- 主任务聚合 memory 会在 supervisor 收敛路径更新

## 5. 读取链路（对外）

### 5.1 子任务列表

- API：`GET /api/tasks/{task_id}/subtasks`
- 数据源：`evoflow_collab_subtasks`（状态主真值）

### 5.2 子任务记忆

- API：`GET /api/task-memory/tasks/{subtask_id}`
- 主数据源：`evoflow_task_details`
- 互补逻辑：
  - 若 memory 空/滞后，回填 subtask 行的 `status/progress/result/error`
  - 回填后立刻 `save_task_memory`（写回落盘，避免每次临时修补）

### 5.3 线程任务流

- API：`GET /api/collab/threads/{thread_id}/task-stream`（SSE）
- 数据源：
  - `build_task_progress_snapshot(...)`（collab 表 + task_details 聚合）
  - 网关事件广播（`task:running` 等实时事件）

## 6. 关系图（示意）

```mermaid
flowchart TD
  A[task_tool / claude_session] --> B[persist_subtask_runtime_snapshot]
  B --> C[evoflow.db<br/>evoflow_collab_subtasks]
  B --> D[evoflow.db<br/>evoflow_task_details]

  C --> E[/api/tasks/{task}/subtasks]
  D --> F[/api/task-memory/tasks/{subtask}]
  C --> G[build_task_progress_snapshot]
  D --> G
  G --> H[/api/collab/threads/{thread}/task-stream]
  H --> I[ChatApp + SessionSidebar]

  J[broadcast_collab_task_event] --> K[/api/events/internal/broadcast]
  K --> H

  L[evoflow_thread_collab] --> H
  L --> I

  M[evoflow_observability.db] --> N[/api/observability/*]
  C -->|thread_id| M
```

## 7. 一致性策略与巡检

- 轻量巡检函数：`reconcile_subtask_memory_consistency(...)`
  - 比对 `subtask.status/progress/output_summary` 与 `task_memory` 差异
  - 发现漂移时通过统一入口修复
- 触发点：
  - 当前在 `build_task_progress_snapshot(...)` 中做 best-effort 修复

## 8. 目前仍需注意的边界

- 物理存储键为 `main_task_id`（与对外 `task_id` 一致），属于内部实现细节（对外已 task 语义化）。
- 若历史路径仍直接改 bundle 缓存或直接改 task_details，可能短时漂移；巡检会在快照路径收敛。
- `collab_phase` 是线程执行态，不应作为子任务终态判断依据。

## 9. 代码定位（便于继续演进）

- 路径与库文件：`backend/packages/harness/evoflow/config/paths.py`
- 主存储与统一写入：`backend/packages/harness/evoflow/collab/storage.py`
- SQLite 任务仓储：`backend/packages/harness/evoflow/persistence/task_repositories.py`
- 观测查询：`backend/packages/harness/evoflow/observability/queries.py`
- 线程快照聚合：`backend/packages/harness/evoflow/collab/task_progress_snapshot.py`
- 线程协作态：`backend/packages/harness/evoflow/collab/thread_collab.py`
- task-memory API：`backend/app/gateway/routers/task_memory.py`
- task-stream SSE：`backend/app/gateway/routers/collab.py`
- 子任务执行入口：
  - `backend/packages/harness/evoflow/tools/builtins/task_tool.py`
  - `backend/packages/harness/evoflow/tools/builtins/supervisor/execution.py`
