### EvoFlow 会话历史存储逻辑分析

## 总结

EvoFlow 当前“会话历史”不是单一存储，而是 **三层并存**：

- **主聊天历史存储**：`evoflow_chat_sessions` + `evoflow_chat_messages`
- **执行态/恢复态回退来源**：LangGraph thread checkpoint
- **会话关联状态历史**：`evoflow_session_workspace_history` / `evoflow_workspace_global_history`

其中真正作为 **UI 聊天记录主数据源** 的，是 `evoflow_chat_messages`；`LangGraph checkpoint` 主要用于线程状态恢复、IM/协作场景下的 fallback，以及必要时把 checkpoint 里的消息 **回填** 到 transcript 表。

---

## 1. 表定义与职责

### 1.1 `evoflow_chat_sessions`

位置：`backend/packages/harness/evoflow/persistence/schema.py`

职责：
- 保存侧边栏会话索引
- 建立 `session_key ↔ thread_id` 绑定
- 保存标题、时间、消息计数、上下文、模型/工作区等会话级元数据
- 保存运行态字段：`run_status`、`current_run_id`、token usage 等
- 软删除、pin、预热状态等 UI 管理信息

最早 DDL：
- `_DDL_V7_CHAT_SESSIONS`

后续扩展：
- `_DDL_V10_CHAT_SESSIONS_FLAT`
- `_DDL_V12_SESSION_STATUS`
- 以及更高版本 schema migration

### 1.2 `evoflow_chat_messages`

位置：`backend/packages/harness/evoflow/persistence/schema.py`

职责：
- 保存每条聊天消息 transcript
- 支持 user / assistant / tool 三类消息
- 记录 `seq`、`run_id`、`thread_id`、`parent_thread_id`
- 扁平化保存文本、tool 调用、模型名、token usage、reasoning、display segment
- 供 EvoPanel/UI 直接读取展示

最早 DDL：
- `_DDL_V8_CHAT_MESSAGES`

扁平字段扩展：
- `_DDL_V9_CHAT_MESSAGES_FLAT`

### 1.3 工作区历史表

位置：`backend/packages/harness/evoflow/persistence/schema.py`

表：
- `evoflow_workspaces`
- `evoflow_session_workspace_history`
- `evoflow_workspace_global_history`

职责：
- 存储会话绑定过的 workspace 路径历史
- 存储全局 workspace 使用历史
- 这不是消息历史本身，但属于“会话历史关联数据”

---

## 2. 数据库初始化与配置

### 2.1 主 SQLite 连接

位置：`backend/packages/harness/evoflow/persistence/db.py`

核心函数：
- `resolve_evolflow_db_path()`
- `_open_shared_connection()`
- `get_db()`
- `run_db_transaction()`
- `run_db_with_retry()`

逻辑：
- 使用单进程共享 SQLite 连接
- `check_same_thread=False`
- 所有写操作走进程内锁 + retry
- 启动时执行 `ensure_app_schema(conn)` 自动建表/迁移

SQLite PRAGMA：
- `busy_timeout=60000`
- `journal_mode=WAL`
- `foreign_keys=ON`
- `synchronous=NORMAL`
- `temp_store=MEMORY`
- `cache_size=-64000`

### 2.2 DB 路径来源

位置：`backend/packages/harness/evoflow/persistence/db.py`

逻辑：
- 若配置 `storage.sqlite_path`，则用该路径
- 否则默认落到 `evoflow.db`

---

## 3. 仓储层与服务层分工

### 3.1 会话索引仓储

位置：`backend/packages/harness/evoflow/persistence/session_repositories.py`

职责：
- 管理 `evoflow_chat_sessions`
- 提供 session upsert / list / title / pin / 删除标记 / thread 绑定等能力

关键函数：
- `upsert_session_row(...)`
- `list_sessions_for_ui(...)`
- `find_session_key_by_thread_id(...)`
- `repair_session_thread_binding(...)`
- `mark_session_deleted(...)`
- `delete_sessions_by_thread_id(...)`
- `set_session_activated_scenarios(...)`

### 3.2 聊天消息仓储

位置：`backend/packages/harness/evoflow/persistence/chat_message_repositories.py`

职责：
- 管理 `evoflow_chat_messages`
- 负责 transcript 扁平化、写入、批量写入、读取展示、checkpoint 回填、run_id 回补

关键函数：
- `append_message(...)`
- `append_messages_batch(...)`
- `list_messages(...)`
- `list_messages_for_display(...)`
- `list_messages_for_display_with_im_fallback(...)`
- `list_messages_for_model_input(...)`
- `list_messages_for_thread_id(...)`
- `sync_checkpoint_messages_to_session(...)`
- `delete_messages_for_session(...)`
- `update_last_assistant_display_meta(...)`
- `backfill_missing_run_ids_in_session(...)`
- `conversation_archive_from_thread_id(...)`

