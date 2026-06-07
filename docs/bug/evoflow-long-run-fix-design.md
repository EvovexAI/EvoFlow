### EvoFlow 长任务会话可见性修复方案设计

## 结论先说

你描述的这组问题，本质上不是单个 bug，而是 **持久态与流态分裂**：

- **持久态**：`evoflow_chat_sessions` / `evoflow_chat_messages` 已经知道会话是否在跑、已落了哪些消息。
- **流态**：前端消息区是否还能持续显示，取决于当前会话 runtime、attach 状态、`activeChatRunId` 绑定、以及是否仍在消费该 run 的 SSE 事件。

所以现在的系统更像：

- **会话表能证明“任务还活着”**；
- **但前端不能仅凭会话表把“流继续接回来”**。

这会直接导致以下现象：

1. 后台还在执行，但当前页面没 attach 到 run，于是看不到新增流。
2. 切走会话后，非当前会话没有持续 attach，回来看不到 live stream。
3. 刷新后能看到一些内容，是因为重新从 transcript / checkpoint 拉历史，而不是流真正恢复了。
4. 如果中途中断或前端断开，`run_status=current running` 和消息区 live 状态会脱钩。

---

## 一、当前实现里最关键的设计断点

## 1. 前端 runtime 是按会话缓存，但事件消费仍然受当前 run 绑定限制

`session-runtime-store.ts` 已经提供了每个 `sessionKey` 的 runtime 缓存：

- `rows`
- `stream`
- `isSending`
- `activeChatRunId`
- `liveRunStatus`
- `seenRunIds`

这说明前端**不是完全没有多会话 runtime 基础**。

但 `run-turn-gate.ts` 的门禁非常硬：

- 没有 `activeChatRunId` 时，只允许 `run_started`
- 一旦绑定了 `activeChatRunId`，只接受同一个 `runId` 的事件
- sealing 阶段只接受 terminal

这意味着：

- 某个会话即便在数据库里显示 `run_status=running`
- 只要这个会话的 runtime 没重新绑定 `activeChatRunId`
- 后续来的 `delta/tool/final` 就**不会进入该会话的 live UI**

这正是“后台还在跑，但前端没流”的核心断点之一。

---

## 2. `getActiveSessions()` 只能告诉前端“谁在跑”，不能自动恢复消息流

后端 `GET /langgraph/active-sessions` 读取的是 `evoflow_chat_sessions`：

- `session_key`
- `thread_id`
- `current_run_id`
- `run_status`

这套接口很适合做：

- 侧栏转圈
- 会话 running 标记
- 启动后的 stale run reconcile

但它**不负责 attach stream**，也不负责把 live token 补回前端消息区。

所以它现在最多解决：

- “前端知道这个会话还在执行”

却解决不了：

- “前端重新订阅到它的事件”
- “消息区继续显示该轮未完成输出”
- “切换回来时恢复到 live 中的 turn”

---

## 3. 当前系统对“挂载时恢复 attach”只有局部补丁，没有形成统一机制

在 `ChatApp.tsx` 中，能看到一段很明显的补丁逻辑：

- 从任务页跳转带 `pendingSession + pendingThread + pendingTaskId`
- 然后轮询 `getSessionRunStatus()`
- 拿到 `runId` 后执行 `chatAttachToRun()`

这说明项目已经意识到：

- **只切回会话并 reload history 不够**
- **还需要 attach 到正在运行的 run**

但这段逻辑目前的问题是：

- 只覆盖“特定跳转场景”
- 不覆盖普通切会话 / 页面刷新后恢复 / 启动后恢复 / 当前会话 attach 丢失重连
- 更像 case-by-case patch，而不是全局运行态恢复框架

所以你会看到“有些路径能恢复，有些路径必须刷新，有些路径根本恢复不了”。

---

## 4. transcript 落库与 live stream 是两条链，且中途落库还不够激进

`ws-client.js` 在发送前会先把 user message 追加到 transcript；assistant 的完整行更多依赖：

