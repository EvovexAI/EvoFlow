// ============================================================
// workflow 轮的行级元数据（rows.ts 的 turnHeader / userInput 成员）
// ============================================================
// 从 rows.ts 拆出：通知 manifest、后台结果归属、直接启动三段 schema 让 rows.ts 越过
// max-lines 上限（与 create-workflow-display.ts 同一先例——特性级 schema 单独成模块）。
// 对外名字不变：rows.ts 原样再导出，@zcode/shared 桶与相对导入两条路都照旧。

import { z } from "zod";
import { toolCallCreateWorkflowDisplaySchema } from "./create-workflow-display.js";
import { WORKFLOW_RUNS_LIMITS } from "./workflow-runs.js";

// workflow 通知的结构化载荷。
// 发射侧铸造、有界；禁止从模型面通知文本反解析。上界原则：载荷随 turnHeader row
// 走协议 + snapshot，截断诚实（resultTruncated / count≠shown ⇒ 预览是局部的，
// 全量经 run id 可取）。批量轮刻意不携带（一轮一张 manifest 在批量下不成立）。
export const workflowNotificationMetaSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("terminal"),
    status: z.enum(["completed", "errored", "stopped"]),
    // `status === "stopped"` 才在场。
    stopReason: z.enum(["user", "model", "provider", "interrupted", "superseded"]).optional(),
    summary: z.string().min(1).max(500),
    result: z.string().max(4000).optional(),
    resultForm: z.enum(["prose", "json"]).optional(),
    resultTruncated: z.literal(true).optional(),
    error: z.string().max(2000).optional(),
    reports: z
      .object({
        count: z.number().int().nonnegative(),
        shown: z.number().int().nonnegative(),
        preview: z.array(z.string().max(500)).max(8),
      })
      .optional(),
    // 用户面产物的 chips 载荷。
    // ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户看的产出，与同一载荷上的
    // `result`（脚本顶层返回值，引擎内部也叫 artifact）无关。
    // 只带 chip 画得下的字段：字节数 / 条目数点开侧板即可看到，chip 上放不下。
    // 上界 8，超出（含被种类过滤掉的）置 artifactsTruncated；title 的 120 与
    // ARTIFACT_CAPS.maxTitleLength 同值，发射侧就地截断。
    // 例外是交付物（`primary`）那一条：它还带 `description`（≤ 500，同 ARTIFACT_CAPS），因为
    // 完成卡把它画成一行带文字的交付物，冷 transcript 上只有这个载荷可读。清单 primary 在前。
    artifacts: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          kind: z.enum(["file", "markdown", "chart", "table", "metrics", "board"]),
          title: z.string().max(120).optional(),
          version: z.number().int().positive(),
          contentType: z.string().max(255).optional(),
          primary: z.literal(true).optional(),
          description: z.string().max(500).optional(),
        }),
      )
      .max(8)
      .optional(),
    artifactsTruncated: z.literal(true).optional(),
    durationMs: z.number().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("escalation"),
    qid: z.string().min(1),
    actor: z.string().min(1),
    question: z.string().min(1).max(4000),
    context: z.string().max(4000).optional(),
    askedAt: z.number().optional(),
  }),
  // run 级停滞：每个 stall 段一条，不是终态。
  z.object({
    kind: z.literal("stall"),
    sinceMs: z.number().int().nonnegative(),
    reason: z.string().max(64).optional(),
    cap: z.number().int().nonnegative().optional(),
  }),
]);
export type WorkflowNotificationMeta = z.infer<typeof workflowNotificationMetaSchema>;

export const backgroundResultOriginMetaSchema = z.object({
  // 三个取值与 contracts 的 BackgroundResultOriginMeta 保持同步。
  // "workflow" 是 dynamic-workflow run（workId ≡ runId），复用整条后台通知管线。
  backgroundSource: z.enum(["bash", "subagent", "workflow"]),
  workId: z.string().min(1),
  title: z.string().min(1),
  // 只在 backgroundSource === "workflow" 的单条通知轮上在场；zod 剥离未知键，
  // 这里不加即整条链路静默丢——本字段是 manifest 渲染的唯一数据源。
  workflowNotification: workflowNotificationMetaSchema.optional(),
});
export type BackgroundResultOriginMeta = z.infer<typeof backgroundResultOriginMetaSchema>;

// 直接启动的启动轮元数据。
// GUI 用中枢的「运行」在新会话里直接启动一个已保存工作流，agent 铸造一条 controlOnly 轮；
// 该轮的 turnHeader 与 userInput 都以 origin: "workflowLaunch" 投影，并各自携带这一份元数据。
// 冷恢复（消息 metadata）与活投影（TurnStarted payload）取同一份，冷热同形。
// 上界原则与 workflowNotificationMetaSchema 一致：发射侧铸造、有界、截断诚实——
// 全量脚本 / 诊断经 runId 在详情侧板可取，卡片上只画这份定长摘要。
// 刻意不复用 backgroundResultOriginMeta 的 backgroundSource 形状：那是「后台通知归属」，
// 这里是「用户从中枢发起的启动」，语义不同，形状独立以免两处交叉演进时互相拖累。
const workflowSubagentModelTextSchema = z
  .string()
  .min(1)
  .max(WORKFLOW_RUNS_LIMITS.maxSubagentModelLength);

