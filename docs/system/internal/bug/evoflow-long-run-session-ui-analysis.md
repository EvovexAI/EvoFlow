### EvoFlow 长任务前端显示问题补充分析

## 针对你描述现象的直接结论

你提到的这些问题：

- 后台任务还在继续，但前端看不到相关记录
- 要刷新会话才能看到继续后的结果
- 切到其他会话后，看不到正在处理的流显示
- 任务中断后 transcript / session 状态不同步

从代码结构上看，**不是单一 bug**，而是当前实现里有一条明显的断层：

- `evoflow_chat_sessions` 负责保存 **会话执行状态**（`run_status/current_run_id/thread_id`）
- `evoflow_chat_messages` 负责保存 **最终 transcript / 已落库消息**
- 但前端“流式显示中的消息区”主要依赖 **当前 session 的 runtime 内存态 + attach 到流**

也就是说：

- **会话表能告诉前端“这个会话在跑”**
- **但不能自动保证前端还在看这条流，也不能自动把流恢复到消息区**

这就是你看到一系列“后台在跑，但前端看不到 / 切会话丢流 / 刷新后才回来”的核心原因。

---

## 1. 前端当前的真实状态模型

### 1.1 前端每个会话有独立 runtime store，但它是内存态

位置：`evopanel/src/react/lib/session-runtime-store.ts`

设计：
- 每个 `sessionKey` 都有一个 `SessionRuntime`
- 里面保存：
  - `rows`
  - `stream`
  - `isSending`
  - `seenRunIds`
  - `activeChatRunId`
  - `liveRunStatus`

关键点：
- 这不是数据库状态
- 也不是自动从 `chat_sessions` / `chat_messages` 持续重建的状态
- 它本质是 **前端页面生命周期内的运行时内存缓存**

### 1.2 消息区优先显示 liveRows，而不是数据库历史

位置：`evopanel/src/react/hooks/useThreadHistory.ts`

逻辑：
- 如果当前 session 还有 live rows，就优先显示 live rows
- 没有 live rows 才调用 `api.chatHistory(sessionKey, 200)` 从后端拉 transcript

这意味着：
- **流式显示和历史显示是两套来源**
- live 没接住时，UI 不会自动凭 `run_status` 继续把流补出来
- 最多只能等 transcript 落库后，reload/re-enter 再看到结果

---

## 2. `run_status/current_run_id` 只能表示“会话在跑”，不能恢复消息流

### 2.1 session 表记录运行态

位置：`backend/packages/harness/evoflow/persistence/session_run_state.py`

关键函数：
- `mark_session_run_started(...)`
- `mark_session_run_ended(...)`
- `list_active_sessions_for_keys(...)`

对应字段：
- `evoflow_chat_sessions.run_status`
- `evoflow_chat_sessions.current_run_id`

### 2.2 前端确实可以查“哪些 session 还在运行”

位置：
- `evopanel/src/lib/tauri-api.js`
- `backend/app/gateway/routers/langgraph_proxy.py`

接口：
- `GET /api/langgraph/active-sessions`

但这个接口只返回：
- `session_key`
- `thread_id`
- `run_id`
- `status`

它**不会返回一条可继续消费的 attach 流本身**。

所以即使前端知道：
- 某个 session 还在 `running`

也不等于：
- 它已经重新 attach 到该 run 的流
- 或者消息区已经开始继续显示 delta / tool / final

---

## 3. 切换会话后为什么经常“看不到继续的流显示”

### 3.1 `runId` 有硬门禁，只允许当前 active run 写入 live turn

位置：`evopanel/src/react/lib/run-turn-gate.ts`

关键逻辑：
- `shouldApplyChatEvent(...)`
- 只有 `payload.runId === rt.activeChatRunId` 才允许写入当前 live turn
- 若没有 active run，仅 `run_started` 允许建立绑定

这意味着：
- 背景会话如果没有正确恢复 `activeChatRunId`
- 或者 attach 时没有重新建立这一轮 run 绑定
- 后续来的 delta / tool / final 事件就会被门禁直接丢掉

### 3.2 会话切换保存的是“runtime 快照”，不是后台 attach 自动恢复

位置：`session-runtime-store.ts`

关键函数：
- `commitActiveSessionRuntime(...)`
- `mountSessionRuntime(...)`

这套逻辑能做的是：
- 切走前把当前 session 的 live rows / stream 缓存在内存 map
- 切回来时把这些缓存再挂回去

但它依赖一个前提：
- **之前这个 session 的 live runtime 没丢**

