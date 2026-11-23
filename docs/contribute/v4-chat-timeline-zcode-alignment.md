# V4 对话时间线对齐清单（EvoFlow ↔ ZCode）

> 日期：2026-11-19（A5 全窗对齐更新：2026-11-22）。  
> 目的：把「聊天视口」拆成可逐条对齐的原子点，停止零打碎敲。  
> 上游契约：`D:/dev/github/ZCode/docs/ui/chat-virtual-scroll.md`  
> 上游实现：`D:/dev/github/ZCode/packages/ui/src/v4/`  
> EvoFlow 副本：`evopanel/src/zcode-ui/v4/`（vendored，见 `THIRD_PARTY_ZCODE.md`）

相关：流式协议对齐见 `v4-streaming-alignment-logbook.md`；本文只覆盖**渲染层时间线**（滚动 / 投影窗 / 轮序 / 轮尾媒体）。

---

## 0. 先记住三条总规则

1. **ZCode：`rows.window` 是唯一事实源**；虚拟化只限 DOM，客户端不得再发明第二套「焦点窗」。  
2. **`following` = 用户滚动权**，不是瞬时几何；只有真实用户输入能改它；程序化贴底 / 测高 / 折叠不得抢权。  
3. **对齐 ZCode 投影**：宽屏问题导航 `loadAllOlder` 分页到 `!hasMore`（先尾窗、后一次合并全量——ZCode TN07 本意）。禁止 `releaseBalloon` 跟底裁回。内存靠 lighten + pin。跟底仍禁止 loadOlder（A3）。

```text
用户意图（wheel/touch/key）
    │
    ├─ awayFromBottom → following=false → 允许 loadOlder → prepend 锚定
    │
    └─ 跟底 / 回底按钮 → following=true → stickToBottom
                              │
                              └─ 禁止 loadOlder（短尾窗否则会死循环）
```

---

## 1. 十个原子点（整段对话就这些）

| ID | 原子点 | 一句话 | 主文件（EvoFlow） |
|----|--------|--------|-------------------|
| **A1** | following 滚动权 | 只有用户输入改 following | `timelineScrollAnchor.ts`, `ConversationTimeline.tsx` |
| **A2** | stickToBottom | following→instant 吸底；测高在途不抢吸底 | 同上 + `contentMeasurementPending` |
| **A3** | loadOlder 触发 | 近顶预取；**跟底禁止** | `shouldTriggerLoadOlder`, Timeline `handleScroll`, SessionPane 冷快照补齐 |
| **A4** | prepend 锚定 | 前插后按 turn key 平移 scrollTop | Timeline prepend layout effect |
| **A5** | 投影全窗（原 soft-cap） | 持全窗；lighten 控内存；releaseBalloon 退役 | `projectionWindowCap.ts` |
| **A6** | snapshot / delta 合并 | snapshot 可 cap+保历史；**delta 禁止 cap** | `conversationProjectionStore.ts` |
| **A7** | 冷快照首 turn 补齐 | 窗首缺 turnHeader → 自动 loadOlder | `SessionPane.tsx` + `shouldAutoLoadIncompleteLeadingTurn` |
| **A8** | 轮内用户气泡 vs 工作 | realUser 必须在「已工作」之上 | `conversationTurnRenderUnits.ts`（`normalizeOrderedRowsUserFirst`） |
| **A9** | 轮尾媒体（绘画/CUA/平台） | 截图/生图提到轮尾槽，不进「已工作」 | `isBrowserTurnEndRow` / `browserTurnEndRows`, `ConversationTurnGroup` |
| **A10** | 测高 / 思考显隐 / KeepAlive | 估矮假贴底、清缓存、切回不得强跟底 | Timeline ResizeObserver / showReasoning / becomeVisible |

---

## 2. 逐点：ZCode 契约 → EvoFlow 现状 → 对齐动作

### A1 · following 滚动权

| | |
|--|--|
| **ZCode** | `following` 非几何快照；`resolveFollowingAfterScroll`：非 user 源保持原值；user 源按是否贴底。文档强调上滚优先于布局回调。 |
| **EvoFlow** | 在上游基础上加了 `userScrollIntent`：`awayFromBottom` 永不恢复；`intent=none` 时已离底不因高度塌缩「假贴底」而粘回。估矮时去掉「必须有滚动条才登记意图」门槛。 |
| **状态** | ✅ 对齐并加固（防结束态上滚被拽回） |
| **动作** | 保持；回归：`tests/v4-timeline-scroll-anchor.test.ts` |

### A2 · stickToBottom / scrollToBottom

| | |
|--|--|
| **ZCode** | `anchorActionAfterContentChange(following)` → stick / hold；`scrollToBottom` 必须 **instant**（smooth 会被误判离底）。内容变高、测高、宽度变化批处理后吸底。 |
| **EvoFlow** | 同契约；内容 effect 用 `rowWindowKey` 代替绑整个 `rows` 数组（防 React #185）。**缺**上游 `contentMeasurementPendingRef` + resize **同步批测高**（见 ZCode `chat-virtual-scroll.md`「resize 中的底部跟随」）。 |
| **状态** | ✅ 已回港 resize 同步批测高 + `contentMeasurementPending` 门闸（2026-11-19） |
| **动作** | 保持；测高在途时 prepend / stick / heal 让位，跟底再 `flushSync` 吸底 |

