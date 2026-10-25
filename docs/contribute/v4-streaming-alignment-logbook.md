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

**审批交互回归（2026-10-22 深夜八轮，用户报告"授权弹窗没了"）**：根因 = ZCode 的审批走
pendingInteractions（未投影），老授权模块（ToolCallList 按钮 + onToolApprovalStable →
wsClient.postToolApproval）闲置。接法：V4ZCodeTimeline 扫描 rows 中 status=pendingApproval 的
toolCall 行 → 底部悬浮审批卡（标题/工具名/摘要/风险 + 批准/拒绝/全部批准）→ 复用
onToolApprovalStable（审批信息从行 output.text 的 _evoflow_tool/approval JSON 解析，
摘要/参数兜底用 inputText）。批准后端执行 → 结果经镜像回流 V4 行 ✓；老 handler 的
本地 patch/续流逻辑在 V4 模式无害（老 rows 不显示）。

**浏览器截图内联（2026-10-22 深夜二十一轮）**：浏览器工具（browser_navigate/click 等）
的截图结果 JSON 有 `image_url = /api/threads/{tid}/browser-snapshots/{sid}`（同源 API 直出
图片）。镜像 TOOL_CALL_RESULT 对 browser 工具解析该 URL → cua display media artifactUri
→ ZCode 工具卡内联渲染截图。电脑操作工具的截图同理（mirror 泛化处理任何含
browser_screenshot 类型的结果）。**前端零改动**——CUA 卡的 media 渲染走
artifactUri → browserScreenshotApiPath → apiUrlAsync 同源解析。

**审查 diff 视图对齐（2026-10-22 深夜十六轮，用户报"整行底色没对齐"）**：审查按钮打开的
patch 视图此前用 CodeViewer language:"diff"——只有字符高亮、没有 ZCode 的整行红绿底。
已换成 vendor 的 HighlightedLightweightDiffPreview（EditInlineDiffContent 同款：
整行 color-mix 底色 + inset 色条 + 彩色行号 + 按文件扩展名语法高亮）——
lines 用 getPlainTextPatchPreviewLines(patch)（剥 ---/+++ 头），theme 按
prefers-color-scheme 解析 darkTheme/lightTheme。至此审查视图与 ZCode 的
inline diff 渲染同源同款。

**文件审查卡「审查/打开」对齐（2026-10-22 深夜十五轮）**：审查按钮（openDiff →
onOpenCodeViewer type:"patch"）与打开按钮（OpenSplitButton →
buildChangeSummaryFilePreviewSource 的 **type:"file"** 源）此前都通到
onOpenCodeViewer，但 V4CodeViewerSidePane 对 type:"file" 只渲染"仅支持 patch"占位——
打开即见未对齐空面板；审查若 patches 为空则按钮 disabled（数据侧 hub.file_changes
已产 patches，重测确认）。修复：V4CodeViewerSidePane 对 type:"file" 源拉真实文件内容
（serve-file?path&thread_id → text → CodeViewer 按扩展名高亮）+ loading/error 态；
threadId 经 rightStage data 从 chat-app-view（wsClient.getSessionThreadId）穿到面板。
**审查仍无响应时的检查点：canReview = patches>0 && onOpenCodeViewer，按钮 disabled
即 patches 空——抓该轮 [v4.hydration]/fileChanges 响应发我。**

**左侧会话列表分组（2026-10-22 深夜二十一轮，被并行覆盖待重做）**：ShellSessionList
加了 groupedRecentSections（chats 按工作区分组头/员工 tab 按头像分组头 + 折叠）+ Fragment
import——**被并行重写覆盖丢失**（文件从 1483→1588 行，subagentEntries 消失）。
重做要点（结构已验证可行）：①recentVisibleRows 后加 groupedRecentSections useMemo
（chats: groups.length>1 时按 row.workspaceKey 分组、label 取 groups 匹配；employees:
按 proactiveAgentCodeFromSessionKey 分组、label 用 resolveEmployeeGroupLabel、组头
AssignedAgentAvatar）；②recent-list 内条件渲染分组树（折叠头+组内行），单组/聚焦组
保持平铺；③collapsedGroupKeys 本地 state + Fragment import。
**教训：ShellSessionList 也是多人热点文件——分组功能改完必须立即提交。**

