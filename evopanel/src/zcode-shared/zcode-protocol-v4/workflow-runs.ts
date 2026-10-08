// ============================================================
// workflowRuns：dwf 引擎 run 的实时运行态 schema（snapshot.ts 的 workflowRuns 键）
// ============================================================
// 从 snapshot.ts 拆出：这块词汇表自成一体（run / actor / node / usage / limits），
// 拆出让 snapshot.ts 回到 max-lines 上限之内（与 workspace-hook-review.ts 同一先例）。

import { z } from "zod";

import { workflowRunArtifactSummarySchema } from "./workflow-artifacts.js";

// ── workflowRuns：dwf 引擎 run 的实时运行态──
// 与 subagents 同一个模式：运行态属于 conversation 权威投影，而不是 renderer 的查询缓存。
// 一条引擎 RunEvent → 一条会话事件 → 这里的键级整体替换，因此不存在「事件 + 另查 RPC」的双时钟。
export const WORKFLOW_RUNS_LIMITS = {
  /** 最近若干个 run；超出按最旧淘汰。 */
  maxRuns: 8,
  /**
   * actors 与 nodes 使用相同的容量上限，避免节点可展示而所属子代理提前被截断。
   * 键级增量使每个事件只传输改动部分；容量上限用于限制单条 run 的投影大小，
   * 并限制异常脚本持续创建条目带来的资源消耗。跨 run 的总量由 {@link maxTotalEntries} 控制。
   * 这是展示状态的容量限制，不限制引擎实际运行的子代理数量。
   */
  maxActors: 1_024,
  maxNodes: 1_024,
  /**
   * 整个状态键的条目预算：所有 run 的 `nodes.length + actors.length` 之和。
   *
   * 单条 run 的界乘以 {@link maxRuns} 是 16384 条，按每条约 150 字节算就是 ~2.5 MB ——
   * 离 16 MiB 的快照上限不远，而快照是要整份序列化的。预算把最坏情形压回 ~1 MB，
   * 代价是**最旧的终态 run** 会提前离场（它的完整事实仍在 journal 里，详情页照样查得到）。
   * 归约在超预算时只淘汰终态 run，绝不动在跑的 run，也绝不动事件所属的那条。
   */
  maxTotalEntries: 6_144,
  /**
   * 详情页 Results 区的**展示**预算，刻意远小于引擎的 run 级 report 上限（256 条）：
   * 协议线上的界是展示预算，引擎的界才是契约，两者不必相等。超出这个界的条目仍在
   * journal 里（`dwf_node.kind = "report"`），只是不进这条高频状态键。
   */
  maxReports: 64,
  maxReportPreviewLength: 2_048,
  maxResultPreviewLength: 2_048,
  maxErrorLength: 2_048,
  /**
   * 同时停驻的升级问题条数。引擎侧的真实上界是
   * per-ask 3 条 × 在飞 ask 数（maxConcurrency），32 因此在任何现实 caps 下都够用；
   * 它同时是一道防线——一个疯掉的脚本不该能把一个高频状态键撑爆。
   */
  maxPendingQuestions: 32,
  /** 问题与补充说明的展示上界。与事件载荷的字符串界（2048）同值，所以正常路径永不截断。 */
  maxQuestionLength: 2_048,
  /** 并发桶的 provider key（`${providerId}/${modelId}`）上界。 */
  maxConcurrencyKeyLength: 256,
  /**
   * 子代理模型串（`providerId/modelId`，可带 `$reasoningLevel` 后缀）的线上上界。与并发桶的
   * provider key 同值：两者是同一族标识串，只是这一条可能多一个推理档后缀。
   */
  maxSubagentModelLength: 256,
  /**
   * `run.concurrencyCeiling` 的上界。天花板按 `min(16, cores − 2)` 推导，这条界只挡坏载荷
   * （reducer 读到界外的值当作读不出，沿用已知值）。
   */
  maxConcurrencyCeiling: 1_024,
  /**
   * 子代理展示名的线上上界（actor.name 与 pendingQuestion.actorName 同值）。名字是脚本作者
   * 写的任意字符串（`agent("reader-" + paths.join("+"))`），reducer 必须按这条界裁剪后再上线：
   * 曾因一个 131 字的名字让父会话之后的每一帧被渲染端拒收，订阅永久失效。
   */
  maxActorNameLength: 128,
  /**
   * 用户面产物的条数。与引擎侧的
   * `ARTIFACT_CAPS.maxArtifactsPerRun` **同值**，理由与 maxReports 的「展示预算 <
   * 引擎契约」相反：产物的引擎上限本来就是 32，把展示界压得更低只会让一个跑在上限上的
   * 脚本在侧板里静默少掉几张卡，而这些卡正是这个特性存在的全部理由。
   */
  maxArtifacts: 32,
  /**
   * 被进入过的阶段条数。与 display
   * 载荷的 `CREATE_WORKFLOW_GRAPH_MAX_PHASES` 同值：时间线上画不出的阶段，投影里也不必记。
   */
  maxPhases: 32,
  /** 阶段名的线上上界，与 display 的 `CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS` 同值（UI 按名字关联两边）。 */
  maxPhaseNameLength: 128,
  /**
   * 一次 ask 的**任务摘要**上界（`node-queued` 的 `instructionsHead`）。与引擎侧的
   * `INSTRUCTIONS_HEAD_MAX_CHARS` 同值：那一头已经按这条界切好，这里是线上的第二道闸。
   * 240 是「一眼看出这个子代理被派去干什么」所需的长度——再长就是在协议线上搬运指令全文，
   * 而指令全文有 journal 与子代理转录两处可去。
   */
  maxInstructionsHeadLength: 240,
  /** 最近一次工具调用的工具名上界（与 actor/node 的 siteId 同量级，工具名是标识符不是文本）。 */
  maxLastToolNameLength: 64,
  /**
   * 最近一次工具调用的**目标**上界（文件路径、命令头）。与引擎侧的
   * `LAST_TOOL_TARGET_MAX_CHARS` 同值。这条界同时是一条安全界：它只放得下一个路径或命令头，
   * 放不下参数全文或文件内容——后两者永远不该出现在这条高频状态键上。
   */
  maxLastToolTargetLength: 120,
} as const;

