# ZCode 后台子代理架构分析与 EvoFlow 改造方案

> 分析对象:ZCode v3.18.2(全部结论经代码逐行验证,file:line 可查)
> 目的:回答「对话中派了子代理 → 对话正常结束 → 子代理干完后对话自动继续回复」是怎么做到的,
> 以及 EvoFlow 怎么把这套体系搬到自己的"员工派工 / 后台触发 / 工作流"场景。
> 分析时间:2026-11-14

---

## 一、场景与总览

用户视角的完整时间线:

```
用户:帮我调研 X 并写报告
AI :好的,我派一个后台子代理去做。(工具卡:Agent "调研X" 运行中)
     ……主回复正常结束,输入框回到可用状态──────────┐
                                                    │ (子代理在后台独立跑)
AI :子代理完成了,结果如下……(新一轮回复)◄────────┘
     (原 Agent 工具卡:运行中 → 已完成)
```

关键事实:**主对话的 turn 和子代理的生命周期完全解耦**。主 turn 不等待子代理;
子代理完成后通过 `<task-notification>` **主动唤醒**一个新模型轮。这就是 ZCode
文档里废弃旧方案的理由(`docs/agent-background-subagent-join.md`):旧方案让
main turn 等待并 join,会掩盖 fake running / fake notified 之类的生命周期问题;
正确做法是"main turn 先正常结束,完成后自动唤醒(idle wake)"。

## 二、ZCode 全链路(8 个环节,均已代码验证)

### 1. 派发:工具立即返回,不阻塞

- `Agent` 工具 handler 不区分前后台,统一走 `subagentPort.launch()`,由 port 按
  `run_in_background === true || profile.background === true` 分流
  (`core/tool/handlers/agent.ts:218-266` → `core/subagent/runner.ts:187-218`)。
- 后台分支走 `port.start()`:注册 registry → 写 metadata.json(失败即回滚)→
  **fire-and-forget** 启动 child(`runner.ts:566-659`),用 readyGate 等 child
  session 持久化完成后立即返回。
- 后台任务的 AbortController **只绑 shutdown,不绑父 turn signal**(`runner.ts:813-828`)
  ——父 turn 取消/结束不会杀掉已后台化的 child。
- child 是**独立 session**、独立 `AgentRuntime` 实例(共享 eventStore/sessionStore,
  继承权限与模型工厂,模型准入走 subagent 专用子队列,`runtime/methods/subagent.ts:305-462`)。
- 模型拿到的即时结果(`agent.ts:176-216`):

  ```
  Async agent launched successfully. …
  The agent is working in the background. You will be notified automatically when it
  completes. You know nothing about its results until that notification arrives — do
  not report, assume, or predict them; continue other work or respond to the user.
  ```

### 2. 主对话"正常停止"的三个条件

- **不算 turn 阻塞**:工具立刻返回 `status:"async_launched"`,tool batch 正常收口,
  turn 循环在模型无后续 tool call 时自然结束——没有任何"等后台任务才结束"的路径;
- **算 residency blocking**:后台任务计入 `hasResidencyBlockingWork()`
  (`methods/residency.ts:25-34` → `background.ts:38-40`),所以协议层把该 session
  判为 **busy**(`session-residency.ts:246-255`),驻留池**不回收**该 runtime
  (`session-resident-pool.ts:234-245`)——对话看起来"停了",runtime 其实原地待命;
- **UI 无感**:turn 正常 TurnComplete,输入框恢复可用,后台任务只以
  `background_task_started/updated/completed` 事件投影成工具卡。

### 3. 完成检测与原子认领

- child 终态由 runner 侧 `finalizeBackgroundCompletion/Failure` 提交:
  `registry.update(taskId, patcher)` 仅当 `executionId` 匹配且非终态才置终态
  ——**CAS,迟到事件直接放弃**(`runner.ts:1751-1767`);
- 通知去重靠 registry 条目上的 `notified` 布尔 + `claimRuntimeBackgroundTaskNotification`
  的单步 CAS 认领(`tool/executor/background-task-registry.ts:168-181`),入队异常可
  release 回滚;`TaskOutput` 读过结果也会 `markTaskNotified`,模型拿过就不再收重复通知。

### 4. 唤醒:通知即命令,唤醒即普通轮

- 完成后 `enqueueBackgroundTaskNotification`(`methods/background-notifications.ts:19-93`)
  构造 `TaskNotificationRuntimeCommand(mode:"task-notification", priority:"next")`
  入 runtime command queue,**同时把 admission 写入 session ledger**(持久化,见环节 7);