- 流完成时前端写入 rows
- `persistAssistantDisplayMeta(...)`
- 中断时 `persistPartialStreamToBackend(...)`
- 后端 `TranscriptMiddleware` / checkpoint sync 补写

这带来两个现实问题：

### 4.1 长任务执行中，若流没 attach，未必立刻有足够的 transcript 可供刷新恢复

也就是说：

- 后端还在跑
- `run_status=running`
- 但 transcript 还没中途落 enough snapshot
- 前端没 live attach
- 刷新时也只能看到旧内容

于是用户感觉像“任务消失了”。

### 4.2 中断路径和正常 final 路径的可恢复性不对称

`aborted` 路径里已经有：

- `sealStoppedStreamTurn(...)`
- `buildPartialStreamAssistantRow(...)`
- `persistPartialStreamToBackend(...)`

这说明“手动停止”场景对 partial persistence 的意识是存在的。

但对于：

- 页面断开
- attach 丢失
- 长任务中途切会话
- 网关短断

仍缺一个统一的 **stream snapshot -> transcript checkpoint** 机制。

---

## 5. 前端消息区的可见性仍然高度绑定当前 active session

虽然 runtime store 是按 `sessionKey` 分桶的，但从 `ChatApp.tsx` 的状态结构看，真正驱动当前 UI 的仍然是：

- `selectedSessionKey`
- 当前 `streamRef`
- 当前 `activeChatRunIdRef`
- 当前 `isSending`
- 当前 `threadPanelState`

因此现在更像：

- **多会话有缓存**
- 但 **只有当前会话是“活连接对象”**

结果就是：

- 非当前会话顶多在侧栏上知道它 running
- 但它的 token / tool / final 是否持续灌进 session runtime，并不可靠

这会造成“切到别的会话看不到正在处理的流显示”。

---

## 二、修复目标应该怎么定义

不要把目标定义成“刷新后能看到结果”，那只是最低保底。

更合理的目标应分三层：

### 目标 A：可见性

- 任意 running 会话在侧栏都必须稳定显示运行中
- 切换到 running 会话时，消息区应自动恢复 live 状态或至少恢复到最近快照

### 目标 B：可恢复性

- 刷新页面后，running 会话应自动重建 runtime
- 断线 / attach 丢失后，应能自动 reattach
- 即使 reattach 失败，也应能从 transcript 快速看到最新进展

### 目标 C：跨会话并行感知

- 用户在 A 会话里工作时，B 会话如果仍在执行，侧栏应看到摘要进展
- 至少能看到：正在运行 / 最近输出摘要 / 最近工具状态 / 完成通知

---

## 三、建议的修复方案

## 第一阶段：最小止血方案（优先做）

目标：**不大改架构，先解决“后台继续跑但用户看不到”**。

### 1. 切换到某会话时，如果它仍在 running，自动执行 reattach

### 建议

在 `ChatApp.tsx` 的“会话切换完成 / selectedSessionKey 变化后”增加统一逻辑：

1. 读取该会话的 session row
2. 如果满足：
   - `runStatus in ('running','pending')`
   - `threadId` 存在
   - `currentRunId` 存在
3. 则优先执行：
   - `mountSessionRuntime(sessionKey, ...)`
   - `wsClient.chatAttachToRun(sessionKey, threadId, currentRunId)`
4. attach 前后都不要先清空现有 runtime rows
5. attach 失败时，降级执行 transcript reload

### 为什么这一步最重要

因为你现在最痛的体验问题就是：

- 切回来只看到旧历史
- 看不到继续中的流

只要把“切回 running 会话自动 attach”补成统一逻辑，至少能先把最明显的断层补上。

### 需要修改的主要模块

- `ChatApp.tsx`
- `ws-client.js`
- 可能需要补一个统一 helper，比如 `reattachRunningSessionIfNeeded(sessionKey)`

---

### 2. 页面启动后，对当前会话执行一次 running session 恢复

