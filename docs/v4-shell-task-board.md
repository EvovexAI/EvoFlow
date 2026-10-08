# EvoFlow v4 Shell 任务看板(双 AI 协作用)

> **用途**:AI-A(本会话)与 AI-B(另一个 AI)共同推进 EvoFlow 主对话界面对齐 ZCode。
> 两个 AI 都必须读本文件领任务、做完更新「状态总表」和对应任务的「进度记录」。
> 背景与已完成工作见 `docs/h3-c-v4-shell-bringup.md`(必读,含架构与踩坑记录)。

## 协作规则(必读)

1. **领任务**:在状态总表把目标行改为 `进行中(AI-B 2026-10-08 22:50)`,谁先改谁得。
2. **文件所有权**:每个任务列了「可触碰文件」。只允许改自己任务列出的文件;
   需要越界时在进度记录里留言协商,不要直接改别人任务名下的文件。
3. **公共文件**:`docs/v4-shell-task-board.md`(本文件)谁都可以改,但只改状态表和
   自己任务的进度记录小节;`backend/app/gateway/v4/conversation.py` 归 AI-A(H3-B-3)。
4. **完成定义**:代码改完 + 验收标准全过 + 在进度记录追加一行结果,状态改 `已完成`。
5. **不提交 git**:除非用户明确要求;工作区共享,改完即生效(dev server 热更新)。
6. 测试基线:`cd evopanel && npx tsc --noEmit` 应保持 **43 个存量错误不变**
   (不允许新增);`npx vite build` 必须通过;`npx vitest run tests/v4-wire-conformance.test.ts`
   必须 3/3 通过。

## 状态总表

| # | 任务 | 优先级 | 状态 | Owner | 备注 |
|---|---|---|---|---|---|
| T1 | LangGraph 主对话流双 emit v4 frames(H3-B-3) | P0 | 进行中(AI-A 2026-10-08) | AI-A | 关键路径:真实业务对话跑进 v4 shell |
| T2 | abort/stop 命令(停止回合) | P1 | 待领 | — | 独立小任务,后端 hub 命令面 |
| T3 | 会话列表 → v4 sessionId 映射(点旧会话用 v4 打开) | P1 | 待领 | — | 前端为主 |
| T4 | sessions-index 通道(侧栏会话列表活性) | P2 | 待领 | — | 依赖 T3 方向确认 |
| T5 | 附件上传/读取/预览 | P2 | 待领 | — | attachmentPut/ReadV4 |
| T6 | slash 命令 + commandsService | P2 | 待领 | — | 命令目录查询 |
| T7 | 暗色主题验证与修复 | P2 | 待领 | — | 纯前端 |
| T8 | 错误降级打磨(桩拒绝 → UI 状态而非 console 错误) | P3 | 待领 | — | 前端 |
| T9 | workflow runs 只读面 | P3 | 待领 | — | 依赖 T1 落地后做 |

---

## T1 — LangGraph 主对话流双 emit v4 frames(H3-B-3)

**Owner**: AI-A(进行中)
**可触碰文件**:`backend/app/gateway/streaming/stream_resume_langgraph_tail.py`、
`backend/app/gateway/v4/agui_to_v4_projector.py`、`backend/app/gateway/v4/conversation.py`、
`backend/app/gateway/v4/langgraph_v4_bridge.py`(新建)、`evopanel/src/react/ChatApp.tsx`、
`evopanel/src/react/v4shell/*`、`docs/h3-b-langgraph-v4-adapter.md`
**目标**:让 EvoFlow 真实业务会话(现有的 LangGraph 链路)同时产出 v4 frames,
v4 shell 订阅业务 session 的 topic(`conversation/{业务sessionKey}`)即可看到真实对话。
**验收标准**:
1. 现有 AG-UI 渲染路径零回归(旧 UI 照常);
2. `EVOFLOW_V4_PROJECT=1` 时,v4 shell 订阅业务会话 topic 能看到用户消息、
   assistantText 流式、toolCall 行;
3. `npx tsc --noEmit` 无新增错误。

**方案**(按 `docs/h3-b-langgraph-v4-adapter.md` 选项 B):
- 在 `stream_resume_langgraph_tail.py` 的 `convert_evf_frames_to_agui` 之后旁路挂
  `agui_to_v4_projector.convert_agui_sse_chunks_to_v4_deltas`(H3-B-2 已写好);
- 投影结果写入 `conversation.py` 的 hub(新增 `ingest_row/ingest_state` 公共入口,
  session_id 用业务 session key,惰性建会话);
- feature flag `EVOFLOW_V4_PROJECT=1`(env)或 per-session;
- ChatApp 把当前业务 sessionKey 作为 `sessionId` 传给 V4ShellRoot。

**进度记录**:
- [AI-A 2026-10-08] 开始:探索 streaming tail 挂载点。

---

## T2 — abort/stop 命令

**Owner**: 待领
**可触碰文件**:`backend/app/gateway/v4/conversation.py`(仅 `send_command` 的
abort 分支与 `_run_turn` 取消逻辑)、`docs/v4-shell-task-board.md`
**⚠ 文件冲突**:T1 也在改 conversation.py——领这个任务前先看 T1 进度,等 T1 的
「hub ingest API」小节完成后再动,或只在前端 shim 侧做(envelope 转发)。
**目标**:v4 工具条的 Stop 按钮可停掉正在跑的回合。
**验收标准**:`running` 会话点 Stop → 回合中断 → 快照 phase 回 `completedInterrupted`
(或 draft),前端无报错。
**提示**:hub 已有 `sess.turn_task`(asyncio.Task),abort 命令 cancel 它并在
`_run_turn` 的 CancelledError 分支收尾成终态帧;UI 侧 stopTargetKind/canStop 已在
control 里。