- 空闲时 `drainRuntimeCommandQueue` 取出 → `runTaskNotificationBatch`
  (`runtime-command-queue.ts:352-439`):过滤 stale/suppressed → 持久化 synthetic
  user 消息 → `executeTurnCommand(…, { inputSource:"background_task",
  inputVisibility:"model-only" })`——**这是一个完整的新模型轮**(独立
  TurnStarted/TurnComplete,有自己的 AbortController);
- **合批**:多个子代理同时完成,同 priority 的通知一次性出队,拼成**一条**
  synthetic user 消息(多个 `<task-notification>` 块,`command-queue.ts:185-211` +
  `background-notifications.ts:199-261`),只花一个模型轮。

### 5. 模型看到什么

通知本体(local_agent 模板,`runtime-task/notification.ts:151-165`):

```xml
<task-notification>
  <task-id>agent_xxx</task-id>
  <tool-use-id>toolu_xxx</tool-use-id>
  <output-file>/…/output.txt</output-file>
  <status>completed</status>
  <summary>Agent "调研X" finished</summary>
  <note>A task-notification fires each time this agent stops with no live
  background children of its own. The user can send it another message and
  resume it, so the same task-id may notify more than once.</note>
  <result>…子代理最终报告…</result>
  <usage><subagent_tokens>12345</subagent_tokens>…</usage>
</task-notification>
```

provider 层再包一层防误读前缀(`system-reminder/incoming-message.ts:10-36`):

```
[SYSTEM NOTIFICATION - NOT USER INPUT]
This is an automated background-task event, NOT a message from the user.
Do NOT interpret this as user acknowledgement, confirmation, or response to
any pending question. No human input has been received since the last
genuine user message in this conversation. …
```

通知轮是普通模型轮:可以继续派工(再调 Agent)、调工具、或直接向用户汇报。
若父会话挂着 active goal,通知轮结束后 goal 自动续跑(`runtime-command-queue.ts:201-217`)。

### 6. 用户视角(UI)

- 主对话停止后**不出现新用户气泡**——唤醒输入是 `inputVisibility:"model-only"`
  的 synthetic 消息,不进用户可见消息列表、不参与 session title;
- UI 靠 `turn.started` 事件把每条 `<task-notification>` 换算成对**原 Agent 工具卡**
  的状态翻转(运行中 → completed/failed),随后新 assistant 轮自然出现
  (`packages/ui/src/lib/zcodeSessionProjection.ts:1288-1319`);
- child 的普通工具事件不复制进父会话,只镜像摘要级活动;父会话始终只显示 Agent 卡片。

### 7. 防丢、防重、防错乱(可靠性三件套)

| 机制 | 实现 |
| --- | --- |
| **admission ledger** | 通知入队即写 `session_input` 表(`background-notifications.ts:70-92`),SQLite 幂等 upsert + `admitted_sequence` 单调;消费时整批 promote;丢弃时结算 `discarded`;**崩溃恢复**:resume 时残留 admitted 收口为 `discarded(session_resumed)`,并对账"上一进程死时仍在跑的 Agent"生成 failed 通知(`session-inputs.ts:397-487`) |
| **notified CAS** | registry 单步 CAS 认领,TaskOutput 已读则跳过,Agent 通知由 runner 独发、tracker 看到 notified 就跳过(防双份) |
| **branch fencing** | 每个任务盖 `branchGeneration`;rewind 时代数 +1 并先取消被裁剪轮的后台任务;迟到通知出队前再验一次 `isStaleBranchRuntimeCommand` ——**旧分支的完成通知不会污染新分支** |

### 8. 与用户输入/Stop 的交互

- 用户消息和通知进**同一个 runtime command queue**,同优先级 FIFO——谁先入队谁先跑;
- 通知轮执行中用户发消息:走正常 steer/busy 入队分支;
- **Stop 不断通知**:abort 当前前台执行(含通知轮),但排队的通知保留,之后仍会开新轮
  (`runtime-command-queue.ts:37-38` 注释明示这是有意行为);
- 双向通道:`SendMessage`(main→child,运行中 steer 注入 / 终态 agent 复用同一
  childSessionId 后台复活)+ `RespondToCoordinator`(child→parent,`mode:"subagent-message"`
  与 task-notification 同队列同优先级,回复首次可见位置保证早于完成通知)。

## 三、这套体系为什么好(五条设计不变量)

1. **生命周期解耦**:派发即返回 + 完成即唤醒,主 turn 永不为子代理阻塞;
   "停止"是 UI 语义,"待命"是 runtime 语义(residency),两者分离;
