# ChatApp 拆分重构进度 + 渲染/卡顿现状分析

> 快照日期：2026-10-22。重构仍在进行中（分支 `refactor/chatapp-extract-helpers-p0`，提交编号持续推进），文中 P 编号和行号以当日为准。
> 数据来源：三路只读代码探查（虚拟化实现 / 流式调度 / 累积泄漏排查），所有结论附 file:line 证据。

## 一、重构进度

### 里程碑

- **P0–P150**：逐步把 `ChatApp.tsx`（原 **17,419 行、579 个 hook 调用**）的 helper/hook/handler 机械提取到 `evopanel/src/react/chat-app/`，现为 **155 个文件、约 2.2 万行**，按 20 个子目录组织（composer、session、stream、right-stage、view、goal 等）。
- **P89**：主 JSX 拆到 `chat-app/view/chat-app-view.tsx`，通过 `renderChatAppView(ctx)` 宿主袋子（`Record<string, any>`）传值。
- **P151**：剩余主体整体搬入 `chat-app/use-chat-app-controller.ts`（6,172 行，`@ts-nocheck` 机械提取）；`ChatApp.tsx` 变为 21 行薄壳，带 HMR 整模块 accept（防 react-refresh 部分热替换的 TDZ 白屏）。
- **P152**：补齐 ChatAppView 解构 + 接线 resume helpers。

### 性质与代价

- 这是**行为保持的机械搬移**：React 视角下组件结构、状态数量、重渲染范围均未变。**它改善可维护性，不改善运行时性能。**
- 已知待还的债：`@ts-nocheck` 待去除；controller↔view 契约目前编译器不检查；controller 本身仍是 6,172 行巨物（中点，非终态）。

## 二、渲染架构现状（事实）

### 虚拟化

- 主对话路径：`ChatMessageStreamPane` → `components/MessageVirtualList.tsx`，基于 @tanstack/react-virtual 动态测量（`measureElement` + 按角色/文本长度估算初值，L384-407，overscan 8），窗口外消息从 DOM 移除（L481）。
- **阈值**：行数 ≤ `HISTORY_FLAT_LIST_MAX_ROWS = 30` 时走 `FlatHistoryBody` 原生文档流全量渲染（`MessageVirtualList.tsx:591`、`hooks/history-pagination.ts:9`），超长会话才切虚拟化。
- 消息行 memo：外层 `MemoMessageRow`/`HistoryMessageRow` memo + 自定义比较（`MessageVirtualList.tsx:76,154`）；`MessageRow` 本身未导出为 memo（`MessageRow.tsx:708`）。流式 tick 用逐行引用稳定的 `baseHistoryItems` 保 memo 命中（L1202-1233）。
- 行内：流式末条 assistant 纯文本直写 DOM（`MarkdownHtml.tsx` isStreaming 分支），结束后一次性走 Streamdown（remark/rehype + 高亮，`StreamdownRenderer.tsx:11-18`）；`ToolCallList`（2,400+ 行）有 memo + 自定义比较（`ToolCallList.tsx:2391`）。
- `components/XiaomiChatThread.tsx` 为 `messages.map` 全量渲染，**当前无引用方（死代码）**。
- 贴底跟随：rAF 合帧 + ResizeObserver 驱动，非每 tick 强制 scrollTo（`MessageVirtualList.tsx:1330-1382,1449-1468`）。

### 流式更新调度

- 路径：SSE（`src/lib/ws-client.js`）→ `chat-app/stream/install-chat-ws-on-event.ts:294` → delta 归约进 mutable streamRef（`lib/chat-stream-apply.ts:59-60`）→ 递增 snapshot seq + 调度 bump（`chat-app/stream/after-live-or-structural-bump.ts:19-45`）。
- 节流：文本 delta 16ms（≈60fps），大 payload 自适应 33/50ms（`lib/stream-bump-interval.ts:11,58-63`）；reasoning 单独 16ms；chrome 450ms；后台 400ms；右侧面板打开降频 800ms（`chat-overlay-defer`）。
- 每条 delta **不**重渲染整个 ChatApp：`MessageVirtualList` 经 `useStreamSnapshotSeq`（L1012）+ per-session epoch 订阅（`ChatMessageStreamPane.tsx:86-88`）局部驱动；controller 仅 2 个 `useSyncExternalStore`（controller:1007,1429）。
- `startTransition` 只包结构性 `bumpStream`（controller:2056-2060）；`flushSync` 全在交互路径。

