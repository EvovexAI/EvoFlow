# V4 流式链路对齐手册（EvoFlow ↔ ZCode 协议）

> 日期：2026-10-22。本文是主聊天流式链路切换到 ZCode v4 协议后的**对齐与验收手册**：
> 三侧日志键、开关、数据流、已知 v1 简化、验收步骤。
> 协议背景与五层设计哲学见 `D:\dev\github\zcode-streaming-architecture.md`。

## 一、数据流（改造后）

```
LangGraph 上游 SSE
  → AgUiStreamNormalizer（AG-UI wire，旧链路不动）
      ├─→ 老链路（默认）：post_stream_ui_normalize → evopanel stream-turn-engine（16ms bump）
      └─→ v4 镜像（新）：agui_mirror 把 AG-UI 事件翻译成 ZCode 协议 delta
            → V4ConversationHub（seq 权威分配 + 保留窗 2000 条 delta 日志）
            → 每订阅者 flush 缓冲（coalesce 合并 + 30ms/150ms 定时打帧）
            → GET /api/v4/conversation/frames（SSE，ConversationTopicWireCandidate）
            → evopanel EvoFlowV4Transport（解包 candidate.frame）
            → verbatim ConversationProjectionStore（fromSeq 衔接才 apply，行引用隔离）
            → V4StreamRowsBridge（叶子桥组件：useSyncExternalStore 按帧订阅，
              frame 更新只重渲染桥的 children 子树，不牵动 ChatApp 控制器）
            → V4ZCodeTimeline（**ZCode ConversationTimeline 直接挂载**：轮分组/
              工具卡排布/Streamdown 流式/虚拟化/贴底滚动——ZCode 显示区域的正式实现，
              协议原生行零适配；宿主只装配 ZCodeIntlProvider + 稳定 rowContext）
```

镜像挂钩点（AG-UI 事件的三个产地，全部失败静默不碰生产流）：
- `backend/app/gateway/agui_stream_normalizer.py` — `AgUiStreamNormalizer.feed_frame/finish/bootstrap_wire_bytes`（POST 主路径 + inject）
- `backend/app/gateway/routers/langgraph_proxy.py` — `_attach_ui_wire_frame`（刷新续挂）
- `backend/app/gateway/streaming/stream_resume_langgraph_tail.py` — `_enqueue_mirror_wire_frames`（断连尾流）

用户输入文本：`post_stream_ui_normalize.py` 构造 normalizer 时经
`mirror_note_user_input(thread_id, text)` 预记，`RUN_STARTED` 时随 turnHeader 落 userInput 行。

## 二、开关

| 开关 | 位置 | 默认 | 说明 |
|---|---|---|---|
| `EVOFLOW_V4_MIRROR` | 后端 env | 开（`0`/`false`/`off` 关） | AG-UI → v4 镜像总闸 |
| `EVOFLOW_V4_ROUTES` | 后端 env | 开 | `/api/v4/conversation/*` 路由挂载 |
| `?chatV4=0` | 前端 URL | — | 显式退回老链路（**默认开启**，无需任何设置） |
| `localStorage.evoflow_chat_v4 = "0"` | 前端 | — | 常退老链路 |
| `localStorage.evoflow_v4_debug = "1"` | 前端 | 关 | 逐帧 `[v4-rx]` 日志 |
| `EVOFLOW_V4_DEMO` | 后端 env | 关 | H1 demo 路由（与本次无关，保持原样） |

会话映射：**v4 session id = LangGraph thread_id**（1:1）。客户端按
`conversation/{threadId}` 订阅；面板只在会话已有 threadId 时启用（新会话首问落库后切）。
双轨语义：**V4 面板是只读投影**——composer/发送/权限等仍走旧链路，其结果经镜像进投影。

## 三、三侧对齐日志（逐帧对账用）

同一帧在三侧的锚点：`topic` + `fromSeq→toSeq` + `deltas[].op`。