**子代理入口接回完成（2026-10-22 深夜二十轮）**：按团队新形态接回——
V4ZCodeTimeline 加 subagentTasks/onOpenSubagentTranscript props；subagentEntries
（toolCall 行 ↔ subagentTasks 四键 resolve，同 ToolCallList 同键）经 ref 稳定性纪律
（subagentTasksRef/onOpenSubagentTranscriptRef，回调身份跨帧稳定）；底部入口条渲染在
div.zcode-bridge-root 内（ServiceProvider 后、绝对定位 bottom-2，与审批浮层同区不重叠）。
点击 → onOpenSubagentTranscript → rightStage subagentTranscript 面板（transcript 轮询
+ liveOutput 兜底）。v4Session 订阅面板（V4SessionPaneBridge）作为后续升级路径保留。

**v4Session 面板桥（2026-10-22 深夜十九轮，做了一半）**：
①新组件 `react/v4/V4SessionPaneBridge.tsx`——V4StreamRowsBridge + V4ZCodeTimeline readOnly，
按 childSessionId 订阅子会话投影（ZCode drilldown 同机制，数据已由镜像捕获）；
②render-right-stage-body 加 `v4Session` 分支（data.childSessionId）；
③chat-app-view 已传 subagentTasks/onOpenSubagentTranscript（623-624 行）。
**未完成（与团队并行重构撞车）**：V4ZCodeTimeline 正被重构成 renderToolCallApproval
回调挂 rowContext 的新模式（审批浮层已改为按行渲染），我此前加的 subagentTasks/
onOpenSubagentTranscript props 在重构中被移除，chat-app-view 的传参暂时悬空。
**接续点**：按团队新形态把子代理入口接回去——仿 renderToolCallApproval 的
context 回调模式（onOpenSubagentTranscript 挂 rowContext），入口条/工具卡点击 →
打开 rightStage `v4Session` tab（data.childSessionId = 子代理线程）。
子线程推导：collab 子任务 = `{lead}__sub__{subtaskId}`。

**框架迁移钥匙孔落地（2026-10-22 深夜十八轮，用户拍板"先搬框架再逐个填"）**：
`workspaceConnectionRegistry.ts` 加 **transport 覆盖注册表**（registerV4TransportOverride/
clearV4TransportOverride，按 workspace scope 键）——acquireWorkspaceConnection 命中覆盖时
用注册的 SSE transport 建/复用连接条目（同 refCount/keepWarm/dispose 语义），
agentService 全程不触碰；RegistryEntry.agentService 类型放宽为 | null。
evoflowV4Transport 模块级注册覆盖（workspacePath="" 键）。**这一把钥匙打开了整个
ZCode 侧栏框架**：SubagentSessionSidePane（61 行，V4PaneConversationProvider +
readOnly SessionPane，sessionId=子会话 threadId）等全部 vendor 面板现在可挂。
**下一步（新工作包）**：①右侧面板框架从 rightStageStore 平移到 ZCode 侧栏体系
（AnimatedSidePanePanel 54 props 属工作区 shell，对话侧栏用 SubagentSessionSidePane 模式）；
②子代理卡片点击 → SessionPane drilldown（sessionId=子代理 threadId，逐 token 流式）；
③逐面板填服务适配。**坑：RegistryEntry.agentService 非空类型要放宽；覆盖条目的
reuse/dispose 语义要与原函数对齐（refCount/keepWarm/stale 清场）。