如果发生下面任一情况：
- 页面刷新
- runtime 被 `clearSessionRuntime(...)` 清掉
- attach 中断而没有重新建立 active run
- final/abort 后只剩 DB transcript、内存态已清空

那再切回来时，能看到的就只剩：
- transcript 已落库的内容
- 而不是“正在继续流式输出的中间态”

---

## 4. 为什么“后台还在跑，但前端消息区没动静”

### 4.1 发送后前端先本地记 run，再上报 session run_active

位置：`evopanel/src/lib/ws-client.js`

发送时会：
- 本地生成 `runId`
- `_emitEvent('chat', { state: 'run_started', runId })`
- 再 `POST /chat/sessions/{session}/run-active`
- 并把 `thread_id` / `session_key` 写进 run context

说明：
- 会话表中的 running 状态，本质是前端/网关主动标记的
- 不是 transcript 成功写入的充分条件

### 4.2 transcript 落库和流式显示不是同一步

发送时：
- 用户消息会先尝试 `appendSessionTranscriptMessage(...)`
- 失败时注释明确说：流式仍继续，后续 middleware / transcript 补写

也就是说可能出现窗口：
- 流已经在跑
- `run_status = running`
- 但 transcript 还没及时完整落库
- 如果当前 attach 又断了，消息区就会暂时“既没有 live，也没有完整 transcript”

这会直接导致：
- 后台还在执行
- 前端当前消息区看不到新记录
- 刷新后等 transcript/checkpoint 补齐才看到

---

## 5. 为什么“刷新会话后才能看到结果”

### 5.1 `useThreadHistory` 在非 live 状态下会重拉 transcript

位置：`useThreadHistory.ts`

逻辑：
- 没有 live rows 时，调用 `api.chatHistory(...)`
- 后端返回来源可能是：
  - `evoflow_chat_messages`
  - `langgraph_checkpoint`

所以“刷新后能看到”的根本原因通常是：
- transcript 已经落库了
- 或者 checkpoint fallback 能读到了
- 但之前前端当前会话 runtime 没保持住 live attach

### 5.2 后端本身就支持 transcript fallback / checkpoint fallback

位置：`chat_message_repositories.py`

关键函数：
- `list_messages_for_display_with_im_fallback(...)`
- `conversation_archive_from_thread_id(...)`
- `sync_checkpoint_messages_to_session(...)`

也就是说：
- **刷新能恢复，多数不是因为流恢复了**
- 而是因为后端历史读取链路把“已经存在的东西”拉回来了

---

## 6. 为什么切到别的会话后，看不到“后台会话”的正在处理流

这是当前设计里最明显的问题之一。

### 6.1 前端 UI 主消息区天然只服务“当前选中 session”

从 `ChatApp.tsx`、`useThreadHistory.ts`、`session-runtime-store.ts` 的组合看：
- 每次真正挂到 React 渲染上的 `streamRef / rows / isSending`
- 都是围绕 **当前 selectedSessionKey** 组织的

即使 store 里理论上能保存多个 session runtime：
- 只有当前选中的那个会话会被 mount 成可见 UI
- 其它 session 的“后台仍在流式输出”不会自动在前端有一个持久 attach + 持续渲染入口

### 6.2 当前实现更像“当前会话流式渲染 + 其它会话只显示 running 徽标”

后端通过 `chat_sessions.run_status/current_run_id` 能支持：
- 侧边栏知道某会话还在 running

但如果没有额外机制：
- 为所有 running session 建立独立 attach 监听
- 或统一后台 SSE 总线
- 或把 delta 实时镜像写入 per-session runtime/cache

那么非当前会话就只能做到：
- “知道它还在跑”
- 而不能做到：
- “持续看到它此刻在输出什么”

这正是你说的：
- 切换其他会话也看不到正在处理的流显示

---

## 7. 中断 / abort / terminal 为什么容易和会话表不同步

### 7.1 多条路径都可能结束 run

后端：
- `background_worker.py` finally 里会 `mark_session_run_ended(thread_id=...)`
- `langgraph_proxy.py` attach terminal 时会 `_touch_session_run_ended(...)`
- 前端 stop 时还会显式调用 `/run-idle`
- `run_status_reconcile.py` 启动后还会清 stale running rows

这意味着“结束态”来源很多：
- 前端主动 stop
- attach 看到 terminal
- 后台 worker finally
- 启动后 reconcile

容易出现：
- session 表先 idle 了
- transcript 补写还没完成
- 或 transcript 已写完，但前端 runtime 已被清掉
- 或 attach 先断，DB 还没改 idle