| 侧 | 日志键 | 内容 | 时机 |
|---|---|---|---|
| 后端 | `[v4.author]`（DEBUG 级） | session / ops 数 / seq 水位 / 订阅者数 | 每次镜像写入 |
| 后端 | `[v4.flush]`（INFO 级） | `session= sub= fromSeq->toSeq ops=N (raw=M, XKB) profile=continuous\|replayable`；snapshot 行 `rows= kind=initial\|recovery` | 每次 flush/快照/溢出恢复 |
| 前端 | `[v4-tx]`（console.info） | `subscribe {topic}`（含 base）/ `resync` / `unsubscribe` / sse 连接 | 订阅生命周期 |
| 前端 | `[v4-rx]`（console.info） | `{topic} {deliveryKind} {fromSeq->toSeq} ops=N`；`evoflow_v4_debug=1` 时逐帧 | 每帧到达 |
| 前端 | `[v4-store]` + logger.lifecycle `v4.conversation.store.*` | connect/断档恢复/snapshot apply（verbatim store 自带） | store 状态机 |

**对齐方法**：抓一轮对话，按 topic 聚合——
1. 后端 `[v4.flush]` 的帧序（fromSeq→toSeq 连续，snapshot 除外）；
2. 前端 `[v4-rx]` 应逐帧一致（帧是原样透传的 JSON）；
3. 前端 `[v4-store]` 无断档告警 = `frame.fromSeq === snapshot.seq` 全部衔接；
4. 终态一致性：`GET /api/v4/conversation/rows_range`（sessionId=threadId, limit=200）拿权威行集，
   与前端 `store.getState().snapshot.rows.window` 逐行对比（rowId/_kind/state/text 末 50 字符）。

## 四、改动清单

**后端（全部在 `EvoFlow/backend/`）**
- `app/gateway/v4/coalesce.py`（新）— ZCode coalesce.ts 规则 1-4 移植（黄金用例已过）
- `app/gateway/v4/conversation.py`（重写 hub）— authoring API（author_append_row /
  author_row_delta / author_upsert_row / author_state_patch，seq 权威分配 + 2000 条保留窗）、
  每订阅者 flush 缓冲（500 ops / 1MiB 溢出 → recovery snapshot）、coalesce 打帧、
  subscribe(base) → mode:"resume"、死订阅者队列上限保护、`[v4.flush]` 日志；
  demo echo/LLM 回合迁到 authoring API
- `app/gateway/v4/agui_mirror.py`（新）— AG-UI → ZCode 协议翻译：文本/推理走
  `row.delta(path:"text")`、工具参数走 `row.delta(path:"inputText")`、状态迁移才
  `row.upserted`、userInput 行、CUA display 块（`output.display` kind:"cua"）、
  错误走 row 顶层 `error`（协议形状 = toolDisplay.ts toolOutputSchema）
- **轮尾文件变更卡 + 真实工时（对照 ZCode 实际 DOM 补齐）**：用户贴来 ZCode 渲染 DOM 对比后定位三处数据缺口——①轮尾「N 个文件已更改 +A/-D」卡片 = `turnHeader.fileChanges`（此前从未产出）；②「已工作 X 分 X 秒」需要真实轮起止（此前 hydration 写的是同一时刻=0 秒，mirror FINISHED 用 now）；③工具卡 +N/-N 计数（args 解析，已具备）。修复：mirror 在 RESULT 时聚合写类工具变更（turn_file_changes）、RUN_FINISHED 的 turnHeader 用 RUN_STARTED 记录的真实 startedAt + fileChanges；hydration 两遍构建（header 最后 author，rowId 先分配保排序），时间取 display 路径 turn_started_at/turn_duration_ms 或 raw 路径 created_at（ISO 解析）。实测：live 工时真实间隔 + fileChanges 正确；真实库 80 轮头 22 个带 fileChanges（5 文件 +222/-0，工时 17.7 分钟）。
- **Edit/Write 可点击 diff（2026-10-22 深夜补齐）**：ZCode 契约是 CLI 端算好 diff 放进
  `output.display`（kind:"file_diff" + structuredPatch 的 unified 行），客户端
  EditInlineDiffContent 渲染上下两段代码——此前镜像只发 `{text}` 所以卡片没有 diff。
  现在 mirror 在 TOOL_CALL_RESULT 时从累计 args（strict=False 容忍控制字符）解析
  old/new，`build_file_diff_display` 产出 patch（纯 -/+ 块，>800 行截断标 truncated，
  toolName 用 START 时记录的——RESULT 事件可能不带名字）；hydration 历史写类行同样
  补齐（真实库 238/238 行带 diff）。前端零改动——工具名→file-write 族→Edit 渲染器
  的分发链（resolveRenderer/toolIdentity）本来就认