**右侧面板体系审计（2026-10-22 深夜十七轮）**：对照 ZCode app-shell 侧栏体系逐项审计
EvoFlow rightStage。已修：codeViewer/subagentTranscript 加入 FORCE_MOUNT_KINDS（此前切
tab 卸载丢轮询/滚动状态；ZCode 按 tab 保活）。**未对齐清单（按工作量排序）**：
①file kind 仍渲染 WorkspaceFilePreviewPanel（EvoFlow 文件预览，非 ZCode CodeViewer）——
需在 V4 模式下换 ZCode 文件查看器（medium）；②tab 条 chrome 是 EvoFlow 自有样式
（react-chat-stage-tab），ZCode 用 AnimatedSidePanePanel（动画/owner 徽标/最近关闭）——
整体 UI 对齐是大项（large）；③"打开方式"下拉依赖 platform.getInstalledEditors（Tauri 能力），
独立宿主下降级为空（acceptable）；④tab 体系架构差异：EvoFlow rightStageStore（轻量 tab 栈）
vs ZCode workspaceSidePane 状态机（owner 域/路由/恢复）——架构级对齐属 v4 command 之后的大阶段。

**视频/音频内联渲染（2026-10-22 深夜十四轮，媒体对齐收口）**：ZCode 本来就有
MediaCodeViewerSource（type:"media"，kind audio/video，shared media-preview.ts 的
getMediaPreviewFormat 识别 11 种扩展）——只差三段接线：①getToolCallCodePreview 在 image
分支后加 media 分支（getMediaPreviewFormat 命中 → MediaCodeViewerSource）；②toolDisplay 的
ToolInlinePreview 加 media 变体 + toInlinePreview 映射 + genericMediaStrategy 注册
（nodeReplToolStrategy 后、genericImageStrategy 前）；③ToolCallBody 的 InlineMediaContent：
serve-file URL（root=workspacePath, path=preview.path）直接 <video controls>/<audio controls>
——**流式直出不走 base64**（Range 请求，大视频不撑内存）。
另：extractRawPath 补 JSON 字符串递归（media 工具把产物路径写在结果 JSON 里，
字符串直查字段永远 miss——顺带 absolute_path/local_path 进字段清单）。

**媒体图片内联渲染落地（2026-10-22 深夜十三轮三）**：media 工具的图片现在走 ZCode
原生的 InlineImageContent 内联预览——链路三件套：①vendor codeViewer.ts 的 image 门放宽
（原 `isDiffTool||isReadTool||isWriteTool` 家族门挡住 media 工具 → 改为按路径形态判定
isImagePreviewPath）；②宿主部分 fileService 补 `readMediaPreview`（fetch serve-file →
dataURL，返回 {path, mediaType, dataBase64, totalBytes}——InlineImageContent 消费该形状）；
③后端 serve-file 的 root 改可选（与 resolve-target 同款 thread_id 解析，实测 200）。
链路：getToolCallCodePreview 从 input.path 解析（rawInput 已桥接）→ extractRawPath 命中
→ InlineImageContent.readMediaPreview → serve-file。**视频/音频仍待接**（InlineImageContent
只渲染 img；media 源 video 需扩 <video>/<audio> 渲染或专用 strip）。

**微信摘要 + artifactUri 链路确认（2026-10-22 深夜十三轮二）**：微信工具
（wechat_chat/wechat_send/send_wechat_message）卡摘要对齐旧链路——镜像在
TOOL_CALL_RESULT 把 output.text 换成简洁一句（"消息已发送给 {contact}：{brief}"，
同 chat-normalize.js:2916 分支）；媒体图片的 artifactUri 链路确认可渲染：
NodeReplImageGrid → resolveBrowserScreenshotSrcAsync → browserScreenshotApiPath
（/api/ 前缀剥离 + apiUrlAsync 回填 base）→ serve-file，img 直接显示。
**视频/音频仍待接**（CUA 卡只有 img 渲染位，需扩展 <video>/<audio> 或专用 strip）。

