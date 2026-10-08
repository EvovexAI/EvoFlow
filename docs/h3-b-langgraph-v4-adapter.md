# H3-B 方案 — LangGraph 主对话流 → v4 projection

> 2026-10-08 探索后整理。**未实施**，等审过再写代码。

## 目标

让 EvoFlow **主业务对话**（ChatApp 当前真实在跑的会话，不只是 H1 demo 右下角）也能产出 v4 projection frames，最终由 `EvoFlowV4SessionPane` 渲染。

最终收益：
- H1 demo 的 echo + 真实 LLM 流验证可"扩展"到 ChatApp
- 业务面板可一刀切到 `EvoFlowV4SessionPane`（保留多 agent 框 + 多模态渲染）

## 当前主对话链路（2026-10-08 探索确认）

```
User (ChatApp)
  ↓ fetch SSE
evopanel/src/react/ChatApp.tsx
  ↓
subagent-stream-merge.ts / stream-console-mirror.ts
  ↓ (主入站)
backend/app/gateway/routers/langgraph_proxy.py
  └─ /api/chat/sessions/{key}/run-active        — 启动一次 run (DB 标记)
  └─ POST /langgraph/threads/{tid}/runs/stream — 透传到 LangServe
      内部：_heartbeat_sse_stream 包一层（防 60s idle 断）
  ↓
LangServe lead_agent graph (backend/langgraph.json 注册)
  ↓ SSE astream events (LangGraph wire shape: values/messages/events/updates)
backend/app/gateway/streaming/stream_resume_langgraph_tail.py
  └─ stream_format='agui' 默认
      → agui_stream_normalizer.py (832 行) translate to AG-UI wire
      → emit_evf_frame 推 SSE 给 ChatApp

并行：
backend/app/gateway/streaming/stream_mirror_background.py
  └─ 默认 off (EVOFLOW_STREAM_MIRROR=0)；resume poll evoflow_chat_messages
```

**关键事实（2026-10-08 探索发现）**：
- `agents.py` 1417 行**完全没有** `astream`/`astream_events`/`chat_messages` 引用 — 那是 admin/util router
- `chat_sessions.py` 1784 行也没 send_message —— 入站在 `langgraph_proxy.py`
- 主对话的 SSE 是 **AG-UI wire 形状**（不是 v4 row）
- 前端只有 1 个 v4 引用：`MiniSessionPane` 在 ChatApp.tsx 第 66 行；`EvoFlowV4SessionPane` 完全没挂载

## v4 projection writer 已有的能力（H3-A 落地）

`backend/app/gateway/v4_demo/projection.py` `ConversationProjectionWriter`：
- `emit_row_appended(sub, row)` — 新 row
- `emit_row_upserted(sub, row)` — upsert row
- `emit_row_removed(sub, row_id)` — 删 row
- `drain_pending(sub)` — 订阅消费
- 状态：`rows_by_id`、`seq`、`next_row_id`

## AG-UI → v4 row kind 映射表

| AG-UI wire event | 当前源 | v4 row kind | 备注 |
|---|---|---|---|
| `event: RUN_STARTED` | stream_middle_layer | `turnHeader` (`state=running`, `origin=userInput`) | 新 turn 开始 |
| `event: TEXT_MESSAGE_START` | agui_normalizer | `assistantText` (`state=streaming`, `text=""`) | 创建空 row |
| `event: TEXT_MESSAGE_CONTENT` | 同上 | `assistantText` (`state=streaming`, `text=累计`) | upsert 累计 text |
| `event: TEXT_MESSAGE_END` | 同上 | `assistantText` (`state=complete`, `text=终态`) | 终态 |
| `event: TOOL_CALL_START` | 同上 | `toolCall` (`status=running`) | 新 toolCall row |
| `event: TOOL_CALL_ARGS` / `_END` | 同上 | `toolCall` (`status=running`/`complete`) | upsert args + 终态 |
| `event: TOOL_CALL_RESULT` | 同上 | `toolCall` (`status=complete`, `output=...`) | 终态 + 结果 |
| `event: STATE_SNAPSHOT` | values 帧 | （无对应） | 仅 DB 落库，不上屏 |
| `event: RUN_FINISHED` | stream_middle_layer | `turnHeader` (`state=completedSuccess`/`completedError`) | 终态 turnHeader |
| sub-agent 文案 | 嵌套 TEXT_MESSAGE | `agentMessage` (新加 row kind) | **需 projection 新加 kind** |

