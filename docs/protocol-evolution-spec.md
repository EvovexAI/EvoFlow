# EvoFlow → ZCode v4 protocol 演进技术规格书

> 作者：Cursor AI（基于 ZCode 2026-10-08 snapshot + EvoFlow 当下代码）
> 状态：草案 v0.1
> 读者：4 人及以上团队（后端 v4 协议 / 前端 v4 shell / 数据迁移 / 业务迁移）

## 0. 目标与范围

### 0.1 一句话目标

把 EvoFlow 当前"几千行 ChatApp.tsx + 174+ Python routes + 自己一套 SSE 流规整"的实现，**整体替换为 ZCode v4 协议 + v4 投影 store + v4 shell 渲染链**。**一次性切换（big bang）**，并行迁移老 DB 数据。

### 0.2 不变量（迁移期间/完成后都要满足）

ZCode v4 三条规则——**迁移期间 EvoFlow 必须保证不破坏任一条**：

1. **snapshot → 整体替换，绝不 merge**：服务端给一帧 `ConversationSnapshot`，客户端整对象替换。不允许把"新 snapshot 的 fields.rows.window 与旧字段拼接"。
2. **delta frame 应用规则**：`frame.fromSeq === state.seq` 才 apply；不等则拒绝 + 推 recovery；断档不缓存猜测，连接中断携水位重订阅。
3. **base 与状态同生共死**：transport 不再持任何"上次成功的快照"——subscribe 必须 atomic publish 一整帧 snapshot。

### 0.3 范围

| 路径 | 在范围 | 备注 |
|---|---|---|
| 业务后端（员工 / 协同 / 计划 / 浏览器面板 / GoalMode / 工作区） | ✅ 保留 | 仅通过 v4 protocol 暴露 |
| EvoFlow 自有 SSE 流 | ❌ 弃用 | 由 v4 frame 替换 |
| LangGraph / ag-ui 适配器 | ✅ 保留 | 作为内部渲染器转 v4 frame |
| 数据库 schema | ✅ 一次迁移 | 旧的 session/thread schema → v4 row / logEpoch / seq |

## 1. 现状基线

| 项目 | 数据 |
|---|---|
| EvoFlow 后端 Python 文件 | 174+ (`backend/app/`) |
| EvoFlow 前端 TS/TSX | 414 文件 / 109,618 行 (`src/react/`) |
| EvoFlow `ChatApp.tsx` 单文件 | 15,549 行 |
| ZCode v4/ui | 203 文件 / 49,662 行 |
| ZCode v4/shared | 38,025 行 |
| ZCode 单文件最大 | `SessionPane.tsx` 4723 行 |
| EvoFlow 业务模块（保留） | `BrowserPanel`, `MeetingView`, `EvoFlowHomeDashboard`, `ChatComposer`, `AppWorkflowCanvas`, `WorkspaceFileTree`, `ShellSessionList`, `ToolCallList` |

## 2. 协议契约（v4 frame shape）

### 2.1 服务端 → 客户端

```
ConversationTopicFrame:
  subscriptionId: str
  logEpoch: str           # 重启/迁移的代际；客户端首次连接不携带 base 时 = "0"
  fromSeq: int            # 帧左端点；snapshot payload = fromSeq
  toSeq: int              # 帧右端点；snapshot payload = toSeq
  payload: ConversationSnapshot | ConversationDeltas
```

### 2.2 `ConversationSnapshot`（A 区：行级 + 状态）

完整 schema 在 `ZCode/packages/shared/src/zcode-protocol-v4/snapshot.ts` / `rows.ts`。**EvoFlow 必须把以下字段全填上**才能 write `Snapshot`：

```
ConversationSnapshot = {
  session_id, log_epoch, seq
  rows: { window: [ConversationRow, ...], firstRowId, totalCount }
  queue, pendingCommands
  phase: SessionPhase
  background_works
  error, plan_directory_revision, ...
  session_plans, plansLoading
  turn_navigator_directory_revision
  rendering, runtime
  model_transition
}
```

### 2.3 `ConversationRow` 关键 kind（EvoFlow 必须投影）