/**
 * **旧消费者**（没有 `workflowRunDeltas` 能力的那一代）编译进去的 actors / nodes 界。
 *
 * ⚠ 这两个数**永远不能改**：它们不是我们的界，是别人二进制里的校验界。超界的载荷不会被
 * 剥掉一个键——它会让整个 `state.updated` patch 解析失败、整帧被丢，那条订阅从此静默。所以给这类订阅者
 * 发帧前必须先过 `clampWorkflowRunsForLegacy`。
 *
 * 「前 256 条」不是随手取的：旧归约触界时是**拒新**，它产出的恰好就是最早的那 256 条。
 */
export const WORKFLOW_RUNS_LEGACY_LIMITS = {
  maxActors: 256,
  maxNodes: 256,
} as const;

/**
 * 一个被控制流进入过的阶段（`phase("…")` 标记）。`name` 是作者原词（时间线按它关联 display 的 `phases[].name`）；`rounds` 是进入
 * 次数——单调（reducer 取 max），所以 resume 重放的前缀不会把它加倍。
 */
export const workflowRunPhaseSchema = z.object({
  name: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength),
  rounds: z.number().int().positive(),
});
export type WorkflowRunPhase = z.infer<typeof workflowRunPhaseSchema>;

/**
 * 界在某个**出生阶段**上花掉了多少。
 *
 * 两个计数器（{@link workflowRunUsageSchema} 的 `nodesUnlisted` / `nodesUnlistedSettled`）说得出
 * 一条 run 总共少列了多少，说不出少在**哪一站**——而读面是按站画的：一个站点的花名册、计数环和
 * 「N more」都得把自己那格的表外条目加回去，否则宽 fan-out 的站点会显示成一个小数字。
 *
 * `phaseName` 缺席 = 无阶段那一格（出生在任何 `phase()` 标记之前，或旧 CLI 没打戳）。`actors` 是
 * 这个阶段**此刻不在 actor 表上**的子代理数（被拒的、被淘汰的、按孤儿规则摘掉的都算），
 * `actorsSettled` 是其中已知已经结束的、`actorsFailed` 又是其中失败的，`settled` 是记在这一格上的
 * 表外已结算节点数。`actors` 可加可减：一个被淘汰的子代理在下次被派活时会回到表上。
 * 零值的可选子键缺席，四个数全零的格子整个不在（与本文件其余「无则缺席」同规）。
 */