### A3 · loadOlder 触发（本次乱套的主因）

| | |
|--|--|
| **ZCode** | `shouldTriggerLoadOlder`：仅几何（近顶 + 可拉 + 非在途）。**无 following 参数**——上游无 soft-cap，窗够长。`mergeOlderRows` = **纯前插** `[...older, ...window]`，不裁行。前插后 `prependVirtualAnchor` 平移 scrollTop。 |
| **EvoFlow** | 全窗后尾窗够长；仍保留 `following===true → 禁止预取`（防短尾窗过渡态死循环）。`mergeOlderRows` **纯前插**（2026-11-20）。 |
| **状态** | ✅ 跟底门闸 + 近底短窗门闸 + 上滚纯前插对齐 ZCode 语义 |
| **动作** | 验收：跟底 `auto=0`；近底刚离底不预取；上滚离开近底或真到顶后 `loading=1` 且 winFirst 前进（A4） |

### A4 · prepend 锚定

| | |
|--|--|
| **ZCode** | `prependVirtualAnchorAdjustment` / `prependScrollAdjustment`；前插只撑高，scrollTop+=Δ。 |
| **EvoFlow** | 同实现。 |
| **状态** | ✅ 对齐 |
| **动作** | 保持；勿在 prepend 同帧再 `scrollToBottom` |

### A5 · 投影全窗（原 soft-cap）

| | |
|--|--|
| **ZCode** | **不存在** soft-cap。文档写明：store 持全窗；分区 + memoize 控派生成本。 |
| **EvoFlow** | 对齐 ZCode：`loadAllOlder` 日常分页到 `!hasMore`（`conversation-turn-navigator.md`：until firstRowId）；跟底 `releaseBalloon` 恒 no-op；`projectionSoftCap`→100k。分享另限 SHARE_CAP。内存靠 lighten + pin/keep-warm。 |
| **状态** | ✅ 目录全量补拉 + 跟底不裁窗 |
| **动作** | 禁止再给日常 `loadAllOlder` 加行顶；禁止跟底裁窗；「先短后长」是 ZCode 宽屏预期 |

### A6 · snapshot / delta 合并

| | |
|--|--|
| **ZCode** | snapshot 整窗替换；loadOlder 纯前插；流式 delta 只改尾轮；`advanceConversationRowsPartition` 冻结历史引用。 |
| **EvoFlow** | snapshot：`applySoftCap`（全窗上限下日常只 lighten）+ `mergePreservedOlderRowsIntoTailSnapshot`；loadOlder：纯前插；**delta 路径禁止 cap**。无 rowPool/partition。 |
| **状态** | ✅ snapshot/preserve/delta 不裁；⚠️ partition 未跟 |
| **动作** | backlog：评估回港 partition（降每帧 O(N)）；**禁止**再在 delta 热路径加 cap |

### A7 · 冷快照首 turn 补齐

| | |
|--|--|
| **ZCode** | `shouldAutoLoadIncompleteLeadingTurn` → SessionPane `loadOlder`；cursor 去重。 |
| **EvoFlow** | 同逻辑；分享用 `loadAllOlder({ forShare })`。 |
| **状态** | ✅ 对齐 |
| **动作** | 勿与 A3 跟底门闸冲突：这是「缺 header」专项，不是短窗狂拉 |

### A8 · 轮内用户气泡 vs「已工作」（上下割裂）

| | |
|--|--|
| **ZCode** | 严格按 CLI `orderedRows` 全序；guided / `header.workSegments` 切视觉段；折叠外只留可见正文。 |
| **EvoFlow** | soft-cap/late-mirror 可致同 turn 下 tool rowId &lt; user → 先画「已工作」。已加 `normalizeOrderedRowsUserFirst`。折叠外正文收紧为段末/流式。guided 切段简化（未必跟 CLI workSegments）。 |
| **状态** | ✅ 割裂主路径已修；⚠️ guided 多段仍可能偏离上游 |
| **动作** | 回归：`tests/v4-turn-user-first-order.test.ts`；产品确认是否回港 CLI workSegments |

### A9 · 轮尾媒体（绘画 / CUA / 平台生图）

| | |
|--|--|
| **ZCode** | `browser_turn_end` 类截图抽出为 `browserTurnEndRows`，渲染在 file diff 摘要之后、操作栏之前；**不进「已工作」折叠**。 |
| **EvoFlow** | 同槽位；扩展识别 `cua`+media、`platform_ui`+media；另有右栏 autoOpen（产品扩展）。 |
| **状态** | ✅ 槽位契约对齐；🔶 媒体种类为 EvoFlow 扩展 |
| **动作** | 对齐时禁止把媒体塞回 assistantHistory；右栏 autoOpen 标宿主扩展 |