| ZCode `kind` | EvoFlow 来源 | 备注 |
|---|---|---|
| `turnHeader` | 每次 user 发送后首帧 | `origin: userInput`, `state: running` 等 |
| `userInput` | user 发送的文本（`EvoFlow.app.channels.*` 入站） | `origin: realUser` / `realUser` |
| `assistantText` | LLM 文本（ag-ui events） | `state: streaming` / `closed` |
| `reasoning` | LLM reasoning（ag-ui events） | 同上 |
| `toolCall` | LLM tool_call（ag-ui events） | `toolName, status` |
| `imageGen` / `videoGen` | 媒体生成结果 | 来自 channel bridge |
| `timelineMarker` | lightBoundary / modelChange | 由 EvoFlow 推断 |
| `hookInvocation` | Hook（EvoFlow 后端 hook） | optional |

### 2.4 `ConversationDeltas`（B 区）

```
ConversationDelta:
  op: "row.appended" | "row.upserted" | "row.removed"
  row?: ConversationRow  # 仅 appended/upserted
  fromRowId?: int        # 仅 removed
```

**EvoFlow 写入 deltas 时必须遵守**：append 在 rowId 单调增；upserted 在 `rowId` 不变但 fields 变；removed 必须给 fromRowId 边界。

### 2.5 客户端 → 服务端

```
V4CommandEnvelope:
  type: "sendText" | "steer" | "abort" | "fork" | "editUserQuery" | "switchSession" | ...
  commandId: str
  session_id
  payload: ...
```

EvoFlow 现有 HTTP routes (`backend/app/gateway/routers/`) 大部分接受 `POST /api/...` 形态，**必须改为 WebSocket 或 SSE v4 RPC**：`POST /v4/conversation/command` + 服务端 ACK + 后续 projection frame。

## 3. 端到端最小流（v4）

```
[Client] subscribe(sessionId, base?)
  ↓
[Server] ACK(subscriptionId, mode: "snapshot" | "resume", logEpoch)
  ↓
[Server] initial frame: ConversationSnapshot  // 整块替代
  ↓
[Client] activate(subscriptionId)
  ↓
[Server] deltas frame: ConversationDeltas  // 增量
[Server] deltas frame: ...
  ↓
[Client] sendCommand(sendText)  → ACK accepted
  ↓
[Server] deltas frame: row.appended(userInput)
[Server] deltas frame: row.appended(turnHeader)
[Server] deltas frame: row.appended(assistantText, open)
[Server] deltas frame: row.upserted(assistantText, content+=delta)
[Server] deltas frame: row.upserted(assistantText, state="closed")
```

## 4. EvoFlow 数据 shape 映射表

| EvoFlow 现存 | v4 投影位置 | 备注 |
|---|---|---|
| `session.thread_id` | `ConversationSnapshot.session_id` | 主键 |
| `session.user_id` / `org_id` | `session_id` 或 session_meta | 通过 `conversationTopic()` 派生 |
| `thread.message_id` | `ConversationRow.rowId` | 单调递增 |
| `messages.role` | `ConversationRow.kind` | `assistant` → `assistantText`，`tool` → `toolCall`，`system` → `turnHeader` |
| `messages.content` (text) | `ConversationRow.text` 或 segment | 文本片段 |
| `messages.reasoning` | `ConversationRow.kind=reasoning` | |
| `messages.tool_call` | `ConversationRow.kind=toolCall` | `toolName`, `args`, `result` |
| `messages.images` | `ConversationRow.images[]` | v4 不直接，需 wrapper |
| `pendingCommands` | `ConversationSnapshot.pendingCommands` | |

**EvoFlow 持久化的转换器**：在 `backend/app/gateway/v4/conversation_projection.py` 写一个 `ConversationProjectionWriter`：

```python
class ConversationProjectionWriter:
    def __init__(self, session_id: str, log_epoch: str):
        self.session_id = session_id
        self.log_epoch = log_epoch
        self.seq = 0
        self.rows: dict[int, ConversationRow] = {}
    
    def emit(self, row: ConversationRow) -> ConversationTopicFrame: ...
    def remove(self, row_id: int) -> ConversationTopicFrame: ...
    def snapshot(self) -> ConversationSnapshot: ...
```

