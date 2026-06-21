## 改造清单（ACP 接入 Supervisor，支持多 Provider）

### P0：模型与会话基础层

- backend/packages/harness/evoflow/tools/builtins/invoke_acp_agent_tool.py

- 新增动作化接口语义：start/send/status/read/close/cancel

- 增加会话级上下文参数：provider、supervisor_session_id、task_id、subtask_id

- session_update 内输出标准事件（为后续 SSE 转发准备）

- backend/packages/harness/evoflow/config/acp_config.py

- 补充 provider 能力字段（可选）：supports_resume、supports_close、stream_mode（默认值即可）

- backend/packages/harness/evoflow/config/agents_config.py

- 确认 list_acp_agents() 输出可直接被 supervisor 路由消费（name/code 一致性）

### P0：新增 ACP 会话注册中心

- 新增文件 backend/packages/harness/evoflow/tools/builtins/supervisor/acp_session_registry.py

- 职责：binding_key -> supervisor_session_id -> acp_session_id

- 提供：get_or_create、require_existing、update_status、close、list_by_task

- 先做内存实现，预留持久化接口

- 新增文件 backend/packages/harness/evoflow/tools/builtins/supervisor/acp_models.py

- 定义 AcpSessionRecord、AcpSessionStatus、AcpProviderResult 等统一结构

------

### P1：Supervisor 编排层接入

- backend/packages/harness/evoflow/tools/builtins/supervisor/execution.py

- 新增 ACP 路由入口（按 assigned_to 命中 acp_agents）

- start_execution 子任务委派时走 ACP session start/send

- 与现有 subagent 路由并行存在（可回退）

- backend/packages/harness/evoflow/tools/builtins/supervisor_tool.py

- continue_subtask_session 增加 ACP 分支（不限于 claude-code）

- monitor_execution_step 增加 ACP session 摘要返回

### P1：桥接层

- backend/packages/harness/evoflow/tools/builtins/collab_bridge.py

- 增加 ACP 执行桥接方法，避免 supervisor 直接耦合 ACP 细节

------

### P1：流式事件标准化（后端）

- 新增文件 backend/packages/harness/evoflow/tools/builtins/supervisor/acp_event_bus.py

- 标准事件：acp_status_update / acp_stream_delta / acp_stream_done / acp_stream_error

- 同步输出 legacy task 事件（兼容）

- backend/app/gateway/routers/events.py

- 接收/广播 ACP 标准事件（复用现有 broadcaster）

- backend/packages/harness/evoflow/collab/sse_notify.py

- 跨进程广播补齐 ACP 事件类型

------

### P2：状态查询与观测

- backend/packages/harness/evoflow/tools/builtins/supervisor/monitor.py

- 把 ACP session 状态投影进任务监控结构（task + session 双层）

- backend/app/gateway/routers/collab.py 或 backend/app/gateway/routers/events.py

- 新增查询端点（建议）：按 task_id / session_id 查 ACP 会话状态

- backend/packages/harness/evoflow/collab/storage.py

- 持久化最小会话快照（可选首版只记录摘要）

------

### P2：前端消费（你确认后再做）

- evopanel/src/lib/ws-client.js

- 新增 acp_* 事件消费

- 会话状态与任务状态并行展示

- evopanel/src/react/components/ToolCallList.tsx（可选）

- ACP 会话流/状态可视化

------

## 测试清单（对应你要的验证）

- backend/tests/test_codebuddy_acp_live.py（已存在，继续扩展）

- 增加 start/send/status/close 动作路径验证

- 增加多 provider 参数化（先 codebuddy，后续加其他 ACP provider）

- 新增 backend/tests/test_acp_session_registry.py

- 绑定键、会话复用、状态迁移、关闭回收

- 新增 backend/tests/test_supervisor_acp_routing.py

- assigned_to 命中 ACP provider 的路由正确性

- 新增 backend/tests/test_acp_event_stream_bridge.py

- chunk -> acp_stream_delta -> SSE 广播链路

------

## 你重点核对的 5 个决定

- assigned_to 是否直接等于 acp_agents 的 key（我建议是）

- ACP 会话注册中心首版是否接受“内存态 + 任务摘要持久化”

- continue_subtask_session 是否统一为“Claude/ACP 共用入口”

- 事件名是否采用 acp_*（我建议固定）

- 前端改造是否放到第二批（我建议放第二批）