### A10 · 测高 / 思考显隐 / KeepAlive

| | |
|--|--|
| **ZCode** | resize 同步批测高（见文档）；搜索/定位保持离底；记忆按 pane 隔离。 |
| **EvoFlow** | 思考开关清 heightCache；KeepAlive 切回仅 when following；缺 resize 批测高。 |
| **状态** | ✅ 批测高 / KeepAlive 上滚守卫 / 离底停周期 heal（2026-11-19） |
| **动作** | 保持；离底只靠 mountedRowsKey 批测高纠偏，禁止 scroll/interval heal 抢阅读位 |

---

## 3. 现场症状 ↔ 原子点（对照表）

| 用户看到的现象 | 主责原子点 | 说明 |
|----------------|------------|------|
| 发完消息最新/用户气泡不显示，乱跳 | **A3↔A5↔A2** | 跟底仍 loadOlder +（已退役的）裁窗 + scrollToBottom |
| 上滚历史又被拽回底 | **A1 / A2** | 假贴底恢复 following，或布局抢权 |
| 切会话偶发正常，再上滚又乱 | **A3** | 短尾窗再次进入预取死循环 |
| 「已工作」在用户气泡上面 | **A8** | 同 turn 工具行序先于 user |
| 绘画/截图进折叠或位置错 | **A9** | 未进轮尾槽 |
| 叠字 / 大空白 / estimate 72 | **A10** + 布局 dump | 估高与测高不同步 |

---

## 4. 已修 / 故意偏离 / backlog

### 已修（勿回退）

- following 门闸 loadOlder（A3）
- resolveFollowing + scrollIntent 假贴底守卫（A1）
- 投影全窗 + releaseBalloon 退役（A5，2026-11-22）
- snapshot preserve older（A6）
- delta 不做 soft-cap（A6）
- normalizeOrderedRowsUserFirst（A8）
- 折叠外正文收紧（A8）
- KeepAlive / 思考清缓存（A10）
- resize `flushSync` 批测高 + `contentMeasurementPending`（A2/A10）
- 离底停 scroll/interval heal；KeepAlive 尊重 awayFromBottom（A10）
- 到顶继续上滚：wheel 补触发 loadOlder（不再只靠 scroll）（A3）
- loadOlder 纪元字符串比较 + 空页/窗首未前进打日志；prefer=head 强制保住本页更早行（A3/A5）
- 内存 shrink：**只瘦身永不裁行**（loadingOlder 跳过）；防上滚 2004↔52 / prepend !JUMP 抖动（A5/A3，2026-11-20）
- mergePreserved 抬 effectiveCap + 硬保窗首（snapshot 尾窗替换配套）

### 故意偏离（写进评审）

- CUA / platform 轮尾媒体种类扩展（A9）
- 视口调试浮层（宿主诊断，非协议）
- 跟底仍禁 loadOlder（A3；上游无 following 参数，EvoFlow 留门闸防短尾窗）

### backlog（按优先级）

1. 回港 **rows partition / memoizeByRows**（A6，降长会话每帧成本）  
2. 产品确认 **guided workSegments** 是否跟 CLI（A8）  
3. 验收矩阵：跟底 / 上滚 / 发消息 / 切会话 / 绘画轮尾 五条浏览器路径

---

## 5. 验收口令（改一点测一点）

```text
1) 打开 2000+ 行会话，跟底：浮层 auto 必须为 0；不得出现 loadOlder↔!JUMP scrollToBottom 互殴
2) 上滚 follow=0 后：才允许 loading=1；阅读位置不跳（A4）
3) 宽屏长会话：首帧尾窗 → 问题导航 `loadAllOlder` 一次合并到顶；跟底不得 releaseBalloon 砍回（A5）
4) 切会话再切回：记忆/跟底符合 A1/A2；再上滚不得立刻死循环
5) 带绘画/CUA/平台生图的轮：媒体在轮尾槽，不在「已工作」里（A9）
```

测例入口：

- `evopanel/tests/v4-timeline-scroll-anchor.test.ts`
- `evopanel/tests/projection-window-cap.test.ts`
- `evopanel/tests/tip-soft-cap-latch.test.ts`
- `evopanel/tests/v4-preserve-older-on-tail-snapshot.test.ts`
- `evopanel/tests/v4-turn-user-first-order.test.ts`
- `evopanel/tests/v4-userinput-visible-in-tail.test.ts`

---

## 6. 工作方式约定

以后改对话视口：

1. 先标 **A1–A10 哪一条**；  
2. 对照 ZCode 源码 / `conversation-turn-navigator.md` / `chat-virtual-scroll.md`；  
3. 投影窗相关改动必须同时检查 **A3 跟底门闸** 与 **A5**；  
4. 日常 `loadAllOlder` 必须跟 ZCode 一样拉到 `!hasMore`；禁止跟底裁窗；禁止「为对齐而去掉 following 门闸」。