这层**只做"投影"**——保留 EvoFlow 现有 ag-ui 解析 + LangGraph 适配；输出 v4 frame 即可。

## 5. 后端演进路径（里程碑）

### H1 — 协议骨架 + 一条端到端（目标 1–2 周）

后端：
- 新建 `backend/app/gateway/v4/protocol_v4.py`：把 `ZCode/packages/shared/src/zcode-protocol-v4/` 的 zod schema 翻译为 pydantic。
- 新建 `backend/app/gateway/v4/conversation_projection.py`：写 `ConversationProjectionWriter`。
- 新建 `backend/app/gateway/v4/routers.py`：暴露 `POST /v4/conversation/subscribe` (websocket or SSE)。
- **不替换**现有 routes——H1 是**纯增量**。H2 起再做切流。

前端：
- 新建 `evopanel/src/react/lib/v4/`：复制 ZCode v4 的 `projectionStore.ts` + `useConversationProjection.ts` + `transport.ts`（保留 ZCode 类型结构）。改 `@zcode/shared/zcode-protocol-v4` 为内部 `lib/v4/protocol.ts`。
- 新建 `evopanel/src/react/components/v4/MiniSessionPane.tsx`：复用 ZCode `ConversationRowView.tsx` 的极简版（只渲染 userInput + assistantText），接 `MiniSessionPane` 通过 `useConversationProjection` 订阅。
- ChatApp 在 dev mode 加一个开关 `<MiniSessionPane />` 替代 `MessageVirtualList`，可来回切换。

验收：1 个 session 1 条 message → v4 subscribe → snapshot → delta → `MiniSessionPane` 看见文字。

### H2 — 渲染层扩展（目 1 周）

- `MiniSessionPane` 扩为真 `SessionPane`：复制 ZCode `SessionPane.tsx` 的命令派发层（queue / abort / retry / fork / edit / steer）
- 接入 EvoFlow 现有 `toolCall` 投影 → `ConversationAgentToolCallRow`
- 接 `ConversationComposer`

### H3 — 后端切流（目标 1 周）

- WebSocket / SSE 双协议并行；router 中所有 chat stream → v4 frame 投影
- 写 `EvoFlowConversationProjectionWriter` 包装现有 agui_stream_normalizer + langgraph_route_logger
- 旧 SSE 路由保留为「fallback」但默认 disable

### H4 — 数据迁移（目标 1 周）

- 启动时一次性把 DB 旧 thread + message → v4 row logEpoch=0
- 新 session 从 logEpoch=1 开始

### H5 — 前端整换（目标 2–3 周）

- `ChatApp.tsx` 14K 行拆解 + 删
- 所有业务面板（BrowserPanel / MeetingView / EvoFlowHomeDashboard / ToolCallList / AppWorkflowCanvas / WorkspaceFileTree / ShellSessionList）保留在 `src/react/components/`，挂到 SessionPane 命令派发钩子
- 旧 `MessageVirtualList` 路径完全删除

### H6 — 业务面板迁移（目标 2 周）

- 浏览器面板通过 `useConversationProjection` 接 context 行级 toolCall + imageGen
- 会议视图：会议话题作为 `ConversationTopicFrame.session_id`，独立 pane
- Plan / Proactive / GoalMode 同上

### H7 — 测试 + 端到端（目标 1 周）

- vitest 已有 22 fail（pre-existing 修复）
- 新增 v4 端到端测试：1 个长 session → subscribe → 50 条 delta → verify state
- 端到端 perf 测试（与 ZCode 持平）

### H8 — 收尾 + 切换（目标 1 周）

- 全链路 big bang 切换
- 监控 + 应急回滚通道

总计：**12 周**。

## 6. 前端演进路径

```
ChatApp.tsx (现状)
  ↓ 拆 H1：MiniSessionPane → 替代 MessageVirtualList
ChatApp.tsx (H1)
  ↓ 拆 H2：SessionPane 接入
ChatApp.tsx + SessionPane 共存 (H2)
  ↓ 拆 H5：ChatApp 命令派发拆出去
仅 SessionPane + 业务面板 (H5)
  ↓ H6：业务面板接入
完成 v4 shell
```