**媒体工具图片对齐（2026-10-22 深夜十三轮，进行中）**：旧链路媒体 = media_image_generate/
media_task_wait/media_video_generate 的 JSON 产物（absolute_path/url）→ inferMediaAssetsFromToolEntries
→ 消息气泡 media strip。V4 对齐：镜像在 TOOL_CALL_RESULT 对媒体工具解析产物 →
`output.display = cua 块（media[].artifactUri = /api/workspaces/serve-file?root&path）`
——ZCode 工具卡原生内联渲染 CUA media 图片，前端零改动（toolCallRowAdapter 已透传 display）。
实测 artifactUri 正确。**未对齐剩余**：视频/音频（无内联渲染位，待扩展）、微信图标
（需确认旧渲染形态）、链接（Streamdown 已原生渲染，待用户确认差距点）。

**会话切换闪烁+抖动（2026-10-22 深夜十一轮）**：两个问题同根。①"先一屏黑字再看到历史"
= 切换瞬间 threadId 未解析/快照未到时回落老面板，老 rows（DB 历史加载）先渲染一屏老样式，
随后 V4 整树挂载——修复：回落条件从 `isHomeSurface`（V4 模式下老 rows 加载完才变 false，
必然闪一屏）收紧为 `!selectedSessionKey`（只有真首页/草稿走老面板）。②抖动 = 首次订阅
7s 冷导入触发看门狗 resync 双快照整树重挂——修复：hydration 模块链（chat/session_repositories
+ agui_mirror）预热挪到 `cold_start_prewarm.prewarm_gateway_before_event_loop`（事件循环前），
首订阅回百毫秒级，无双快照。重测需重启网关（预热在启动期）。

**workspacePath 根因（2026-10-22 深夜九轮，用户报"文件名显示 D"）**：DB 验证 args.path 是
完整绝对路径（数据无缺），真凶 = 宿主 rowContext.workspacePath 传了空串——ZCode 的文件
chip/摘要/diff 路径解析链全部依赖真实工作区根做相对化，空串让绝对 Windows 路径解析退化
成盘符 "D"。修复：V4ZCodeTimeline 加 workspacePath prop，chat-app-view 传
effectiveWorkspaceRoot（老面板 homeWorkspacePath 同源）。**教训：给 vendor 组件装配
rowContext 时，所有"宿主环境"字段必须给真实值，空串会静默改变解析行为。**

**Edit 工具卡全链路对齐（2026-10-22 深夜五轮）**：用户反馈参数/摘要/展开/右侧面板四处差距。
①桥接层 `toolCallRowAdapter` 的 raw 补 `rawInput`（解析后的参数对象）——fileSummaries 的
readRawToolCallInput 优先读它，缺了 Write/Edit 退化成整段 JSON 展示而非文件 diff
（fileSummaryTypes.ts:91 注释明确此退化）。②`onOpenCodeViewer` 接线：rowContext 补该字段
（edit.tsx 的文件 chip clickable 直接取决于它），V4ZCodeTimeline 加 prop，chat-app-view 传
`openMessageFilePreview(source.path, source.title)` → EvoFlow 右侧面板文件预览；
patch 源 v1 先打开目标文件，diff 视图待 right-stage 支持。

**子代理流式输出面板（2026-10-22 深夜十二轮，用户要求对齐 ZCode"点开子代理看全量流式"）**：
数据链全在旧代码——`GET /api/tasks/subagent/{task_id}/transcript`（SubagentExecutor 内存快照，
含 collab_subtask_id 解析）+ `messagesToSubtaskModalRows` + `SubtaskModalMessageRow` 渲染 +
`liveOutput` 流式兜底（旧 SubagentTranscriptModal 弹窗整链）。接法：新增右侧面板 kind
`subagentTranscript`（新组件 `v4-subagent-transcript-pane.tsx`：2s 轮询 + 贴底跟读 +
终态停轮）；V4ZCodeTimeline 扫 toolCall 行 ↔ subagentTasks（同 ToolCallList 的
resolve 四键：toolCallId/taskId/taskExecId/collabSubtaskId），命中即在底部入口条显示
「执行中/已完成 · 点击查看流式输出」→ 打开右侧面板。chat-app-view 传
threadPanelState.subagentTasks（task_* CUSTOM 事件未闸，数据照流）。
**坑：chat-app-view 是 @ts-nocheck——rightStageStore 忘了 import 不会报类型错，
运行时才 ReferenceError；@ts-nocheck 文件里新增全局符号引用必须自查 import。**