### 3.3 会话生命周期服务

位置：`backend/packages/harness/evoflow/persistence/chat_session_service.py`

职责：
- 把 session 表、message 表、LangGraph thread、local thread data 串起来
- 统一处理创建 / ensure-thread / reset / delete / append 后 touch session

关键函数：
- `create_new_session(...)`
- `ensure_session_thread(...)`
- `bind_session_thread(...)`
- `append_message_and_touch_session(...)`
- `append_messages_batch_and_touch_session(...)`
- `reset_session_full(...)`
- `delete_session_full(...)`

---

## 4. 主消息写入逻辑

### 4.1 单条追加：`append_message(...)`

位置：`chat_message_repositories.py`

主要步骤：
1. `normalize_transcript_fields(...)` 把 API / checkpoint / raw message 扁平化成 DB 字段
2. 校验 `session_key` 和 `role`
3. 过滤“注入型用户上下文消息”
   - `_is_injected_user_transcript(...)`
   - 避免把 context compaction/tool-history 这类伪用户消息落库
4. 按 `message_id` 去重
   - `message_id_exists(...)`
5. 按内容和 tool_call_id 去重
   - `transcript_duplicate_exists(...)`
6. 解析/推导 `run_id`
   - `_resolve_run_id_for_append(...)`
7. 分配 `seq`
   - `_next_seq(...)`
8. 解析 `parent_thread_id`
   - `resolve_parent_thread_id(...)`
   - executor thread 会自动反推 lead thread
9. 插入 `evoflow_chat_messages`
10. 对同一轮缺失 `run_id` 的尾部消息做回补
   - `_backfill_run_id_on_turn_tail(...)`

### 4.2 批量追加：`append_messages_batch(...)`

位置：`chat_message_repositories.py`

逻辑：
- 循环调用 `append_message(...)`
- 支持显式 `seq`
- 支持 `skip_if_seq_exists`
- 适用于前端 batch 落盘、checkpoint 回填

### 4.3 服务层追加：`append_message_and_touch_session(...)`

位置：`chat_session_service.py`

逻辑：
- 先调用 `msg_repo.append_message(...)`
- 然后更新 session 的：
  - `updated_at`
  - `message_count`
  - 运行态 token 汇总
- 若带 `thread_id`，尝试调用 `mirror_lead_chat_message_to_task(...)`
  - 但该函数当前是 no-op
  - 说明 **lead transcript 的唯一权威源就是 `evoflow_chat_messages`**

---

## 5. 主读取逻辑

### 5.1 UI 正常读取

入口：`GET /chat-sessions/{session_key}/messages`

位置：`backend/app/gateway/routers/chat_sessions.py`

默认流程：
- `msg_repo.list_messages_for_display_with_im_fallback(...)`

正常情况下：
- 读取 `evoflow_chat_messages`
- source 返回 `evoflow_chat_messages`

### 5.2 `list_messages_for_display(...)`

位置：`chat_message_repositories.py`

逻辑：
- 先通过 `_list_lead_chat_rows(...)` 过滤主会话消息
- 排除：
  - subtask executor thread 消息
  - legacy mirror 行
  - `parent_thread_id` 存在的子任务镜像行
- 如果有行缺失 `run_id`，先执行 `backfill_missing_run_ids_in_session(...)`
- 再转成 EvoPanel 展示格式

这意味着：
- **UI 主聊天窗口默认只看 lead transcript**
- 子任务会话虽然也在同一张表，但不会混进主对话视图

### 5.3 模型输入读取

入口：`GET /chat-sessions/{session_key}/messages?for_model=true`

逻辑：
- 调用 `msg_repo.list_messages_for_model_input(...)`
- 用于构造 LangGraph 输入消息
- 只取有限上下文（代码里 `_MODEL_CONTEXT_LIMIT = 40`）

### 5.4 按 thread_id 读取

入口：`GET /chat-sessions/by-thread/{thread_id}/messages`

逻辑：
- 先尝试 `find_session_key_by_thread_id(...)`
- 如果能映射到 session，则优先返回 `evoflow_chat_messages`
- 如果没有 transcript，则回退到 `conversation_archive_from_thread_id(...)`
- source 可能是：
  - `evoflow_chat_messages`
  - `langgraph_checkpoint`

---

## 6. LangGraph checkpoint 的角色

### 6.1 它不是 UI 主 transcript，但会作为 fallback

核心证据：
- `chat_message_repositories.py` 中多处逻辑都优先 app transcript
- `conversation_persist.py` 明确写着：
  - `Lead transcript is authoritative in evoflow_chat_messages`
  - `chat DB is the single transcript source`