**缺口**：`ConversationProjectionWriter` 不区分 sub-agent 当前在 emit 主；新增 `agentMessage` row kind 涉及：
- 后端 zod protocol 副本（`evopanel/src/react/v4/protocol/zcode-protocol-v4/`）
- `EvoFlowV4SessionPane` 渲染分支（当前只看 4 种 kind）

## 候选实现边界

### 选项 A — 新建 `backend/app/gateway/v4/langgraph_v4_adapter.py`

- **不动** `agui_stream_normalizer.py` / `langgraph_proxy.py`
- 在 `stream_resume_langgraph_tail.py` 的 `convert_evf_frames_to_agui` 调用**之后**挂一个旁路 consumer：
  - 同样 input frames
  - 走新的 `agui_to_v4_projector.py`，产生 v4 deltas
  - 写到 `ConversationProjectionWriter`（per-session 实例，存内存 + 可选 DB）
- SSE 给前端：开新通道 `GET /api/v4/sessions/{sid}/stream`（不走现有 ChatApp SSE）

**优点**：
- 隔离干净，AG-UI 主路径零回归
- H3-A 验证机制延续（MiniSessionPane-style）

**缺点**：
- 双 channel 并发同步难；用户必须切 UI 才能看 v4
- 没真正接入 ChatApp；H3-B 出来还是个 demo

### 选项 B — 在 `agui_stream_normalizer.py` 内部加 v4 emit 钩子 ✅ 推荐
- **保留** AG-UI SSE 不动（现有 ChatApp 不受影响）
- 在 `convert_evf_frames_to_agui` 同位置调 `convert_evf_frames_to_v4_projection()`
- **两路并出**：ChatApp 仍收 AG-UI（兼容旧渲染）；新端点 `/api/v4/sessions/{sid}/stream` 也收 v4 frames
- 让 ChatApp **逐步切到 v4**（feature flag 控制 session 级别）：
  ```python
  if session.metadata.get('v4_render'):  # 业务面板可选
      emit_v4_frame(...)
  ```

**优点**：
- AG-UI 主路径兼容；零改动 langgraph_proxy.py
- per-session 切换；可以 A/B
- 后续 H3-C 复刻 ZCode SessionPane 时，已能拿到真业务 v4 frames

**缺点**：
- `agui_stream_normalizer.py` +832 行已重；加一个同位置 emit 增加心智负担
- 双 projection 需保证 seq 同步（共用 writer 实例即可）

### 选项 C — 改写 `langgraph_proxy.py` 不再透传 + 直接跑 v4
- **否决**：会破主对话；H3+ 阶段再来

## 推荐实现路径（选项 B）

### H3-B-1：v4 projection writer 升级
文件：`backend/app/gateway/v4_demo/projection.py`
- 新增 `agentMessage` row kind 支持（仅数据 shape 调整，不改 zod verbatim）
- 新增 `run_started/run_ended` 元事件 emit（可选，用于 turnHeader 自动开合）
- 新增 `ConversationProjectionWriter.per_session_writer(session_key)` 工厂方法（per-session 单例，跨请求共享）

### H3-B-2：AG-UI → v4 translator
文件：`backend/app/gateway/v4/agui_to_v4_projector.py`（新）
- `convert_agui_sse_chunks_to_v4_deltas(chunks, writer) -> list[TopicFrame]`
- 复用 `agui_stream_normalizer.py` 的 parse 逻辑（提取纯函数 `parse_agui_event(line)`）
- 跟踪 `text_message_id` → `rowId` 映射（同一 message 多个 content frame 累计）
- 跟踪 `tool_call_id` → `rowId` 映射