- `app/gateway/v4/routes.py` — subscribe 透传 `clientMode`（30ms/150ms 档位）
- `app/gateway/router_registry.py` + `app.py` — 挂载 v4 conversation 路由（此前
  `install_v4_routes` 从未被调用 = H3-B 一直 NOT MOUNTED 的根因）
- `agui_stream_normalizer.py` / `langgraph_proxy.py` / `stream_resume_langgraph_tail.py` — 三处镜像挂钩
- `post_stream_ui_normalize.py` — 用户文本预记

**前端（全部在 `EvoFlow/evopanel/src/react/`）**
- `v4/evoflowV4Transport.ts`（新）— SSE transport，实现 ConversationTransport 流式子集
  （subscribe/activate/resync/unsubscribe/onFrame/rowsRange/sendCommand），
  ACK 前帧暂存 + activate 释放，其余方法 fail-fast
- `v4/V4StreamRowsBridge.tsx`（新）— 叶子桥组件：SessionDataLayer + ConversationProjectionStore
  （vendor 树的**无 UI 协议客户端**）+ useSyncExternalStore，render-prop 交付
  **协议原生快照**（rows.window 零适配）。frame 更新只重渲染桥的 children 子树，不牵动控制器
- `v4/V4ZCodeTimeline.tsx`（新，2026-10-22 深夜定稿）— ZCode ConversationTimeline 直接挂载
  （用户拍板"直接拿过来，再多拿点也行"）：轮分组/工具与正文排布/Streamdown 流式/
  虚拟化/贴底滚动全部来自 ZCode 显示区域正式实现，解决旧适配路线的三个问题
  （正文流式不丝滑、滚动条/贴底不对齐、工具与正文排布乱）。宿主装配：
  ZCodeIntlProvider（裸挂 zh-CN）+ 稳定 ConversationRowRenderContext
  （workspacePath=""、theme:"system"、DEFAULT_CODE_PREVIEW_SETTINGS）+
  canLoadOlder/onLoadOlder 接 store.loadOlder（hasOlderRows 判定）；
  回调类能力（编辑/重试/fork/反馈）v1 不接，显示侧为只读投影
- `v4/v4Gate.ts`（新）— 双轨开关（?chatV4=1/0 或 localStorage.evoflow_chat_v4）+
  闸门事件集（TEXT_MESSAGE_*/REASONING_*/TOOL_CALL_ARGS）
- `chat-app/view/chat-app-view.tsx` — 消息区包 V4StreamRowsBridge，**全量启用（深夜二轮，
  用户拍板"直接只用这一套"）**：开关开（默认）时任何状态都不回落——ready=完整时间线、
  connecting=ZCode 空态+"V4 连接中…"、草稿=空态+底部输入框（composer 无 home 门控）；
  仅 `?chatV4=0` 走老面板。sessionId 优先取服务端 sessions 列表 threadId
  （wsClient.getSessionThreadId 读浏览器本地 session map，纯开历史为空——已修）
- **ServiceProvider 缺失崩溃（已修）**：全量启用后 `AssistantPreviewCards`（轮尾预览卡，
  TurnGroup 为带 @@产物@@ 标记的轮尾文本渲染）经 useWorkspaceServices→useServices 抛
  "必须在 ServiceProvider 内使用"。补丁：useWorkspaceServices.tsx 的 resolution/base 两入口
  改 `useOptionalServices() ?? STANDALONE_STUB_SERVICES`（Proxy 访问器，任意服务解构为
  undefined；ZCode 宿主 Provider 在场时行为不变），AssistantPreviewCards 校验 hook 在
  fileService 缺席时跳过 stat 校验（无需校验的卡照常显示）。代价：V4 视图内产物预览卡
  （@@文件@@ 自动校验展示）暂不出现——需要接真实 fileService 后恢复