### 6.2 checkpoint fallback 入口

核心函数：
- `conversation_archive_from_thread_id(...)`
- `_archive_from_checkpoint_messages(...)`
- `list_messages_for_display_with_im_fallback(...)`

逻辑：
1. 先从 app transcript 读
2. 如果为空：
   - 协作会话 / IM 会话场景下允许 fallback
3. 通过请求 `LangGraph /threads/{tid}/state` 读取 `values.messages`
4. 转成 archive/display 格式返回

### 6.3 checkpoint → transcript 回填

核心函数：
- `sync_checkpoint_messages_to_session(...)`

逻辑：
1. 把 checkpoint message 转成 append item
   - `_checkpoint_message_to_append_item(...)`
2. 可选跳过 user 消息
3. 可选按 checkpoint 顺序映射固定 `seq`
4. 推导 `run_id`
   - 优先显式 run_id
   - 否则 `peek_current_run_id(...)`
   - 再否则 `latest_user_run_id(...)`
5. 调用 `chat_svc.append_messages_batch_and_touch_session(...)`
6. 再对 turn tail 做 `run_id` 回补

这套逻辑保证：
- 即使实时 transcript 没写全，也能在 run 结束后从 checkpoint 把消息补回 `evoflow_chat_messages`

---

## 7. 所有主要“写会话历史表”的入口

### 7.1 API 手动追加消息

位置：`backend/app/gateway/routers/chat_sessions.py`

接口：
- `POST /{session_key}/messages`
  - 调 `chat_svc.append_message_and_touch_session(...)`
- `POST /{session_key}/messages/batch`
  - 调 `chat_svc.append_messages_batch_and_touch_session(...)`
- `POST /{session_key}/messages/assistant-display-meta`
  - 调 `msg_repo.update_last_assistant_display_meta(...)`

这是前端/EvoPanel 主动写 transcript 的标准入口。

### 7.2 自动化任务会话

位置：`backend/app/gateway/automation_chat_session.py`

写入逻辑：
- `prepare_automation_chat_session(...)`
  - 先 `sess_repo.upsert_session_row(...)`
  - 再 `chat_svc.append_message_and_touch_session(...)` 写 user prompt
- `finalize_automation_chat_session(...)`
  - 如果 run 结束时还有消息，调用 `msg_repo.sync_checkpoint_messages_to_session(...)`

说明：
- automation 也会生成自己的 chat session
- 自动化 run 的 prompt 和结果会进入同一套 transcript 表

### 7.3 渠道/IM 侧 checkpoint 同步

搜索命中：`backend/app/channels/manager.py`

逻辑：
- 在 channel manager 中会调用 `msg_repo.sync_checkpoint_messages_to_session(...)`
- 说明某些 IM 渠道场景，消息可能先存在 LangGraph state，再异步同步进 transcript

### 7.4 协作 / 子任务消息镜像写入

位置：`backend/packages/harness/evoflow/collab/conversation_persist.py`

关键函数：
- `_persist_subtask_message_to_chat(...)`
- `_persist_subtask_entries_to_chat(...)`
- `append_subtask_conversation_messages(...)`
- `append_subtask_conversation_turn(...)`
- `append_collab_subtask_stream_message(...)`
- `append_subtask_outcome_record(...)`

核心逻辑：
- 先根据 lead thread 找到主 session_key
- 为子任务构造 executor thread id
- 然后仍写入 **同一张** `evoflow_chat_messages`
- 区分方式：
  - `thread_id = executor_thread`
  - `parent_thread_id = lead_thread`
  - `display_segments_json` 中带 subtask 标识

这说明：
- **子任务对话没有单独的 chat_messages 表**
- 而是与主会话共表，通过 thread 维度区分

---

## 8. 所有主要“写会话索引表”的入口

### 8.1 创建会话

位置：`chat_session_service.py`

函数：`create_new_session(...)`

逻辑：
- 先 `upsert_session_row(...)`
- 可选 `ensure_session_thread(...)`
- 若 context 中有 workspace，额外触发 `touch_session_workspace(...)`

### 8.2 ensure thread

函数：`ensure_session_thread(...)`

逻辑：
- 读取 session 当前 thread
- 若 thread 可用则复用
- 不可用则删除旧 thread 及本地 thread 数据
- 创建新 LangGraph thread
- 回写 `evoflow_chat_sessions.thread_id`

### 8.3 bind thread

函数：`bind_session_thread(...)`

逻辑：
- 用于 task jump / collab
- 把现有 thread 绑定到侧边栏 session
- 更新 `session_key ↔ thread_id`
- 视情况合并 context

### 8.4 删除会话