export const workflowRunUnlistedPhaseSchema = z.object({
  phaseName: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength).optional(),
  actors: z.number().int().nonnegative(),
  actorsSettled: z.number().int().nonnegative().optional(),
  actorsFailed: z.number().int().nonnegative().optional(),
  settled: z.number().int().nonnegative(),
});
export type WorkflowRunUnlistedPhase = z.infer<typeof workflowRunUnlistedPhaseSchema>;

/**
 * run 级用量：观察面，不是控制面。`spentTokens` 直接取
 * 引擎 `usage-updated` 事件携带的已花总量（与 `dwf_run.spent_tokens` 同一同步步骤写入，
 * 二者永远相等）；`nodesUsed` 是本 run 已派发（dispatched）的节点数，由节点事件计数——
 * 没有任何上限可以拿来反算，也不需要。
 */
export const workflowRunUsageSchema = z.object({
  spentTokens: z.number().int().nonnegative(),
  nodesUsed: z.number().int().nonnegative(),
  /**
   * 撞上 {@link WORKFLOW_RUNS_LIMITS.maxNodes} 被**拒之表外**的实例数，以及其中已结算的条数。`truncated` 只说得出「有东西没进来」，说不出
   * 有多少——于是一个 3000 路 fan-out 的 run 在读面上会显示成「1024 步」，那是一句假话。
   *
   * 两条都是**加出来**的计数（被拒实例根本不在表里，没有可去重的身份），所以归约只在事件
   * **抬过水位**时才计，重传的队尾事件不会把它们越推越高。`run-started` 连同整个 usage 一起
   * 清零：resume 会把脚本前缀重发一遍，不清零等于把两世的步数加在一起。零时整个键缺席。
   */
  nodesUnlisted: z.number().int().nonnegative().optional(),
  nodesUnlistedSettled: z.number().int().nonnegative().optional(),
});
export type WorkflowRunUsage = z.infer<typeof workflowRunUsageSchema>;

/**
 * 一个 actor 实例。`status` 是**派生**的三态：
 * 引擎的 Boundary C 除了 `actor-created` 之外不发任何 actor 生命周期事件，所以状态从该 actor 的
 * 节点与 run 的终态推出来——
 *   - `running`：有节点处于 executing / repairing / nudged（模型请求已发出、正在跑）；
 *   - `waiting`：有 live 节点（queued / dispatched / waiting：还没派下去、在等槽位或在退避），
 *     **或**尚无任何节点而 run 未终态（建了还没被 ask）；
 *   - `completed`：其余（全部节点已结算，或 run 已终态）。
 * 不存在可观察的 actor 级 failed：某次 ask 失败仍是「它的活干完了」，结果在节点上。
 *
 * `sessionId` 是 actor 会话 id（phase 5 的 transcript 下钻直接读它）。它同样不在 Boundary C 上，
 * 而是 run service 按 `(runId, actorRef)` 确定性铸造的同一个函数算出来的。
 */
export const workflowRunActorSchema = z.object({
  siteId: z.string().min(1).max(64),
  ordinal: z.number().int().nonnegative(),
  name: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxActorNameLength).optional(),
  sessionId: z.string().min(1).max(256).optional(),
  status: z.enum(["waiting", "running", "completed"]),
  /**
   * 这个实例**出生**在哪个阶段：它的 ordinal 被铸造的那一刻，控制流所在的 `phase("…")` 标记名。UI 按**名字**与 `phases[].name`
   * 关联——名字是引擎与分析器唯一共享的词汇，所以界与 `maxPhaseNameLength` 同值。
   *
   * 缺席有两种读法，消费者都要认：出生在任何标记之前（脚本没写 `phase()`，或写在后面），
   * 或者发事件的是不带这个键的旧 CLI。
   */
  phaseName: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength).optional(),
});
export type WorkflowRunActor = z.infer<typeof workflowRunActorSchema>;