- `chat-app/stream/create-chat-ws-on-event.ts` — AG-UI 事件入口分流闸门：flag 开启时
  逐 token 显示事件**不再进老数据管线**（streamRef/rt.rows/bump —— 嫌疑 1 的 60fps×O(n)
  由此消失）；TOOL_CALL_START/END/RESULT 与 RUN_*、平台事件照走（审批/工件/plan/协作）

**轮尾文件审查卡（2026-10-22 深夜四轮）**：「N 个文件已更改」卡片展开的 per-file diff
走 ZCode 的 `v4/conversation/fileChanges` 查询——此前 transport 是 throw 桩、后端无数据源。
已实现：hub.file_changes(sessionId, rowId)（按 turnHeader 聚合同轮写类工具行的
output.display file_diff → items[path]{additions,deletions,writeCount,toolNames,patches}，
patches 复用 structuredPatch hunk）+ POST /api/v4/conversation/file_changes 路由 +
transport.fileChanges 实装 + rowContext.fetchFileChanges 接线（闭包经 ref 读最新快照水位，
rowContext 跨帧稳定）。实测 +3/-2 与 patch 行全对。撤销按钮（fileRewindPreview/apply）
仍未接——需要 v4 command，点击无效果。

**交付卡对齐 ZCode（2026-10-22 深夜三轮，用户拍板"不要用 @@"）**：
1. **文本约定切换**：`prompt_blocks_zh/en.py` 的 ARTIFACT_DISPLAY_BLOCK——文件交付从
   `@@路径@@` 改为 **Markdown 链接 `[名称](相对路径)` / 反引号路径**（ZCode 的
   extractAssistantFileReferences 识别四种：citation 指令 / md 链接 / file:// URL /
   定界路径；@@ 不在其中所以此前卡片不出现）。注意：模型需要**新一轮对话**才吃到新提示词。
2. **fileService 补齐**：V4ZCodeTimeline 挂 ServiceProvider，partial 访问器实现
   `checkFilesExist`（GET /api/workspaces/resolve-target?thread_id=…&path=…，exists+非目录；
   实测真实文件 True/缺失 False；**必须带 thread_id**——不带报 400）；按 session 建、切换重建。
   此前 stub（全 undefined）导致 stat 校验跳过、卡片不显示——现在 stat 校验走通。
3. 顺带修队友并行改动漏的类型：stream-compare-file-log.ts dump 返回类型补 `v4UiDisplay: string[]`。

**历史会话（hydration）**
- `app/gateway/v4/hydration.py`（新）— hub 首次订阅冷会话时，把持久 transcript
  （display 仓 → archive → 直读 `evoflow_chat_messages` 三级回退）映射成 v4 行：
  LangGraph payload 形状（assistant 的 reasoning/tool_calls 含参数、user 块数组、
  tool 结果按 tool_call_id 回填），run_id 分组成轮。真实库实测：2195 条消息 →
  1925 行 / 155ms，幂等，快照/续传正常

**v4 行 → 老组件富显示对齐（2026-10-22 晚）**
- 状态映射修正：老约定里 args 阶段 status 也是 `'running'`（`isToolRunning` 只认
  running/in_progress，lib/chat-normalize.js:4765），阶段差异用 `_aguiPhase`
  （args/running/done）表达——此前 inputStreaming 映成 status:'args' 会让卡片不亮运行态。
- 齿轮（已工作 N 秒）：锚点 = reasoning 段 `startedAtMs`（取最早）+ 工具
  `_uiStartedAtMs`（MessageRow turnStartCandidateMs）；适配器已补 reasoning 段时间戳；
  触发纯 row-driven（`row.state==='streaming'`，MessageRow.tsx:807），不依赖 isSending/streamRef。