2. **通知即命令**:唤醒不是一个特殊机制,就是一个普通模型轮——steer、queue、
   goal 续跑、权限、压缩全部复用,没有平行状态机;
3. **单写者 + CAS**:任务状态只有 registry 一处权威,终态提交/通知认领全部
   单步 CAS,迟到事件天然无害;
4. **持久账本兜底**:内存队列丢了不要紧,admission ledger + 崩溃对账保证
   "至少有一次终态可见",不丢也不重;
5. **代际 fencing**:rewind 分支代贯穿任务与通知,新分支永远干净。

## 四、EvoFlow 现状对照

EvoFlow 已经有一次"第一代移植"(`tools/zcode_port/notify_continuation.py`,
模块名就是从 ZCode 移植的):

| 能力 | ZCode | EvoFlow 现状 |
| --- | --- | --- |
| 派发即返回 | ✅ async_launched,主 turn 自然结束 | ⚠️ **同步轮询仍是主路径**(task_tool 在 turn 内 poll,900s 超时,前面已修但语义仍是阻塞);detach 是可选项(普通聊天默认 detach) |
| 完成唤醒 | ✅ 通知即 runtime command,空闲立即开新轮 | ✅ 已有 `schedule_task_notification_turn`(LangGraph 入队新 turn,busy 时 enqueue)——**骨架在** |
| 多通知合批 | ✅ 同优先级整批一条消息一个轮 | ❌ 每条通知一个独立 turn(`notify_continuation.py` 单条入队) |
| 防丢账本 | ✅ admission ledger + 崩溃对账 | ❌ 仅进程内 `_DEDUP` set(且 >500 时 **clear() 整体清空**——连已入队未消费的去重记忆都会丢,是个真 bug) |
| 通知 CAS 认领 | ✅ registry 单步 CAS | ❌ 无;依赖 message_id 去重 + DB claim(`safe_try_claim_inject`,部分具备) |
| 状态权威 + CAS | ✅ registry 单写者 | ⚠️ executor result_holder 曾有翻转竞态(已修防翻转,但仍是共享对象直写) |
| 分支 fencing | ✅ branchGeneration 贯穿 | ❌ 无(rewind 后迟到通知无防护) |
| model-only 投影 | ✅ 不进用户消息列表/标题 | ⚠️ notification 作为消息注入,可见性语义未对齐 |
| UI 卡片翻转 | ✅ 通知 → 原 Agent 卡状态 | ⚠️ 前端有 child work 卡片,但通知→卡片映射未确认对齐 |
| 双向通道 | ✅ SendMessage + RespondToCoordinator | ❌ 无 |
| 排队语义 | ✅ 排队≠超时(PENDING 明示) | ✅ 刚修(本轮 P0-4) |

## 五、改造方案(建议分三阶段)

### 阶段 A:把已有骨架做"硬"(对齐 ZCode 可靠性,1 个 PR)

1. **修 `_DEDUP.clear()` bug**(`notify_continuation.py:40-42`):超过 500 条时
   整体清空会让重复通知穿透。改成 LRU 淘汰最旧一条(与 ZCode 的 registry 语义一致);
2. **通知合批**:同 thread 的多条待发通知合并为一个 turn(收集窗口 2-5 秒,
   或复用 detached_poll_scheduler 的队列把 pending 通知拼成一条多块消息),
   避免 5 个子代理同时完成触发 5 个模型轮;
3. **持久账本**:通知入队时写 session ledger(幂等 id = message_id),消费/丢弃
   结算;Gateway 重启后对"上一进程仍 running 的子任务"做对账补发 failed/completed 通知;
4. **SYSTEM NOTIFICATION 前缀**:`_run_notification_turn` 的注入文本加上
   ZCode 同款防误读包装(不是用户输入、不构成确认),防止模型把通知当用户确认。

### 阶段 B:把同步轮询降级为例外(体验与资源)

5. **task_tool 默认 detach 化**:collab 场景保留同步 join;普通派工默认
   `async_launched` 语义——工具立即返回任务引用,模型继续别的工作;
6. **状态权威收敛**:把 executor 的 result_holder 直写改为 registry 单写者 +
   CAS(与 P0-4 的防翻转保护衔接),`started_at`/PENDING 语义对齐(ZCode 的
   "排队中"在 UI 是独立状态,不是假 running);
7. **model-only 可见性**:通知消息在 EvoPanel 不渲染为用户气泡,只翻转对应
   工具卡;session title/导出过滤。