/**
 * 一次 ask 里**最近一次**工具调用（`node-progress` 携带）。`name` 是工具名；`target` 是一个
 * 短到能当标签用的目标——文件工具的路径、Bash 的命令头，读不出时缺席。
 *
 * **刻意只有这两个键**：参数全文与文件内容不进这条高频状态键（每个已解析轮次发一条），
 * 它们在 journal 与子代理转录里。`target` 的界因此既是展示预算也是那条约束的守卫。
 */
export const workflowRunNodeLastToolSchema = z.object({
  name: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxLastToolNameLength),
  target: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxLastToolTargetLength).optional(),
});
export type WorkflowRunNodeLastTool = z.infer<typeof workflowRunNodeLastToolSchema>;

/**
 * 一个节点（ask / world-read）实例。`phase` 就是引擎**实际发出的**节点事件：
 *   queued → dispatched → executing ⇄ waiting → (repairing | nudged) → settled。
 * `executing` / `waiting` 来自 driver 的观察：
 * `node-executing` = 该 ask 的模型请求真的发出去了；`node-waiting` = 它在等进程级槽位或在退避。
 * `dispatched` 因此是「会话就绪、首个请求尚未准入」的短暂相位，读面把它与 queued / waiting 同归「等待」。
 *
 * `kind` 可缺省：resume 的完结命中短路直接发 `node-settled`（ask 走 scheduler.ts 的
 * releaseCachedAsk / tryImportedSettle，world-read 走 engine-world.ts 的重放与导入命中），
 * 不经 `node-queued`，而 kind 只在 queued 上携带。
 */
export const workflowRunNodeSchema = z.object({
  siteId: z.string().min(1).max(64),
  ordinal: z.number().int().nonnegative(),
  kind: z.enum(["ask", "world-read"]).optional(),
  phase: z.enum(["queued", "dispatched", "executing", "waiting", "repairing", "nudged", "settled"]),
  outcome: z.enum(["ok", "failed", "cancelled"]).optional(),
  cached: z.boolean().optional(),
  /** 该节点所属 actor 的站点 id（world-read 无 actor）。 */
  actorSiteId: z.string().min(1).max(64).optional(),
  actorOrdinal: z.number().int().nonnegative().optional(),
  /**
   * 这个实例**出生**在哪个阶段，
   * 语义与 {@link workflowRunActorSchema} 的同名键逐字相同：ordinal 被铸造那一刻的
   * `phase("…")` 标记名，UI 按名字与 `phases[].name` 关联；缺席 = 出生在任何标记之前，或旧 CLI。
   *
   * ⚠ 与上面的 `phase` **不是**一回事：`phase` 是节点的生命周期相位（queued / executing /
   * settled…），`phaseName` 是脚本阶段坐标。字段特意不叫 `phase` 就是为了不把两个概念揉在一起。
   *
   * 引擎只在**出生事件**上打戳（`node-queued`，以及 replay 命中时直接发的
   * `node-settled { cached: true }`）；其余 `node-*` 不带，由 reducer 向前携带。
   */
  phaseName: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength).optional(),
  /**
   * 这次 ask 的**任务**：作者写的 `instructions` 的头 240 字，随 `node-queued` 到达。读面据它回答「这个子代理被派去干什么」——
   * 相位只说得出「在跑」，说不出在跑什么。
   *
   * 是**作者原文**的头，不含引擎后来追加的尾注（那些是运行时脚手架，不是任务）。
   * 缺席有两种读法，消费者都要认：world-read 节点（没有指令），或不带这个键的旧 CLI/旧 journal。
   */
  instructionsHead: z
    .string()
    .min(1)
    .max(WORKFLOW_RUNS_LIMITS.maxInstructionsHeadLength)
    .optional(),
  /**
   * 这次 ask 走到第几个已解析轮次（1 起，nudge 轮次计入），以及累计工具调用数与最近一次
   * 工具调用——随 `node-progress` 到达，每个已解析轮次一条。
   *
   * 三者一起回答「它在动吗」：一个卡在 `executing` 十分钟的 ask，只有这几个读数能分出
   * 「在干一件长活」与「已经死了」。**没有 `node-progress` 的旧 journal 上三键全缺席**，
   * 读面必须把缺席显示成「不知道」，而不是显示成 0 —— 0 是「一个工具都没调过」的事实。
   *
   * 归约是**后来者覆盖**而不是取 max（与 `phases[].rounds` 相反）：同一实例在 resume 里被
   * 重新 queue 时是一次全新的 ask，轮次从 1 重新数，取 max 会把上一世的读数冻在这里。
   */
  turn: z.number().int().positive().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  lastTool: workflowRunNodeLastToolSchema.optional(),
});
export type WorkflowRunNode = z.infer<typeof workflowRunNodeSchema>;