**右侧面板 diff 对齐（2026-10-22 深夜十轮）**：Edit 卡文件 chip 点击原走
openMessageFilePreview（EvoFlow 文件预览——无 diff 模式）。新增右侧面板 kind
`codeViewer`（right-stage-types 加标签"代码对比"；render-right-stage-body 分支渲染
新组件 `v4-code-viewer-side-pane.tsx`：头部文件标题+路径，内容用 vendor CodeViewer
以 language:"diff" 渲染 patch 红绿行）。chat-app-view 的 onOpenCodeViewer 改为
rightStageStore.show({kind:'codeViewer', data:{source}})——source 是 ZCode
CodeViewerSource（buildEditCodeViewerSource 的 patch 产物）。多文件 diff
（multi-file-diff 源）v1 未接。**踩坑：bash heredoc 里写 JS 正则会掉反斜杠层
（\→\→坏），正则字面量必须用 Edit 工具修。**

**右侧平台工具通知（2026-10-22 深夜六轮，用户报告"平台工具交互整块没了"）**：
梳理结果——旧链路右侧能力的触发点大部分在放行清单里（CUSTOM → applyRightStageAgUiCustom /
write_file_progress；TOOL_CALL_RESULT → publishArtifacts / platform 反馈 toast / applyStageSetFromToolCall；
CUSTOM thread_state → SessionSidebar）。**唯一断点 = TOOL_CALL_ARGS 被无差别闸掉**：
panel_set/stage_set/platform 工具的面板配置在参数里（TOOL_CALL_RESULT 分支从 aguiTurn 读
argsText → applyStageSetFromToolCall(argsText) 配置右侧面板），参数断流 → 面板配不出来 → 通知整块消失。
修复：闸门收窄（v4Gate.ts 重写）——TOOL_CALL_ARGS 只闸**文件写类工具**的重型参数流
（START 时登记工具名，ARG 事件不带名字），平台工具参数放行；TEXT/REASONING 维持全闸。
**放行清单**（旧链路继续承载的能力）：审批检测、工件发布、plan 检测、协作子任务、浏览器面板、
knowledge map、语音、桌面完成通知、平台反馈 toast、右侧面板配置。待接：工具参数流式预览
（platform 工具若未来有大参数流，按工具名单扩展闸门）。

**表格渲染切回旧版（2026-10-22 深夜七轮，用户拍板"只有表格这一处换回来"）**：
ZCode 表格（markdown-table.tsx 工具条+横向虚拟滚动）用户观感不如旧版壳。实现：变体开关——
`zcode-ui/components/ai-elements/markdownTableVariant.tsx`（context，默认 "zcode"）+
message.tsx 的 Streamdown `table:` 映射按变体切换（evoflow → 旧 MarkdownTableShell：
MD/CSV 复制 + 放大对话框 + 滚轮缩放；相对路径跨树引 react/components/StreamdownRenderer.tsx
——**三级 ../，四级会逃出 src**；该文件无 zcode-ui 依赖无环；ZCode 的 STREAMDOWN_CONTROLS
已 table:false 无双控件）+ V4ZCodeTimeline 挂 MarkdownTableVariantProvider value="evoflow"。
作用域精确：仅 V4 面板表格换壳，ZCode 宿主（SessionPane）保持 ZCode 表格。

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

## 八、批次记录：v3.15.1 命令层移植（2026-10-24）

上游 ZCode 同步到 v3.15.1（3c5b2276）后，将其 v4 原生命令层移植到 EvoFlow。
计划清单与逐项执行记录见 **[v3.15.1-port-plan.md](./v3.15.1-port-plan.md)**，此处只记要点：