### 阶段 C:补双向通道与 fencing(员工体系的关键)

8. **SendMessage(child steer)**:主对话给运行中员工发指令——复用现成的
   steer 机制注入 coordinator 消息;终态员工按同 childSessionId 复活;
9. **RespondToCoordinator(员工→主对话)**:员工工具面挂一个 child-only 回复
   工具,走与 task-notification 同一条通知队列(同优先级,保证回复先于完成通知可见);
10. **branch fencing**:会话 rewind 代数 +1 贯穿任务注册与通知入队,旧分支迟到
    通知出队前校验丢弃;
11. **员工面板进度**:child 事件摘要镜像进父会话(不复制全量 transcript),
    对齐 ZCode 的"父只显示 Agent 卡片"原则。

### 验收标准

- 派 5 个后台子代理 → 主对话 3 秒内结束;5 个全部完成 → **只出现 1 个唤醒轮**;
- Gateway 重启期间完成的子代理 → 恢复后补发通知,不丢不重;
- 用户 Stop 后已排队通知仍会唤醒(与 ZCode 行为一致);
- rewind 派发的子代理完成 → 通知被 fencing 丢弃,新分支无污染;
- 同步轮询路径仅剩 collab/显式 wait 场景。

## 六、一页总结

ZCode 这套体系的本质:**"派发"和"等待"是两个独立的状态机,靠一条持久化的
通知命令队列缝合**。主对话的生命周期(talk)与子代理的生命周期(work)各自
独立推进,汇合点只有一个——通知入队;而这条队列自带优先级、合批、CAS 认领、
持久账本和分支 fencing。EvoFlow 已经把"缝合点"移植过来了
(`notify_continuation.py`),缺的是队列的可靠性层(账本/CAS/合批/fencing)和
"派发默认不阻塞"的产品语义——这正是阶段 A/B 要补的,也是"员工派工"体验
能否立起来的地基。

---

## 七、前端(EvoPanel)配套改造清单

后端阶段 A/B/C 落地时,页面侧需要同步改的点(ZCode 的对应做法已验证):

| # | 改造点 | 对应后端机制 | ZCode 参考 |
| --- | --- | --- | --- |
| 1 | **子任务运行总览**:会话头部/侧栏显示"N 个子代理运行中",点开看列表(描述、已运行时长、取消按钮) | `child_works` 运行态(`session_child_works_live_footer` 已有数据面) | `background_task_started/updated/completed` 事件 → `projection.backgroundJobs` 面板 |
| 2 | **卡片状态翻转**:通知到达时把对应派工卡从"运行中"→"完成/失败",**不把通知渲染成新用户气泡** | 通知轮是 model-only 消息 | `turn.started` → 解析 `<task-notification>` → 按 `tool-use-id` 回写原工具卡(`zcodeSessionProjection.ts:1288-1319`) |
| 3 | **合批解析**:一个唤醒轮含多个 `<task-notification>` 块,需逐块解析、逐卡翻转 | 阶段 A2 合批 | 合批排序保证 `<task-notification>` 开头块排前,便于逐条解析 |
| 4 | **排队状态独立显示**:子任务"排队中(PENDING)"与"运行中"分开渲染,排队不显示为假运行 | 阶段 B6(PENDING 语义) | registry snapshot 的 status 原样投影 |
| 5 | **通知防误读的呈现**:SYSTEM NOTIFICATION 前缀不直接展示给用户,UI 呈现"后台任务完成"系统样式 | 阶段 A4 前缀 | ZCode 前缀在 provider 层,UI 不渲染原始文本 |
| 6 | **重启补发的呈现**:Gateway 重启后对账补发的 failed/completed 通知同样翻转卡片,不弹错误气泡 | 阶段 A3 账本对账 | 崩溃对账生成 failed 通知,走同一投影 |
| 7 | **员工进度摘要流**(阶段 C):运行中子代理的关键工具活动摘要镜像进父会话卡片(展开可见),不复制全量 transcript | 阶段 C11 | `mirrorSubagentToolEvent` 摘要镜像,父会话只留 Agent 卡 |
| 8 | **双向会话入口**(阶段 C):运行中员工卡片上"发消息"(SendMessage),回复以子卡形式出现在父会话 | 阶段 C8/C9 | SendMessage + RespondToCoordinator 卡片契约 |

数据面备注:`evoflow_session_child_works` 表 + `child_works_for_execution_state()` 已提供
active + recent terminal 的查询,前端总览可直接消费,不需要新表;缺的只是
"通知 → 卡片翻转"的解析与 model-only 过滤。