/**
 * 本 run 的并发现状。两条界，
 * 实际并发是**两者取小**：
 *
 * - `cap`：本 run 所在 provider key 的**共享**闸门现状（治理器按 key 分桶、按 run 扇出，
 *   随 `concurrency-changed` 移动）；`ceiling`：CPU 推导的天花板。事件本身不带 ceiling，
 *   归约按该 run 见过的最大 `previous` / `next` 推导（桶从天花板起步，所以第一条事件的
 *   `previous` 就是它；只降不升的序列里它也恒是最大值）。
 * - `limit`：本 run **自己的**界（`CreateWorkflow` / `AmendWorkflow` 的 `max_concurrency`
 *   落到 `caps.maxConcurrency`），随 `run-started` 到达、整条 run 不动。**只在低于天花板时
 *   在场**：跑在天花板上的 run 与从前一模一样，一个键都不多。
 * - `cooldownMs`：带 Retry-After 的限流冻结新派发的时长，**相对量**（同 `retryInMs` 的理由）；
 *   `idle_reset` 与 run 终态清掉它。
 *
 * UI 只在 `min(cap, limit) < ceiling` 时显示读数（见 workflowRunConcurrencyView）。
 */
export const workflowRunConcurrencySchema = z.object({
  key: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxConcurrencyKeyLength).optional(),
  cap: z.number().int().positive(),
  ceiling: z.number().int().positive(),
  limit: z.number().int().positive().optional(),
  cooldownMs: z.number().int().nonnegative().optional(),
});
export type WorkflowRunConcurrency = z.infer<typeof workflowRunConcurrencySchema>;

/**
 * 一条脚本 `report(item)` 交出的**渐进产物**（详情页 Results 区的一行）。
 *
 * `report` 与 `log` 不同类：它有 site 身份、进 journal、有自己的 `RunEvent`，所以它进
 * 事件日志、进 Results 区、也随完成通知回给模型；但它**不进因果图**（纯进度发射、
 * 无任何顺序意义），也**不进 `nodes[]`**——报得勤的工作流不该显得步数虚高。
 *
 * `siteId × ordinal` 是身份（journal 的键），也是归约的去重键：脚本 replay 时每个
 * `report` 调用都会重跑，同一实例必须落成同一行而不是两行。
 *
 * 存**预览文本**而不是原值：序列化规则（string 原样；其余 pretty JSON）与 run 产物
 * 回投那条路径同源，一次算在 CLI 侧，renderer 因此不需要复制一份序列化契约；顺带
 * 让「协议边界上的所有载荷有界」这条不变量落在一个 string 上界上。
 */
export const workflowRunReportSchema = z.object({
  siteId: z.string().min(1).max(64),
  ordinal: z.number().int().nonnegative(),
  preview: z.string().max(WORKFLOW_RUNS_LIMITS.maxReportPreviewLength),
  /**
   * `report(item, artifactId)` 的第二实参：这条条目喂给哪个**预置看板**。缺席 = 没打标签，照旧只进 Results 区。
   *
   * 带标签的条目**仍然进 `reports`**：一条通道一套上限，标签只是多一个去处，不是改道。
   * 上界与产物 id 同（64），因为它就是一个产物 id。
   */
  artifactId: z.string().min(1).max(64).optional(),
});
export type WorkflowRunReport = z.infer<typeof workflowRunReportSchema>;