// 设置轮：用户在 run 卡 / 详情页的「配置」里
// 改了设置，agent 以同一份脚本修订出新 run，并用一条与直接启动同形的 controlOnly 轮记下这件事。
// 这一块说**改了什么**：只有改动过的设置在场；每一项的 from / to 缺一端即那一端是默认
// （模型 = 会话模型，上限 = 本机上限）。`ceiling` 是本机上限，供「13 → 4」这种读法。
export const workflowSettingsAmendMetaSchema = z.object({
  // 修订自哪个 run。**缺席 = 就地生效**：只改并发上限、run
  // 又在飞时，那次「配置」不停这次 run、也不另起一次，于是没有前驱可指——`runId` 指的就是被调整的
  // 那一个。渲染端据此只出那一行、不再出卡（同一条 run 画两张卡会读成两次运行）。
  // 此字段为可选；生产者和消费者需使用一致的 schema 才能解析就地调整的设置记录。
  predecessorRunId: z.string().min(1).max(128).optional(),
  subagentModel: z
    .object({
      from: workflowSubagentModelTextSchema.optional(),
      to: workflowSubagentModelTextSchema.optional(),
    })
    .optional(),
  maxConcurrency: z
    .object({
      from: z.number().int().positive().optional(),
      to: z.number().int().positive().optional(),
    })
    .optional(),
  ceiling: z.number().int().positive().optional(),
});
export type WorkflowSettingsAmendMeta = z.infer<typeof workflowSettingsAmendMetaSchema>;

export const workflowLaunchMetaSchema = z.object({
  // runId ≡ workId：驱动启动轮 run 卡的实时状态 / 步数，也是取消 / 恢复 / 详情侧板的联接键。
  runId: z.string().min(1).max(128),
  // launch-<uuid> 前缀（区别于模型工具调用 id）；与合成 CreateWorkflow toolCall 同一个 id。
  toolCallId: z.string().min(1).max(128),
  // 解析结果里的工作流名（由 agent 填，用户与模型都不能另起）。中枢启动恒在场；设置轮
  // 取被调整的 run 自己的名字，没起过名的 run 就没有——卡片与侧板照任何无名 run 的规矩换用兜底词，
  // 而不是把一个 run id 当标题。
  name: z.string().min(1).max(200).optional(),
  // scope / path 只属于中枢启动：设置轮（下方 `amend`）改的是一个已有 run，没有保存文件可指。
  // 记录在案的偏斜：旧桌面上它们是必填，新 CLI 的设置轮在那里 parse 失败、整行被丢（与
  // origin 闭集加值同一档）；中枢启动轮两者恒在，不受影响。
  scope: z.enum(["project", "global"]).optional(),
  // 命中的脚本落盘路径；仅供详情 / 诊断，卡片不显示。1024 覆盖深层全局 / 项目路径。
  path: z.string().min(1).max(1024).optional(),
  // 实参键值表（卡片渲染源）。有界：序列化 ≤ 4KB，与 contracts 侧 TurnStartedPayload 同界，
  // 防止把整个大对象塞进每条持久消息与活事件。
  args: z
    .record(z.string(), z.unknown())
    .refine((value) => JSON.stringify(value).length <= 4096, {
      message: "workflowLaunch.args JSON must be ≤ 4096 bytes",
    })
    .optional(),
  // 说明行（若有）；与实参窗 / 中枢卡同一段文案，500 与通知 summary 同界。
  description: z.string().max(500).optional(),
  // 启动前编译得到的 create_workflow display（有界因果图 + 诊断）：run 详情侧板按 toolCallId 找
  // 「发起行」取图，直接启动没有工具行，图从这里取。与工具行 display 同一 schema。
  // 同样不设门：图解析失败只是这一行没有图，不拒整帧（见 toolDisplay.ts 注释）。
  display: toolCallCreateWorkflowDisplaySchema.optional().catch(undefined),
  // 本次 run 实际执行的脚本原文（侧板 Script 区），对应工具行的 input.script；上界与 contracts
  // WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS 同值。
  script: z.string().max(256_000).optional(),
  // 设置轮才在场：这次 run 是用「配置」从哪个 run 修订来的、改了什么。
  amend: workflowSettingsAmendMetaSchema.optional(),
});
export type WorkflowLaunchMeta = z.infer<typeof workflowLaunchMetaSchema>;