函数：`delete_session_full(...)`

逻辑：
- 删除 `evoflow_chat_messages` 里的消息
- 清理 workspace history / approvals / todos / artifacts
- `mark_session_deleted(sk)` 软删除 session
- 删除 LangGraph thread / local thread data / collab sqlite
- 再按 thread_id 删除 session 绑定

### 8.5 重置会话

函数：`reset_session_full(...)`

逻辑：
- 删除该 session 的 transcript
- 删除旧 LangGraph thread
- 新建 thread
- 保留 session 元信息，但把 `message_count` 置 0

---

## 9. 工作区历史逻辑

位置：`backend/packages/harness/evoflow/persistence/workspace_repositories.py`

### 9.1 当前工作区
- 当前值仍存在 `evoflow_chat_sessions.local_workspace_root`

### 9.2 历史工作区
- 会话级历史：`evoflow_session_workspace_history`
- 全局历史：`evoflow_workspace_global_history`

关键函数：
- `touch_session_workspace(...)`
- `set_session_workspace_paths(...)`
- `set_global_workspace_paths(...)`
- `clear_session_workspace_history(...)`
- `import_session_current_to_history_if_empty(...)`
- `migrate_existing_session_roots_to_history(...)`

对应 API：
- `GET /{session_key}/workspace-history`
- `PUT /{session_key}/workspace-history`
- `POST /{session_key}/workspace-bind`

这部分不是消息 transcript，但确实是“会话历史表”中和 session 强耦合的一套持久化。

---

## 10. 哪些地方在“读会话历史表”

### 10.1 聊天页面 / session 列表

位置：`backend/app/gateway/routers/chat_sessions.py`

读取：
- `list_sessions_for_ui(...)`
- `list_messages_for_display_with_im_fallback(...)`
- `list_messages_for_model_input(...)`

### 10.2 Session Search Tool

位置：`backend/packages/harness/evoflow/tools/builtins/session_search_tool.py`

直接 SQL 查询：
- `evoflow_chat_messages.content_text`
- `evoflow_chat_sessions.title`

用途：
- 搜索过去会话内容
- 作为“回忆过去聊天”的工具

### 10.3 Supervisor / 子任务会话查看

位置：`backend/packages/harness/evoflow/tools/builtins/supervisor/conversation.py`

逻辑：
- 通过 `list_subtask_conversation_ui_messages(...)`
- 最终从 `evoflow_chat_messages` 中按 executor thread / subtask 标识筛选

### 10.4 事件与任务处理

搜索命中：`backend/app/gateway/events/task_event_handlers.py`

逻辑：
- 会通过 `conversation_archive_from_thread_id(...)` 取 thread 对话归档
- 可能来自 transcript，也可能 fallback 到 checkpoint

---

## 11. 这套历史存储的几个关键设计点

### 11.1 主 transcript 已明确去 JSON 化、走扁平列

原因：
- 更适合 UI 展示
- 更适合简单搜索
- 更适合 token / reasoning / tool call 等字段单独读写

### 11.2 子任务消息与主会话共表

不是分表，而是：
- 主会话：lead thread rows
- 子任务：executor thread rows + `parent_thread_id`

所以“所有会话历史”其实在一张消息表里，但视图层会过滤。

### 11.3 checkpoint 是恢复源，不是主真相源

只有在以下场景 fallback / 回填：
- IM 渠道 transcript 尚未同步
- 协作/任务相关 session 首次打开但 transcript 为空
- run 结束后补写 checkpoint messages

### 11.4 会话删除是“session 软删除 + transcript 真删除”

- `evoflow_chat_sessions`：软删除标记
- `evoflow_chat_messages`：物理删除该 session 消息

---

## 12. 如果你问“存储会话历史表的所有地方”——可以直接记这几个核心文件

### 主核心
- `schema.py`
- `db.py`
- `session_repositories.py`
- `chat_message_repositories.py`
- `chat_session_service.py`

### 对外 API / 入口
- `app/gateway/routers/chat_sessions.py`
- `app/gateway/automation_chat_session.py`
- `app/channels/manager.py`

### 协作子任务会话
- `collab/conversation_persist.py`
- `tools/builtins/supervisor/conversation.py`

### 搜索与回放
- `tools/builtins/session_search_tool.py`
- `app/gateway/events/task_event_handlers.py`

---

## 13. 一句话结论

如果只看“真正的会话历史表”主链路：

- **会话索引** 存在 `evoflow_chat_sessions`
- **聊天消息正文** 存在 `evoflow_chat_messages`
- **所有主聊天、自动化聊天、协作子任务聊天，最终都尽量汇总落到这两张表**
- **LangGraph checkpoint 只是补充来源与回填机制，不是 UI 主存储真相源**