- Write/Edit 流式实时预览 `_writeProgress`：从 agui-turn-reducer 移植 partial-args
  提取（`extractPartialJsonStringField` 已导出复用），从半截 JSON 提
  path/old_string/new_string 算 +N/-N 行；write 工具名单补了 edit/edit_file。
- 思考块/流式光标：segments（kind reasoning 带 startedAtMs/endedAtMs）+
  `row.state==='streaming'` 驱动 ReasoningInlineBlock 与光标，纯 row 字段。
- v1 未投影：ACTIVITY_SNAPSHOT（「生成中…」环节文案——齿轮时长有、环节文案无）；
  后续可把 activity 镜像进 state.updated。

**v4_delta 语义要点（对齐 ZCode，测试已覆盖）**
- 快照帧 `fromSeq=0`；delta 帧 `(fromSeq, toSeq]` 区间记账，客户端 `fromSeq===seq` 才 apply；
- `row.upserted` 吞同 rowId 的前置 `row.delta`（整行替换蕴含追加）→ 每轮终态只有
  appended + 少量 upserted，无 O(N²) 全行重发；
- subscribe 带 base 且 base 在保留窗内 → `mode:"resume"` 单帧续传；否则全量 snapshot；
- 订阅者缓冲溢出/队列超限 → `deliveryKind:"recovery"` 全量 snapshot（永不无界积压）。

## 五、v1 已知简化（不影响协议正确性，后续按需补）

1. **无 inputText 预览节流**（ZCode 对 Write/Edit 有 1000ms 服务端窗）——coalesce 已把
   相邻 delta 合并，30ms 窗内最多一条；若参数超长再考虑加窗。
2. **无 binary wire 分帧**（wire-codec 1MB 物理切帧）——SSE 直发 complete 逻辑帧；
   帧超 1MB 的场景（超长工具结果）暂未遇到，遇到再加。
3. **无 pendingInteractions / queue / guide 投影**——state patch 只含 control；
   权限审批仍走旧链路 UI。
4. **queryCommands 未实现**（schema 要求非空 results）——store 的 ACK 对账走不可用路径。
5. **panel 侧栏/usage 指标未接**——usage 恒 0；侧栏仍用旧接口。
6. **resume 只在保留窗（2000 delta）内**——超窗回退全量 snapshot，语义仍正确。
7. **老组件内 1s 计时器未合并**（报告嫌疑 2）——复用 MessageRow/ToolCallList 意味着
   每行各自的 1s interval 还在；建议后续小手术：把 N 个计时器合成 timeline 级共享时钟。
8. **新会话首发消息的最初 token 可能无显示**——V4 面板要等 threadId 分配
   （POST 返回 metadata）后订阅；正常 <1s，期间文本事件被闸门跳过。

## 六、验收步骤（本机）

```bash
# 1) 后端单测（已全绿）
cd backend && python - <<'EOF'
import sys; sys.path.insert(0, '.')
from app.gateway.v4.coalesce import coalesce_conversation_deltas   # 黄金用例
EOF

# 2) 起网关，验证路由
#    POST /api/v4/conversation/subscribe {connectionId, topic:"conversation/<threadId>", clientMode:"desktop-continuous"}
#    GET  /api/v4/conversation/frames?connectionId=...  （SSE）
# 3) 前端：evopanel 起 dev（V4 默认开启），发一条消息：
#    - 后端日志出现 [v4.flush] 序列（30ms 窗，continuous 档）
#    - DevTools console 出现 [v4-tx] subscribe / [v4-rx] 逐帧（evoflow_v4_debug=1）
#    - 面板出现流式文本/工具卡/思考块
# 4) 刷新页面：store 携 base 重订 → mode:"resume" 或全量 snapshot，会话无损恢复
```

## 七、回滚

三处挂钩全部 try/except 静默 + 镜像总闸 `EVOFLOW_V4_MIRROR=0`、路由闸
`EVOFLOW_V4_ROUTES=0`、前端 `?chatV4=0` 即完全回到旧链路。老链路代码零改动。