- 服务端 `command_inbox.py`（新）+ `conversation.py` 重写 send_command：
  stop/abort、sendText requestedDelivery（queue/guide 入队）、queue CRUD、
  setAutoDrain、setFollowupMode、setAssistantFeedback；CommandInbox 语义
  （三态事实/FIFO admission/CAS/幂等 duplicate/stale）对齐上游 command-inbox.ts。
- 新路由 `POST /api/v4/conversation/command/query`（简项 4 收口）。
- 客户端 `V4QueuePanelBridge`（新）挂 V4ZCodeTimeline bottomDock：
  vendored ConversationQueuePanel + createHostCommandEnvelope CAS 信封。
- snapshot/state patch 携带真实 queue（queueStateSchema 形状）；stop →
  autoDrain=false + pauseReason=stopped + turnHeader completedInterrupted。
- 测试：`tests/test_v4_command_queue.py` 11 例 + stop 5 例全绿。
- 仍遗留（批次二）：生产链路 composer 排队路由、retry/editUserQuery/compact、
  pendingInteractions、Gen UI、stream-idle-timeout。

## 九、批次记录：右侧 workspace-browse 挂 ZCode 原生 WorkspaceFileTree（2026-10-25）

分析 ZCode 的 workspace-file-tree 全套（22 文件，vendored 早已在 `zcode-ui/workspace-file-tree/`）
并接入 EvoFlow 右侧面板。此前 workspace-browse 用的是 kv 树（`react/components/WorkspaceFileTree.tsx`），
ZCode 原生树的虚拟化行 / 吸顶文件夹 / 搜索 / 只看已更改 / Git 着色 / 空目录自动合并 / watcher 刷新全部缺失。

- **后端**（`workspaces.py` 新四端点，全部实测）：`GET /listdir`（绝对路径 + 越界校验，
  返回 ZCode FileEntry 形状）、`GET /git_status`（`git status --porcelain=v1 -z --branch` 解析成
  GitRefreshResult，非 git 目录 200+isRepository:false）、`POST /git_ignored_paths`
  （`git check-ignore -z --stdin` 批量）、`GET /list_files`（有界 os.walk 2 万条，跳 _DEFAULT_IGNORE）。
- **服务层**：`createEvoflowPartialServices` 扩容——fileService.readdir、
  listWorkspaceFilesLength/Range（list_files → 前端 packWorkspaceFileEntries 打包 + 15s 缓存）、
  gitService（refresh/getIgnoredPaths）、fileWatcherService 从 no-op 升级为**轮询实现**
  （目录比 readdir 签名、文件比 Range 探测 size，4s，状态翻转才发事件）。
- **挂载**：`V4WorkspaceFileTreePane`（新，宿主装配 Intl+Store+Platform+ServiceProvider，
  同 V4PreviewPane 模式）→ `render-right-stage-body` 的 workspace-browse 分支：
  有 `effectiveWorkspaceRoot` 时挂 ZCode 树；`'write'` 写入预览与无根（thread 沙箱）会话回落 kv 树。
- 提交 `eae8ab0f`（临时索引方式——当时共享仓库正被队友批量 stage，CAS update-ref 只带本批 4 文件；
  V4ZCodeTimeline/render-right-stage-body 内队友已完成的同工作树内容一并入库，内容与工作树一致）。
- 注意：后端改动需重启 gateway；新建了前端文件需重启 vite dev。

## 十、file 标签 ZCode 化——顶部文件路径面包屑（2026-10-25，提交 b2f0e16e）

用户指认"顶部显示文件路径的 UI"未复用 ZCode：`file` kind 一直渲染 kv `WorkspaceFilePreviewPanel`
（自家路径条样式）。本次在 `render-right-stage-body` 的 file 分支接入 ZCode 正式件：

- 有 `root || threadId` 且无 `data.poll`/`focusAnnotation` 时渲染 `V4PreviewPane`
  （source type:"file"）——顶部路径条 = PreviewPane 的 CodeViewerBreadcrumb（mask 滚动/
  相对化/token 主题），与工具卡 diff 视图同一套。