现在项目里已经有：

- `getActiveSessions()`
- `getSessionRunStatus()`
- `chatAttachToRun()`

建议在 `ChatApp` 初始加载后增加：

1. 恢复 `selectedSessionKey`
2. 拉该会话最新 session row
3. 如果该会话是 running，则执行 reattach
4. attach 成功前，UI 先显示“正在恢复执行中会话...”轻量态

### 作用

解决：

- 刷新后必须手动再点几次
- 重开客户端后当前会话看不到 live 状态

---

### 3. 给 session runtime 增加“可恢复 attach 状态”字段

当前 runtime 里已有：

- `activeChatRunId`
- `liveRunStatus`
- `isSending`

建议再加：

- `attachedThreadId`
- `attachState: 'idle' | 'attaching' | 'attached' | 'detached' | 'error'`
- `lastEventAt`
- `lastVisibleTextPreview`
- `lastToolPreview`

### 作用

前端才能区分：

- 这个会话是 running 但未 attach
- 正在尝试 attach
- attach 断了但后端可能还在跑
- 有 live preview 可展示在侧栏

这一步是后续“多会话 running 摘要”能力的基础。

---

### 4. 对 `shouldApplyChatEvent()` 增加“恢复绑定窗口”

当前 `run-turn-gate.ts` 过于严格：没有 `activeChatRunId` 时，只允许 `run_started`。

但恢复场景经常是：

- 前端重挂后，先拿到了 `delta/tool/final`
- 而不是先拿到 `run_started`

### 建议

新增恢复场景例外：

- 如果 session row 标明 `currentRunId = X`
- 且 runtime 当前 `activeChatRunId` 为空
- 且收到的 payload `runId === X`
- 则允许这条事件触发自动 `bindActiveRun(rt, X)`

### 否则会怎样

现在这种情况会被直接丢弃，于是：

- 后台明明在推流
- 前端因为没先看到 `run_started`，整个 run 再也接不上

这正是很多“必须刷新也未必恢复”的隐藏来源。

---

## 第二阶段：增强 transcript 保底能力

目标：**即使没 attach 上，也能快速看到最新进度**。

### 5. 增加 assistant 中途快照落库

建议在后端或网关增加“长任务中途快照持久化”机制，例如：

- 每隔 3~5 秒，或每累计 N 个 token
- 将当前 assistant partial turn 写入 transcript snapshot
- 采用可替换 / upsert 语义，而不是每次插新行

### 推荐数据形态

可以选择两种方式之一：

#### 方案 A：在 `evoflow_chat_messages` 中引入 partial message 标识

例如新增：

- `run_id`
- `message_stage = partial | final`
- `is_live_snapshot`
- `snapshot_seq`

同一 `run_id` 的 partial 行可覆盖更新，final 到达后转正。

#### 方案 B：新增一张轻量 live snapshot 表

例如：`evoflow_chat_live_runs`

字段建议：

- `session_key`
- `thread_id`
- `run_id`
- `status`
- `partial_text`
- `partial_tools_json`
- `updated_at`
- `last_event_at`

我更推荐 **方案 B**，因为：

- 不会污染正式 transcript
- 恢复逻辑更清晰
- 可以专门用于 UI 恢复和侧栏摘要

---

### 6. reload history 时，合并 live snapshot

不管采用方案 A 还是 B，前端 reload 当前会话历史时，都应遵循：

1. 先读正式 transcript
2. 如果 session row 是 running
3. 再读 live snapshot
4. 若 snapshot 的 `run_id` 与 `current_run_id` 一致，则在消息区末尾临时拼出“未完成 assistant turn”

### 效果

即使 attach 没恢复成功，也能看到：

- 最新已生成文本
- 工具调用到哪一步
- 正在执行中的视觉反馈

用户就不会觉得“任务凭空消失”。

---

### 7. `aborted / disconnected / silent` 统一进入 snapshot flush

当前：

- 手动停止路径有 partial persist
- 但断线和 attach 丢失并不统一