### 7.2 某些情况下前端会清 runtime，但用户感知是“任务好像没结束”

位置：`ChatApp.tsx`

在 `final` 处理里，多处会：
- `resetRuntimeStream(rt, ...)`
- `clearActiveRun(rt)`
- `markSessionSending(targetSk, false)`

如果这一步发生得比 transcript 完整可见更早，或者背景会话没有同步刷新：
- 用户就会感知成“前端把流丢了”

---

## 8. 这类问题与“会话表”的真正关系

### 会话表能解决的

`evoflow_chat_sessions` 可以稳定提供：
- 哪个 `session_key` 在运行
- 对应哪个 `thread_id`
- 当前 `run_id`
- 侧边栏 running / pending 状态

### 会话表解决不了的

它解决不了：
- 前端是否还 attach 着对应流
- 流中间态 delta 是否还在内存里
- 切会话后是否自动为后台 run 继续建立实时显示
- 当前 UI 是否还能重建一条“未封存的 live assistant turn”

所以本质上：
- **会话表是“运行态索引”**
- **不是“流式 UI 恢复机制”本身**

---

## 9. 我认为最可能的根因排序

### 根因 1：前端 live UI 绑定的是当前会话 runtime，不是所有 running session 的统一流层

影响：
- 切会话后后台任务仍跑，但消息区看不到持续输出

### 根因 2：`run_status/current_run_id` 只记录“在跑”，没有自动触发 attach 恢复

影响：
- 侧边栏可知 running，但消息区不自动恢复流

### 根因 3：transcript 落库与 live 流显示分离，存在不同步窗口

影响：
- 后台在跑 / 已完成，但前端要刷新后才看到

### 根因 4：`runId` 门禁过严，attach 恢复不完整时事件会被丢弃

影响：
- 某些 delta/tool/final 明明到了，但没绑定 active run，就直接不进 UI

### 根因 5：多路径结束 run，session 表与 runtime/transcript 容易出现短暂错位

影响：
- 中断后状态错乱、UI 和 DB 观感不一致

---

## 10. 针对你的问题，最直接的修复方向

### 方向 A：把“running session 列表”升级为“可恢复 attach 列表”

不是只查：
- `GET /langgraph/active-sessions`

而是前端要基于它做：
- 对所有 active session 建立轻量后台 attach 管理
- 至少为非当前会话维护：
  - 最新 assistant 文本摘要
  - 最近 tool 状态
  - 是否有新 transcript 追加

这样侧边栏就不只是一个 running 小点，而是真能反映“它还在继续输出”。

### 方向 B：会话切回时，优先按 `session_key + current_run_id + thread_id` 自动 reattach

当前切回会话时，更像：
- 先 mount runtime
- 没 live 再 reload history

应该增强为：
- 若该 session 在 `run_status=running` 且有 `thread_id/current_run_id`
- 则优先尝试 attach 到该 run
- attach 成功再恢复 live turn
- attach 失败再退回 transcript/checkpoint reload

### 方向 C：把 live turn 做“可恢复快照化”

现在 runtime 是纯内存态，容易丢。

建议：
- 定期把当前 live turn 的最小快照按 session 保存
  - `runId`
  - 当前 assistant 累积文本
  - 当前 tool timeline
  - startTs / phase
- 刷新/重挂载时先恢复这份快照，再补 attach

### 方向 D：降低 transcript 可见性滞后

建议：
- 更积极地把 partial/final assistant 内容落到 `evoflow_chat_messages`
- 或至少在长任务中做更稳定的中间批次持久化

这样即使 attach 丢了：
- reload 也能更快看到“截至目前”的结果
- 而不是等整轮 final 或 checkpoint sync

### 方向 E：把非当前会话的运行态也更新到侧栏/列表摘要

例如侧栏每个 running session 可显示：
- 最近 1 行 assistant 流摘要
- 最近 tool 名称
- 正在执行 / 等待工具 / 已停止但待同步

这样即使主消息区不切过去，也不会让用户感觉“后台在黑盒里消失了”。

---

## 11. 一句话判断

如果只从你描述的问题看，**我认为最核心的不是 SQLite 表坏了，而是前端把 `chat_sessions` 当作“运行态标记”，却没有把它进一步做成“跨会话可恢复流 UI”的基础设施。**

也就是说：
- 后端表层已经知道“它在跑”
- 但前端渲染层没有完整兑现“那我就继续把它显示出来”