- 沙箱（仅 threadId）也走 V4PreviewPane：serve-file 按 thread_id 解析相对路径。
- poll/focusAnnotation 场景回落 kv 面板——全仓无生产方（纯保险分支），后续如接
  行级聚焦再评估 ZCode 侧等价物。

## 十一、关闭工作流标签清场 bug + outputs/b.txt 404 诊断（2026-10-25，提交 30b62a9a）

**① 顶部标签条**：仍是 EvoFlow RightStagePanel 自有样式（tab 条 chrome 换 ZCode
AnimatedSidePanePanel 属最后一个遗留大项，未做）。标签条本身照常工作，未受 file 树/预览切换影响。

**② 关一个工作流签全没了（已修）**：三条关闭路径（标签条 X / 关闭其他 / 面板体内关闭钮）
最终都进 `closeCollabExecPanel → hideRightStageIfKind('collab-workflow')` ——整 kind 清场。
修复：`closeRightStageTabByKey` 的 collab-workflow 分支改为「dismiss 该签自己的任务
（`{sessionKey}:{mainTaskId}`，防当前任务 bump 重新拉起）+ 单签 closeTab」；新增
`closeCollabWorkflowSurface` 供面板体内关闭钮同语义。workspace-browse / mind-map 仍走
kind 级关闭（单例语义，未动）。

**③ outputs/b.txt "文件不存在"（404 是真的）**：磁盘上 `D:/dev/github/EvoFlow/outputs/b.txt`
从未存在；文件实际落在 **幽灵树 `D:\d\dev\github\EvoFlow\outputs\b.txt`** ——子代理写链路把
`D:/dev/...` 搞成了 `D:/d/dev/...`（盘符剥了又按 git-bash 风格 `d/...` 段接回，证据：
stream-compare 日志里 bash `cd "D:/d/dev/github/EvoFlow/outputs"` 成功建目录写文件；
`resolve_tool_path` 本身对三种形态实测都解析正确，mangling 发生在更上游的子代理执行环境）。
已把幽灵树里的 b.txt（"this is file B"）复制回真实路径恢复用户预期；**上游写链路的盘符
mangling 是独立 bug 待查**（与 PreviewPane 切换无关，旧 kv 面板同样会 404）。

## 十二、右栏标签条 chrome 换装 ZCode（2026-10-25，提交 b4ff6350）

至此"file 树 / file 预览 / 标签条 chrome"三项全部收口。标签条换装要点：

- **chip 层**逐条对齐 vendored `SidePaneTabTrigger.tsx`：156px 等宽收缩（min 60px）、
  `text-ui-base`、hover `bg-hover`、`data-active:bg-selected`、内容层 mask 渐隐
  （`--tab-fade-offset` 随 active/hover 抬到 1.25rem 给关闭钮让位）、关闭钮 hover 亮出、
  **中键关签**、拖拽 scale 钳制 + wasDragging 防拖后误激活。根节点用 div（ZCode 同款注释：
  root 是 button 会嵌套 button，生产包浏览器修 DOM 导致事件错位）。
- **未直接复用 SortableSidePaneTabTrigger**：它强类型绑定 `WorkspaceSidePaneTab` 19 成员
  判别联合（code-viewer 等成员要求 `source` 必填），EvoFlow 的 RightStageSurface 适配不过去；
  dnd-kit 排序与右键菜单管道保持 EvoFlow 自有。
- overview / 加签 / 收起钮 → vendored Button ghost icon-md（ChevronsDown / Plus / PanelRightClose）。
- **Tailwind 扫描坑**：styles-bridge.css 的 `@source` 原来只扫 zcode-ui 树——RightStagePanel
  在 EvoFlow react 树里用的 ZCode 工具类不会产出。补 `@source "../react/**"` 后全局生效；
  token（--color-hover/--color-selected 等）在 styles-bridge `@theme` 定义于 `:root`/`.dark`，
  桥外全局可用（dark 类两套作用域共用）。