建议统一成一个规则：

- 只要一个 run 曾经有可见输出
- 且进入 `aborted` / `stream_health=disconnected` / attach teardown
- 就立即 flush 当前 turn 到 partial snapshot

### 作用

保证：

- 切会话
- 浏览器刷新
- 网关重连
- 页面崩掉

都不会把用户已见过的一半输出丢掉。

---

## 第三阶段：真正支持“跨会话长任务可见”

目标：**切到别的会话，也能看到其他会话仍在跑且有进展。**

### 8. 把“running 会话的摘要层”从当前消息区剥离出来

当前前端把 live 可见性过度绑在当前消息区上。

建议新增一层全局状态：

- `runningSessionMap: sessionKey -> runtime summary`

每个 summary 至少包含：

- `runId`
- `threadId`
- `status`
- `lastEventAt`
- `previewText`
- `toolStatusSummary`
- `hasUnseenUpdate`

### 作用

这样即使用户当前不在那个会话页，也能在侧栏看到：

- 正在“调用工具 / 生成中 / 等待确认 / 已完成”
- 最近一行摘要
- 是否有新变化

这会明显改善“切其他会话后完全看不到正在处理的流显示”的体验。

---

### 9. 非当前会话至少做“轻 attach”或“轮询摘要”

这里有两个强度选项：

#### 方案 A：轻 attach

对 running 会话保留后台 attach，但不完整渲染消息区，只维护摘要。

优点：

- 实时性最好

缺点：

- 连接数量更多
- 前端复杂度更高

#### 方案 B：摘要轮询

每隔 2~5 秒拉：

- `active-sessions`
- `live snapshot summary`

优点：

- 实现简单
- 稳定

缺点：

- 不是真正 token 级实时

### 实战建议

先上 **方案 B**，因为性价比最高。

即：

- 当前选中会话：真实 attach + live stream
- 非当前 running 会话：摘要轮询 + running badge + 最近进展

这样能先把多会话体验做对，而不用一下把多流并发 attach 全做完。

---

## 第四阶段：统一 run 恢复协议

目标：**把现在 scattered patch 收束成一套固定流程**。

### 10. 定义统一的会话恢复状态机

建议为每个会话建立统一状态机：

- `idle`
- `running_unattached`
- `attaching`
- `live_attached`
- `degraded_snapshot_only`
- `finalizing`
- `completed`
- `stale_cleared`

触发条件来自三类信号：

- **SQLite row**：`run_status/current_run_id/thread_id`
- **attach 信号**：是否已经成功 attach 到 stream
- **snapshot 信号**：是否存在最新 partial snapshot

### 好处

这样以后不会再出现：

- 有的逻辑看 `isSending`
- 有的逻辑看 `activeChatRunId`
- 有的逻辑看 `runStatus`
- 有的逻辑看 `streamHealth`

最后导致状态互相打架。

---

### 11. 后端补一个统一恢复接口

建议新增一个面向 UI 的恢复接口，例如：

`GET /api/chat/sessions/{sessionKey}/runtime-status`

返回：

- `session_key`
- `thread_id`
- `run_id`
- `run_status`
- `attach_recommended`
- `snapshot_available`
- `latest_partial_text`
- `latest_tool_summary`
- `last_event_at`

### 用途

前端进入会话时不必自己拼多套来源，而是直接问：

- 这个会话现在是否应该 attach？
- 如果 attach 失败，有没有 snapshot 可渲染？

这会比现在前端自己组合 `session row + runStatus + history + thread state` 简单很多。

---

## 四、建议的实施优先级

## P0：必须先做

### 前端

- 切回 running 会话时自动 `chatAttachToRun()`
- 页面启动后对当前 running 会话自动恢复 attach
- `run-turn-gate.ts` 支持基于 `currentRunId` 的恢复性重新绑定
- 为 session runtime 增加 `attachState/lastEventAt` 等恢复字段

### 后端