### 6.1 关键文件替换表

| 现有 | 替换为 | 来源 |
|---|---|---|
| `src/react/ChatApp.tsx` (15549 行) | 拆为 SessionPane + 命令派发 + 业务挂载点 | ZCode SessionPane |
| `src/react/components/MessageVirtualList.tsx` | `src/react/components/v4/ConversationTimeline.tsx` | ZCode 完整复制 |
| `src/react/components/MessageRow.tsx` | `src/react/components/v4/ConversationRowView.tsx` + 子组件 | ZCode 完整复制 |
| `src/react/components/ChatMessageStreamPane.tsx` | `src/react/components/v4/SessionPane.tsx` 部分 | ZCode SessionPane |
| `src/react/components/ChatComposer.tsx` | `src/react/components/v4/ConversationComposer.tsx` | ZCode |
| `src/react/components/ToolCallList.tsx` | `src/react/components/v4/ToolCallBlocks.tsx` + 业务 wrapper | ZCode + EvoFlow 业务 tool |
| `src/react/lib/stream-snapshot-store.ts` | 弃用 | ZCode ConversationProjectionStore |
| `src/react/lib/build-stream-display-row.ts` | 弃用 | ZCode 投影即 snapshot 整块替换 |
| `src/react/lib/apply-live-stream-overlay.ts` | 已删 (Phase D) | |
| `src/react/lib/use-live-process-snapshot.ts` | 弃用 | ZCode projection hook |

## 7. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| 协议 mismatch（前后端理解不同） | v4 frame 失败 | H1 spec-driven + 严格 pydantic/zod schema |
| ZCode 内部逻辑死掉的边界 | UI bug | 4+ 人分路，每个 H 都跑 vitest |
| 大文件 merge 冲突 | 工期 | 拆模块并行 |
| Big bang 切换期断线 | 用户感知 | 1) H3 起 SSE+WS 并行 fallback；2) 切换时加 feature flag |
| 旧 DB 数据迁移错 | 历史消息丢 | H4 启动一次性脚本 + dry-run + 备份 |
| 业务模块挂不上 v4 shell | 业务功能丢 | H6 严格验收清单 + 自动化回归 |

## 8. H1 demo 范围（今天 + 后续 1–2 周）

**H1 demo 必须可见**：
1. 打开 ChatApp，**点击开关**切到 v4 MiniSessionPane 视图
2. 在新 session 发一条 user 文本 → 接收 LLM 返回 → 在 MiniSessionPane 看到 streaming 文字 + reasoning + tool_call
3. 切换到旧 MessageVirtualList → 同样功能
4. 二者**视觉 + 功能一致**

**H1 demo 不做**：
- 旧 SSE 路由迁移
- ChatApp 命令派发层重写
- DB 数据迁移
- 业务面板切换

## 9. 团队分工（建议）

| 角色 | 任务 | H1 工作量 |
|---|---|---|
| 后端 v4 协议 owner | protocol_v4.py + conversation_projection.py + routers.py | 1–2 周 |
| 前端 v4 shell owner | lib/v4/*.ts + components/v4/*.tsx | 1–2 周 |
| 业务迁移 owner（启动 H6 起） | 业务面板适配 | H6 起 2 周 |
| 数据迁移 owner（启动 H4 起） | DB schema + 迁移脚本 | H4 起 1 周 |

## 10. 验收指标

- 闪烁：从 ZCode 经验是 0（每条 SSE delta → 单帧 projection 替换，绝不每条重渲染 row 树）
- streaming throughput：跟 ZCode 持平（每条 delta 200ms 节流，单次 React rerender）
- 启动时间：保持 EvoFlow 现水位（<2s）
- 内存：historyItems + projection store 全部入 v4 单一原子 store
- DB 兼容：旧 session 启动时一次性迁移，新 session 从 logEpoch=1 开始

## 11. 决策记录

- 2026-10-08：用户确认走 big bang + ASAP 迁移 + 4+ 人团队。先做 H1 demo。
- 2026-10-08：Phase E 暂存。MiniSessionPane 替代 MessageVirtualList 作为 H1 第一刀。