/**
 * 一个**停驻中**的升级问题：某个 actor 撞上真阻塞
 * （坏门、指令自相矛盾、缺关键事实），把问题升级给主代理，并停在自己那次 ask 里等答案。
 *
 * 身份是 `qid`（全局唯一、跨 run），不是站点实例——升级**没有** site 身份：它不写 dwf_node
 * 行、不占 maxNodes，是一次 ask 轮次**内部**的慢工具调用。所以去重键是 qid，而 actor 只是
 * 一个属性。这与 nodes/actors/reports 那三张按 (siteId, ordinal) 去重的表是不同的族。
 *
 * `actorSiteId` / `actorOrdinal` 因此可缺省（形态照抄 `WorkflowRunNode` 的同名一对）：一条
 * 问不出提问者是谁的记录仍然要显示——这个特性存在的理由就是让被卡住的问题**可见**，为了
 * 一个读不动的 actor ref 把整条问题藏起来，恰好毁掉它唯一的兜底价值。`actorName` 是 persona
 * 名，匿名 actor 缺席（事件侧刻意不合成兜底标签，由消费者各自决定怎么渲染「无名」）。
 *
 * **纯内存、随 run 终态清空**：真相是 CLI 进程内的停驻 deferred。进程一死那些 deferred 就没了，
 * 于是「还欠谁一个答案」这件事在终态 run 上恒为假——终态 run 按定义没有在听的人。
 */
export const workflowRunPendingQuestionSchema = z.object({
  /** 全局唯一的问题 id（形如 `dwfq-<runId 片段>-<seq>`）。主代理按它作答。 */
  qid: z.string().min(1).max(128),
  actorSiteId: z.string().min(1).max(64).optional(),
  actorOrdinal: z.number().int().nonnegative().optional(),
  actorName: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxActorNameLength).optional(),
  question: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxQuestionLength),
  context: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxQuestionLength).optional(),
  /**
   * 提问时刻（epoch 毫秒），由事件携带——本模块是纯归约，没有时钟可用。
   *
   * 事件侧**必填**（driver 是唯一生产者，与停驻记录取同一个 `Date.now()`），这里仍然 optional：
   * 老开发机上的 journal 可能重放出 askedAt 之前的事件。所以渲染侧按「有则显示等待时长」处理，
   * 缺席不是错误。
   */
  askedAt: z.number().int().nonnegative().optional(),
});
export type WorkflowRunPendingQuestion = z.infer<typeof workflowRunPendingQuestionSchema>;