**进度记录**:
- (待领)

---

## T3 — 会话列表 → v4 sessionId 映射

**Owner**: 待领
**可触碰文件**:`evopanel/src/react/ChatApp.tsx`(仅 v4ShellEnabled 相关分支)、
`evopanel/src/react/v4shell/V4ShellRoot.tsx`、`backend/app/gateway/v4/routes.py`
(可新增只读端点)、`docs/v4-shell-task-board.md`
**目标**:点击侧栏旧会话时,v4 shell 直接打开该会话(而不是固定 draft)。
**验收标准**:
1. 点旧会话 → v4 shell 显示该会话历史(需要后端把旧 thread/message 投影为 v4 rows,
   可在 `GET /api/v4/conversation/snapshot?sessionId=` 惰性迁移时做);
2. 新建对话仍走 draft 流程。
**提示**:ChatApp 已有 `selectedSessionKey` state;V4ShellRoot 已接收 `sessionId` prop。
旧消息 → v4 rows 的映射表在 `protocol-evolution-spec.md` §4。

**进度记录**:
- (待领)

---

## T4 — sessions-index 通道

**Owner**: 待领
**可触碰文件**:`backend/app/gateway/v4/`(新模块 sessions_index.py + routes 挂载)、
`evopanel/src/react/v4shell/evoflowAgentService.ts`(subscribeSessionsIndexV4 等三个方法)、
`docs/v4-shell-task-board.md`
**目标**:v4 侧栏/会话列表活性(zcode 的 sessions-index topic)。
**验收标准**:v4 shell 不再因 sessions-index 缺失报错;会话创建/更新能推动侧栏刷新
(EvoFlow 侧栏本身还是旧实现,先保证 v4 内部不再依赖缺失面)。
**提示**:schema 在 `@zcode/shared/zcode-protocol-v4` 的 sessions-indexTopicFrameSchema;
T1 的 hub 模式可复用。

**进度记录**:
- (待领)

---

## T5 — 附件上传/读取/预览

**Owner**: 待领
**可触碰文件**:`backend/app/gateway/v4/`(attachments 新模块)、
`evopanel/src/react/v4shell/evoflowAgentService.ts`(attachmentPut/attachmentReadV4/
attachmentPreviewSourceV4)、`docs/v4-shell-task-board.md`
**目标**:composer 附件按钮可用(选文件 → 上传 → 发送带附件)。
**验收标准**:附件上传后 sendText/createSession 的 attachments 引用能被后端接受;
附件预览 URL 可打开。
**提示**:v4 附件协议见 `@zcode/shared/zcode-protocol-v4` 的 V4AttachmentPut*;
EvoFlow 已有的上传端点在 `backend/app/gateway/routers/`(可复用存储层)。

**进度记录**:
- (待领)

---

## T6 — slash 命令 + commandsService

**Owner**: 待领
**可触碰文件**:`backend/app/gateway/v4/`(commands 新模块)、
`evopanel/src/react/v4shell/evoflowServices.ts`、`evopanel/src/react/v4shell/evoflowAgentService.ts`(queryConversationCommandsV4 真实化)、
`docs/v4-shell-task-board.md`
**目标**:composer 输入 `/` 弹出命令目录;命令查询返回真实台账。
**验收标准**:输入 `/` 出现命令列表(至少内置命令);发送 slash 命令不报错。

**进度记录**:
- (待领)

---

## T7 — 暗色主题验证与修复

**Owner**: 待领
**可触碰文件**:`evopanel/src/react/v4shell/V4ShellRoot.tsx`(主题初始化)、
`evopanel/src/style/*.css`(如需桥接变量)、`docs/v4-shell-task-board.md`
**目标**:v4 shell 在 EvoFlow 暗色模式下颜色正确(zcode 主题 token 与 evoflow 变量桥接)。
**验收标准**:暗色模式下时间线/composer/工具条无刺眼白底或不可读文字。
**提示**:zcode 用 `useTheme`(localStorage `zcode-theme` + documentElement class);
EvoFlow 有自己的主题体系(`src/style/variables.css`),需要桥接或初始化 zcode-theme。

**进度记录**:
- (待领)

---

## T8 — 错误降级打磨

**Owner**: 待领
**可触碰文件**:`evopanel/src/react/v4shell/*`、`docs/v4-shell-task-board.md`
**目标**:stub 服务的拒绝不再刷 console 错误,转为对应 UI 的空态/隐藏。
**验收标准**:`/#/chat` 加载后 console 无 `[v4shell] 尚未接入` 级别的重复报错;
相关按钮隐藏或点击给友好提示。
**提示**:优先处理 `clientScenesService`(推荐列表)、`zcodeSessionService.
readWorkspacePresentation`(workspace 目录)、`usageStatsService`、`codingPlanSubscriptionService`。

**进度记录**:
- (待领)

---

## T9 — workflow runs 只读面

**Owner**: 待领
**可触碰文件**:`backend/app/gateway/v4/`(workflow runs 新模块)、
`evopanel/src/react/v4shell/evoflowAgentService.ts`、`docs/v4-shell-task-board.md`
**目标**:会话里的 workflow run 卡片有数据(哪怕只读摘要)。
**验收标准**:含 workflow 的会话打开后 run 卡片不报错、显示摘要。
**提示**:依赖 T1(先有真实流);schema 见 conversationWorkflowRun*V4 系列。

**进度记录**:
- (待领)