### H3-B-3：双 emit 集成
文件：`backend/app/gateway/streaming/stream_resume_langgraph_tail.py`
- 在 `convert_evf_frames_to_agui` 之后调 `vt4_pack = convert_agui_sse_chunks_to_v4_deltas(...)`
- 通过 feature flag (`EVOFLOW_V4_PROJECT=1` 或 per-session metadata) 启用 v4 emit
- v4 frames 通过内存 channel 推到 SSE endpoint `/api/v4/sessions/{sid}/stream`

### H3-B-4：SSE 端点
文件：`backend/app/gateway/routers/v4_sessions.py`（新）
- `POST /api/v4/sessions/{sid}/new` — 创建 v4 projection writer 实例（per-session）
- `GET /api/v4/sessions/{sid}/stream` — SSE 推送 v4 frames
- `POST /api/v4/sessions/{sid}/snapshot` — 当前 snapshot
- 共用 `H1DemoOrchestrator` 单例结构（不依赖 H1 demo）

### H3-B-5：ChatApp 接入点
文件：`evopanel/src/react/ChatApp.tsx`
- 新 `useV4ChatSession(sessionId)` hook：feature flag 时挂 `EvoFlowV4SessionPane`（仅 patch 渲染层）
- Composer sendCommand 接 `EvoFlowV4Transport.sendCommand` — **转 H3-C**

## 风险清单

| 风险 | 缓解 |
|---|---|
| 双 emit seq 不一致导致 UI 跳变 | 共用 `ConversationProjectionWriter` 实例；v4 writer 只读，不污染 AG-UI writer |
| `agui_stream_normalizer.py` 832 行复杂，难以提取 parse 函数 | H3-B-2 阶段先做一次 refactor（小 PR），单独验证 |
| sub-agent 文案当前嵌在 TEXT_MESSAGE 流里 | H3-B-1 升级 projection 支持 `agentMessage` row kind；暂时不区分来源，标 `origin='subAgent'` |
| 历史 thread 拉历史帧（用户刷新 / 新窗口打开） | 暂用 `live-run` snapshot（chat_sessions.py:958）+ replay writer 的最近 N 帧；正式持久化靠 H3-D（DB schema v4 row storage）|
| 多 agent 分支（lead_agent → tool_agent → ...） | v4 projection 只关心 row kind；多 agent 分支由 turnHeader `origin` 字段标识；H3+ 复刻 SessionPane 时再细分 |
| 性能：双 emit 在主推上跑 per-frame | 验证用 `cProfile`；FEAS key 点是 `parse_agui_event(line)` 提取后应该 < 0.1ms；不达标就 memoize |

## 工时估计（经验值）

| 任务 | 估时 | 备注 |
|---|---|---|
| H3-B-1 projection 升级 | 0.5d | 小 |
| H3-B-2 translator 新写 | 1-2d | 取决于 parse 函数复用 |
| H3-B-3 双 emit | 0.5d | 小 |
| H3-B-4 SSE 端点 | 0.5d | 抄 v4_demo/routes.py |
| H3-B-5 ChatApp 接入 | 1-2d | 需要在 sessionDataLayer 里选择 transport |
| 验证 + 回归 | 1d | 跑 ChatApp 主对话 + 对比旧 AG-UI |
| **合计** | **4.5–6.5d** | |

## 不在 H3-B 范围

- 复刻 ZCode `SessionPane.tsx` (4723) — H3-C
- DB schema v4 row storage + 历史迁移 — H3-D
- 业务面板切到 v4 (force selection E2E) — H3-E
- ChatComposer 接 v4 sendCommand — H3-C 同步

## 待拍板

1. 选项 A vs B vs C — **推荐 B**（隔离干净 + 渐进迁移）
3. sub-agent 文案要不要 H3-B-1 阶段就先支持 — 推荐支持（避免 H3-B-2 translator 写两次）
5. ChatApp 业务面板切到 v4 的 feature flag 命名 — `EVOFLOW_V4_RENDER` 或 session metadata `v4_render`