## 三、卡顿嫌疑清单（症状：多轮对话十几分钟后页面卡顿）

> 按可能性排序。第一分叉点：卡顿发生在流式时、交互时、还是静止时——决定先查哪条。

### 嫌疑 1（最可能）：60fps bump × 随轮次变贵的 O(n) 行操作

每个流事件做 `rt.rows = updater([...rt.rows])` 全量拷贝（`lib/session-runtime-store.ts:803`），叠加 `collapseSameTurnAssistantsInRows` 等 O(rows) 遍历（`stream/create-chat-ws-on-event.ts:2678,2691`）。即 **60 次/秒 × O(总消息数)**，随轮次线性增长。每次 bump 经 `bumpStreamChromeThrottled` → `bumpSessionRuntimeNotifyForKey` 触发订阅链（`chat-app/stream/bump-stream-chrome-throttled.ts:25`）。

### 嫌疑 2：每秒 tick 组件数量随流式内容增长

每个"运行中"的流式行/工具卡片/思考块各持独立 1s interval setState：`MessageRow.tsx:1264`、`ToolCallList.tsx:1131`、`ReasoningInlineBlock.tsx:169`、pane 级 `ChatMessageStreamPane.tsx:157`。N 个运行中工具 = 每秒 N 次大组件重渲染。

### 嫌疑 3：memo 覆盖漏洞（需实测定论）

`MessageRow` 未 memo 化导出（`MessageRow.tsx:708`），依赖外层 `MemoMessageRow` 自定义比较器；若 chrome bump 或 1s tick 使比较器失效，可见窗口全部行（含 ToolCallList）整体重渲染。两路探查对此结论有出入，需 Profiler 验证。

### 嫌疑 4：无上限累积数据结构

`rt.seenRunIds` 每轮 push 无上限，`stoppedRunIds.includes()` 线性扫进入每事件热路径（`lib/session-runtime-store.ts:932-947`）；controller 内 `seenArtifactsRef` 等 per-session refs 仅删会话时清理（controller:2342-2345）。增长慢，数十分钟量级可见。

### 嫌疑 5：交互路径布局抖动

`chat-app/session/install-bottom-portal-layouts.ts:45,79` scroll capture 监听：菜单打开时每次滚动执行 `getBoundingClientRect` + setState，无节流；`useRunningSessionSummaries` 每 6s 轮询（`hooks/useRunningSessionSummaries.ts:174`）造成周期性抖动。

### 已有优化（勿重复建议）

16/33/50ms 自适应节流、chrome 450ms 通道、overlay 降频、startTransition、贴底 rAF 合帧、流式纯文本直写、行引用稳定化保 memo、`turnStartMsByRunKey` 200 上限、perfBuffer 800 上限、reconcile 只拉 tail 24 条且每轮限 3 次重试、perf probe 基建 `client-perf-hook.ts`。

## 四、建议实验步骤

1. **分型**：Performance 录制三段——流式 2 分钟 / 多轮后静止 10 分钟 / 菜单打开后滚动，定位卡顿归属。
2. 嫌疑 1：在 `session-runtime-store.ts:803` 统计 rows 数量与单次拷贝耗时随轮次曲线；验证 `collapseSameTurnAssistantsInRows` 调用频率。
3. 嫌疑 2：数流式高峰时存活 1s interval 数（Profiler 每秒 render 次数）。
4. 嫌疑 3：确认 chrome bump / 1s tick 时 `MemoMessageRow` 比较器是否放行。
5. 嫌疑 4：打印 `rt.seenRunIds.length` 随时间增长。
6. 架构问题：`bumpSessionRuntimeNotifyForKey` 每次 notify（rAF+200ms 合并后，`lib/session-runtime-store.ts:164-174`）实际触发哪些组件 re-render。

### 待确认问题

- 卡顿是否只在流式时出现？
- 是否与右侧面板打开相关（overlay defer 降频 vs 关闭时 60fps）？
- 长会话是否超过 30 行（超过后走虚拟化路径，表现可能不同）？