export const workflowRunSchema = z.object({
  runId: z.string().min(1).max(128),
  /** 发起该 run 的 CreateWorkflow 工具调用（工具卡 → 详情页的关联键）。 */
  toolCallId: z.string().min(1).max(128).optional(),
  status: z.enum(["pending", "running", "completed", "errored", "stopped"]),
  /** `status === "stopped"` 才在场。 */
  stopReason: z.enum(["user", "model", "provider", "interrupted", "superseded"]).optional(),
  /**
   * lineage 的两端：本 run 修订自哪个 run
   * （`run-started` 载荷的 `resumedFrom`），以及本 run 被哪次修订停下并替代（`run-settled` 载荷的
   * `supersededBy`，只随 `stopReason: "superseded"` 出现）。两者都 optional，理由与 `reports` 同：
   * 往已有状态键追加字段，旧 CLI 不发它们时少一个键是退化，不是整帧被丢。
   */
  resumedFrom: z.string().min(1).max(128).optional(),
  supersededBy: z.string().min(1).max(128).optional(),
  usage: workflowRunUsageSchema,
  error: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxErrorLength).optional(),
  /**
   * 可恢复。**为真才在场**。
   *
   * 由 CLI 在 `run-settled` 载荷上按 resume 门的同一个谓词给出（live 由 toProgressPayload 算，
   * 冷回放由补种按 journal 行算），reducer 只搬运——UI 绝不自行按 status + failureCode 推导
   * （两处谓词总有一天不一致：按钮亮着但命令被拒）。optional 的理由与 `reports` 同：往已有
   * 状态键追加字段，旧 CLI 不发它时少一个键是退化，不是整帧被丢。
   */
  resumable: z.literal(true).optional(),
  resultPreview: z.string().max(WORKFLOW_RUNS_LIMITS.maxResultPreviewLength).optional(),
  actors: z.array(workflowRunActorSchema).max(WORKFLOW_RUNS_LIMITS.maxActors),
  nodes: z.array(workflowRunNodeSchema).max(WORKFLOW_RUNS_LIMITS.maxNodes),
  /**
   * `report(item)` 交出的渐进产物，按报告顺序。**零条时整个键缺席**（不是空数组）：
   * Results 区据此整区不渲染，而不是给不用 `report` 的工作流留一节空壳。
   *
   * 刻意 optional 而不是必填：这是往一个**已有状态键**上追加字段，而已知键上的解析错误
   * 不会被剥离——它会让整个 `state.updated` patch 失败、整帧被丢。
   * 必填意味着任何一个不发 reports 的旧 CLI 都会触发那一档；optional 让它退化成「少一个键」。
   */
  reports: z.array(workflowRunReportSchema).max(WORKFLOW_RUNS_LIMITS.maxReports).optional(),
  /**
   * 停驻中的升级问题，按提问顺序。**零条时整个键缺席**（不是空数组），与 `reports` 同一条
   * 惯例：侧栏据此整区不渲染，而不是给一个没人提问的 run 留一节空壳。
   *
   * 「零条」是这个键的**常态**，而且它会来回进出：问题一被作答就从表里消失，答完最后一个
   * 又退回缺席。所以消费者不能把「见过一次这个键」当成它会一直在。
   *
   * optional 的第二个理由与 `reports` 相同：这是往一个**已有状态键**上追加字段，而已知键上的
   * 解析错误不会被剥离——必填会让任何一个不发该字段的旧 CLI 整帧被丢。
   */
  pendingQuestions: z
    .array(workflowRunPendingQuestionSchema)
    .max(WORKFLOW_RUNS_LIMITS.maxPendingQuestions)
    .optional(),
  /**
   * 并发现状（见 {@link workflowRunConcurrencySchema}）。只在**两条界里有一条低于天花板**时
   * 在场：收到过 `concurrency-changed`（共享桶被限流压低），或 `run-started` 带来一个低于天花板
   * 的 `limit`（用户给这次 run 定了上限）。两者都没有的 run 一直跑在天花板上，没有可说的。
   * optional 的理由与 `reports` / `pendingQuestions` 同。
   */
  concurrency: workflowRunConcurrencySchema.optional(),
  /**
   * 本机的并发天花板（`run-started` 载荷的 `concurrencyCeiling`，CLI 铸载荷时拼进去的进程事实）。
   * 与 `concurrency.ceiling` 不同：那是读数芯片自己的水位，只随芯片在场；这一个**只要读得到就在**，
   * 不论本 run 是否低于它——「配置」弹层的步进器停在这里。optional 的理由与 `concurrency` 同：老 CLI 不发，少一个键是退化。
   */
  concurrencyCeiling: z
    .number()
    .int()
    .positive()
    .max(WORKFLOW_RUNS_LIMITS.maxConcurrencyCeiling)
    .optional(),
  /**
   * 这次 run 的**子代理**跑在哪个模型上（`CreateWorkflow` / `AmendWorkflow` 的 `subagent_model`
   * 落到载荷的 `subagentModel`），规范串 `providerId/modelId`，可带 `$reasoningLevel` 后缀。
   * 随 `run-started` 到达、整条 run 不动——与 `concurrency.limit` 同族：用户给这次 run 定下的
   * 条件，不随运行时涨落。
   *
   * **只在用户给这次 run 指定过模型时在场**：不指定的 run 里子代理跟随会话模型，没有可说的。
   * 主代理无论如何都留在会话模型上，所以这个键说的只是子代理那一侧。
   * optional 的理由与 `reports` / `concurrency` 逐字相同：往已有状态键追加字段，旧 CLI 不发它时
   * 少一个键是退化，不是整帧被丢。
   */
  subagentModel: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxSubagentModelLength).optional(),
  /**
   * 本 run 发布的**用户面产物**，按首次出现顺序，每项只带**最新版**的元数据。**零件时整个键缺席**（不是空数组）：
   * 侧板的 Artifacts 区据此整区不渲染——「无则缺席」与 `reports` / `pendingQuestions` 同规。
   *
   * optional 的第二个理由与 `reports` 逐字相同，也是这里真正要紧的那个：这是往一个**已有
   * 状态键**上追加字段，而已知键上的解析错误不会被剥离——必填会让任何一个不发产物的旧 CLI
   * 整帧被丢。少一个键是退化，不是错误。
   *
   * ⚠ 术语：这里的 artifact 是脚本发布给用户看的产出，不是 `resultPreview` 背后那个
   * 「脚本顶层返回值」（引擎内部也叫 artifact）。见 workflow-artifacts.ts 的文件头。
   */
  artifacts: z
    .array(workflowRunArtifactSummarySchema)
    .max(WORKFLOW_RUNS_LIMITS.maxArtifacts)
    .optional(),
  /**
   * 被进入过的阶段，按首次进入顺序。
   * **零条时整个键缺席**；optional 的理由与 `reports` 逐字相同（旧 CLI 不发它，少一个键是退化
   * 不是错误）。时间线据它给零成员的站点灯、给所有站补「第一个 ask 派发之前」那段的 running。
   */
  phases: z.array(workflowRunPhaseSchema).max(WORKFLOW_RUNS_LIMITS.maxPhases).optional(),
  /** 控制流最后进入的阶段名（最后一条 `phase-entered`）；从未进入过任何阶段时缺席。 */
  currentPhase: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength).optional(),
  /**
   * 脚本**声明**的阶段表，按声明序（`run-launched.phaseNames`）。与 `phases`（已进入的）互补：侧栏迷你轨道据此画出前方还没到的站点。
   * 零条 / 旧 CLI / 无标记脚本时整个键缺席。
   */
  phaseNames: z
    .array(z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength))
    .max(WORKFLOW_RUNS_LIMITS.maxPhases)
    .optional(),
  /**
   * 与 `phaseNames` **按位置对齐**的「同时在跑」表（`run-launched.phaseAlongside`）：
   * `phaseAlongside[i]` 是进入 `phaseNames[i]` 时 strand 仍在跑的其他阶段的**下标**，下标落在
   * `phaseNames` 这张表上。侧栏迷你轨道据此把并行的两站之间画成双线段
   *
   * 依附 `phaseNames`：后者不在场时它一定不在场；没有任何阶段并行时同样缺席——缺席就是
   * 「这条轨道是一条直线」。归约保证每个下标都落在被接受的那张表里（workflow-runs-phases.ts）。
   */
  phaseAlongside: z
    .array(z.array(z.number().int().nonnegative()).max(WORKFLOW_RUNS_LIMITS.maxPhases))
    .max(WORKFLOW_RUNS_LIMITS.maxPhases)
    .optional(),
  /**
   * 界在各个出生阶段上花掉了多少（见 {@link workflowRunUnlistedPhaseSchema}）。**一格都没有时
   * 整个键缺席**。表长比 `maxPhases` 多一格：那一格是「无阶段」，它与具名阶段共用同一张表。
   *
   * 表满之后新阶段的归属**丢掉**，run 级两个计数器照旧准——一个站点可以少一个它本来就没有的
   * 数字，run 的总数不可以说假话。
   */
  unlistedByPhase: z
    .array(workflowRunUnlistedPhaseSchema)
    .max(WORKFLOW_RUNS_LIMITS.maxPhases + 1)
    .optional(),
  /**
   * actors / nodes / reports / pendingQuestions / artifacts / phases 触到上限后置位；
   * 原始事实仍在 journal。淘汰（给活的新人腾位）同样置位：这条 run 的条目表已经装不下它
   * 自己的事实了，而 `run-started` 正是按这一位决定新一世要不要从空表重开。
   */
  truncated: z.boolean().optional(),
  /** 最后一条已归约事件的 journal sequence；抬升即事件日志重取的触发条件。 */
  lastEventSequence: z.number().int().nonnegative(),
});
export type WorkflowRunState = z.infer<typeof workflowRunSchema>;

export const workflowRunsStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  runs: z.array(workflowRunSchema).max(WORKFLOW_RUNS_LIMITS.maxRuns),
});
export type WorkflowRunsState = z.infer<typeof workflowRunsStateSchema>;