- 保证 `run_status/current_run_id` 在 run start/final/abort 上更新一致
- attach terminal 后及时触发 `mark_session_run_ended`
- 减少 stale running row 残留

### 预期收益

- 切回会话能继续看流
- 刷新后更容易恢复 live
- “后台继续跑但前端像死了”明显减少

---

## P1：强烈建议跟进

### 后端 / 持久层

- 增加 live snapshot 持久化
- reload history 时合并 partial snapshot
- `disconnected/silent/aborted` 统一 snapshot flush

### 预期收益

- 即使 attach 失败，刷新后也能看到最近进展
- 长任务对前端连接质量不再那么敏感

---

## P2：体验升级

### 前端

- running session 摘要层
- 非当前会话的摘要轮询
- 侧栏显示最近工具状态 / 最新一句摘要 / 未读更新点

### 预期收益

- 切到别的会话也不会“失去对长任务的感知”
- 多任务并行体验会明显变好

---

## 五、我建议你实际改代码时的落点

## 前端优先改这些地方

### `ChatApp.tsx`

负责新增：

- 会话切换后的 `reattachRunningSessionIfNeeded`
- 页面启动恢复当前 running session
- attach 失败降级 reload + snapshot restore
- session runtime attach 状态驱动 UI

### `session-runtime-store.ts`

负责扩展：

- `attachState`
- `attachedThreadId`
- `lastEventAt`
- `previewText`
- `toolSummary`

### `run-turn-gate.ts`

负责放宽恢复场景门禁：

- 允许基于已知 `currentRunId` 重新 bind
- 不再严格依赖必须先收到 `run_started`

### `ws-client.js`

负责补齐：

- attach/re-attach helper
- 断线后恢复策略
- live snapshot flush 触发
- 非当前会话摘要状态更新

---

## 后端优先改这些地方

### `session_run_state.py`

负责继续作为 running truth source，但要保证：

- `mark_session_run_started`
- `mark_session_run_ended`
- `peek_current_run_id`

语义稳定，避免 row 状态和实际运行错位。

### `run_status_reconcile.py`

负责：

- 清 stale row
- attach terminal 后尽快回写 idle
- 为 UI 恢复提供更可信的状态基础

### `langgraph_proxy.py`

负责：

- run start / terminal 的统一 hook
- 如要加 live snapshot，可在这里做流中间态持久化切面

### transcript / persistence 相关模块

建议加：

- partial snapshot upsert
- final turn 完成时将 snapshot 收口 / 清理

---

## 六、推荐的落地顺序

如果让我实际排开发顺序，我会这样做：

### 第 1 步

先做 **切会话自动 reattach + 启动恢复当前 running 会话**。

这是最小改动、最大收益。

### 第 2 步

做 **run gate 恢复性重绑**。

否则 attach 已恢复，但事件可能仍因 `activeChatRunId` 空缺被丢。

### 第 3 步

做 **partial snapshot 持久化**。

把“必须 live attach 才看得到进展”改造成“live 最佳、snapshot 兜底”。

### 第 4 步

做 **running session 摘要层**。

让用户切到别处时仍知道后台任务在怎么推进。

---

## 七、一句话架构建议

**把 `evoflow_chat_sessions` 从“只是侧栏状态表”，升级为“运行恢复索引”；再给它配一层 `live snapshot`，前端用“attach 优先、snapshot 兜底、摘要跨会话可见”的模式统一消费。**

这样才能真正解决你说的这一整串问题，而不是继续靠刷新、补丁式轮询和某几个特殊跳转路径来兜。

---

## 八、如果下一步继续推进

我建议后续工作分两条：

1. **先做 P0 代码改造**：我可以直接帮你在前端把 `切回 running 会话自动 reattach` 这一版实现出来。
2. **再做 P1 设计落库**：我可以继续给你补一版 `live snapshot` 的表结构和接口设计，细到字段级别和前后端交互协议。

如果你要，我下一步就可以直接开始做 **P0 的实际代码修改**。