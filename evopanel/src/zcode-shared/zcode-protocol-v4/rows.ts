// ConversationRow：行类型自包含。
// 三条结构性规则：row 自包含（渲染任一行不需看别的行）；
// 结构变化换整行（row.upserted），文本增长用 append（row.delta）；turn 是 row 上的标签不是容器。
import { z } from "zod";
import { executionOutputPreviewSchema } from "../execution-output-preview.js";
import { timestampSchema } from "./core.js";
import { backgroundResultOriginMetaSchema, workflowLaunchMetaSchema } from "./workflow-row-meta.js";

// RowBase。rowId：session 内单调、永不复用、事件日志的确定性纯函数。
const rowBaseFields = {
  rowId: z.number(),
  turnId: z.string(),
  // canonical identity：新 CLI 每行必传；optional 只用于兼容旧版帧。
  // entityId 定位持久实体，productTurnId 是产品轮次，不得由 UI 重猜。
  entityId: z.string().min(1).optional(),
  productTurnId: z.string().min(1).optional(),
  visibility: z.literal("visible").optional(),
  createdAt: timestampSchema,
  createdAtSeq: z.number(),
  // 缺省全 false；只下发为 true 的键。canRewind 不在载荷内（rewind = editUserQuery 的 UI 入口）。
  actions: z
    .object({
      canFork: z.literal(true).optional(),
      canEdit: z.literal(true).optional(),
      canRetry: z.literal(true).optional(),
      canRewindFiles: z.literal(true).optional(),
      editDisposition: z.enum(["rewind", "fork"]).optional(),
    })
    .optional(),
} as const;

export const rowActionsSchema = rowBaseFields.actions;
export type RowActions = NonNullable<z.infer<typeof rowActionsSchema>>;

// workflow 轮的行级元数据拆到了 workflow-row-meta.ts（max-lines）；名字在此原样再导出。
export {
  backgroundResultOriginMetaSchema,
  workflowLaunchMetaSchema,
  workflowNotificationMetaSchema,
  workflowSettingsAmendMetaSchema,
  type BackgroundResultOriginMeta,
  type WorkflowLaunchMeta,
  type WorkflowNotificationMeta,
  type WorkflowSettingsAmendMeta,
} from "./workflow-row-meta.js";

export const turnWorkSegmentSchema = z.object({
  segmentId: z.string().min(1),
  triggerEntityId: z.string().min(1).optional(),
  startedAt: timestampSchema,
  endedAt: timestampSchema.optional(),
  activeMs: z.number().nonnegative().optional(),
});
export type TurnWorkSegment = z.infer<typeof turnWorkSegmentSchema>;

// turnHeader：product turn 边界 + 权威工时 + 每轮文件摘要。
// guide 产生的内部折叠边界由 workSegments 表达；行归属仍由 CLI 决定，客户端零归属逻辑。
export const turnHeaderRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("turnHeader"),
  // workflowLaunch：中枢直接启动的 controlOnly 轮。
  // 记录在案的偏斜：闭集枚举加值 → 旧桌面 + 新 CLI 时该行 parse 失败被丢（与下方
  // backgroundSource: "workflow" 加值同一档），CLI 与桌面同批发布下接受。
  origin: z.enum([
    "userInput",
    "backgroundResult",
    "goalContinuation",
    "editRerun",
    "workflowLaunch",
  ]),
  // 执行语义由 CLI 投影裁决；UI 不得根据输入文本或 duration 反推。
  // optional 仅用于兼容旧 snapshot，新的 turnHeader 一律显式写入。
  executionKind: z.enum(["agent", "controlOnly"]).optional(),
  // 当前 query 的命令归因与历史轮次数；optional 兼容旧 transcript/snapshot。
  sourceCommandId: z.string().optional(),
  historyRoundCount: z.number().int().nonnegative().optional(),
  state: z.enum(["running", "completedSuccess", "completedInterrupted", "failed"]),
  startedAt: timestampSchema,
  endedAt: timestampSchema.optional(),
  // 权威工时：排除权限等待/用户输入等待/verifier 等待。
  activeMs: z.number().optional(),
  // guide 不切 product turn，但每条 accepted guide 都开启独立视觉工作段。
  // 普通 turn 缺省以保持旧 snapshot 兼容；一旦出现 guide，CLI 负责完整投影首段与后续段。
  workSegments: z.array(turnWorkSegmentSchema).optional(),
  originMeta: backgroundResultOriginMetaSchema.optional(),
  // origin === "workflowLaunch" 的轮上在场（活投影来源）；与 originMeta 并列，不复用其形状。
  workflowLaunch: workflowLaunchMetaSchema.optional(),
  fileChanges: z
    .object({
      additions: z.number(),
      deletions: z.number(),
      files: z.number(),
      state: z.enum(["active", "reverted"]).optional(),
    })
    .optional(),
});
export type TurnHeaderRow = z.infer<typeof turnHeaderRowSchema>;

// userInput。originMeta 消灭文本嗅探。
export const userInputRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("userInput"),
  text: z.string(),
  // text 从此下标起是引擎附加文本（dwf ask 尾注 /
  // nudge），GUI 把它折进默认收起的披露；0 = 整条都是；缺席 = 无（老转录、非工作流会话）。
  epilogueStart: z.number().int().nonnegative().optional(),
  // workflowLaunch：中枢直接启动轮的用户可见行。
  // 消息文本仍进 text（旧客户端 / TUI 的降级呈现就是那句规范英文）；新客户端用下方
  // workflowLaunch 元数据画轮尾 run 卡而非气泡。闭集加值的偏斜同 turnHeader.origin 注释。
  origin: z.enum([
    "realUser",
    "backgroundResult",
    "goalContinuation",
    "mailbox",
    "synthetic",
    "workflowLaunch",
  ]),
  originMeta: z
    .object({
      // 与 backgroundResultOriginMetaSchema 同一组取值（含 workflow run 的 "workflow"）。
      backgroundSource: z.enum(["bash", "subagent", "workflow"]).optional(),
      workId: z.string().optional(),
      senderSessionId: z.string().optional(),
      senderLabel: z.string().optional(),
    })
    .optional(),
  // origin === "workflowLaunch" 的行上在场；与 originMeta 并列，与 turnHeader 上同一份。
  workflowLaunch: workflowLaunchMetaSchema.optional(),
  // 经 turn-steer 注入（guideModeTurnSteer）。
  guided: z.literal(true).optional(),
  // realUser/guided 必带；系统来源缺省。overlay 收口锚点。
  sourceCommandId: z.string().optional(),
  // edit/retry 会生成新的 sourceCommandId；该字段固定指向 canonical input 根，
  // 用于一次性恢复预算等跨重跑 lineage 判定。旧 transcript 可缺省。
  rootSourceCommandId: z.string().optional(),
  // 提交端身份由 CLI admission 写入；旧 transcript 可缺省。
  clientId: z.string().optional(),
  attachments: z
    .array(
      z.object({
        ref: z.string(),
        fileName: z.string(),
        mime: z.string(),
        bytes: z.number(),
        previewRef: z.string().optional(),
      }),
    )
    .optional(),
});
export type UserInputRow = z.infer<typeof userInputRowSchema>;

// assistantText / reasoning。
// 不变量：追加只能进 state="streaming" 的行；普通新 response 必然新 rowId。唯一例外是
// ProductProjection 已由 length/zero-tool 事实确认的 output-token Continue，会重新打开同 turn
// 且视觉紧邻的 assistantText row；客户端仍只观察标准 row.upserted + row.delta。
export const assistantTextRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("assistantText"),
  // 同一模型 response 的正文与工具共享此 ID；optional 兼容旧 snapshot。
  assistantResponseId: z.string().min(1).optional(),
  text: z.string(),
  state: z.enum(["streaming", "complete", "interrupted", "failed"]),
  model: z.string().optional(),
  feedback: z.enum(["like", "dislike"]).optional(),
});
export type AssistantTextRow = z.infer<typeof assistantTextRowSchema>;

export const reasoningRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("reasoning"),
  // 同一模型 response 的思考、正文与工具共享此 ID；optional 兼容旧 snapshot。
  assistantResponseId: z.string().min(1).optional(),
  text: z.string(),
  state: z.enum(["streaming", "complete", "interrupted"]),
  durationMs: z.number().optional(),
});
export type ReasoningRow = z.infer<typeof reasoningRowSchema>;

// toolCall 展示层 schema 已拆至 ./toolDisplay.ts（rows.ts 受 max-lines 约束）。
import { toolCallDisplaySchema, toolOutputSchema, toolProgressSchema } from "./toolDisplay.js";

export const cuaAppIdentitySchema = z
  .object({
    pid: z.number().int().positive(),
    name: z.string().trim().min(1).max(256),
    bundleId: z.string().trim().min(1).max(512).optional(),
  })
  .strict();
export type CuaAppIdentity = z.infer<typeof cuaAppIdentitySchema>;

export const toolCallRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("toolCall"),
  // 同一模型 response 的正文与工具共享此 ID；optional 兼容旧 snapshot。
  assistantResponseId: z.string().min(1).optional(),
  toolCallId: z.string(),
  toolName: z.string(),
  status: z.enum(["inputStreaming", "pendingApproval", "running", "success", "error", "cancelled"]),
  inputText: z.string(),
  input: z.unknown().optional(),
  cuaApp: cuaAppIdentitySchema.optional(),
  output: toolOutputSchema.optional(),
  // display 解析失败只丢这张卡的载荷，不拒整条 row（理由见 toolDisplay.ts 的 toolOutputSchema
  // 注释：装饰载荷不得决定 row/帧/订阅的生死）。
  display: toolCallDisplaySchema.optional().catch(undefined),
  // status=error 时必带。
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  // 仅 replayable 档运行中出现，终态清除。
  progress: toolProgressSchema.optional(),
  // continuous/replayable 共用的有界 Bash 内容，终态或后台移交时清除。
  outputPreview: executionOutputPreviewSchema.optional(),
  // status=pendingApproval 时指向 pendingInteractions 项。
  approvalInteractionId: z.string().optional(),
  backgrounded: z.literal(true).optional(),
  workId: z.string().optional(),
  startedAt: timestampSchema.optional(),
  endedAt: timestampSchema.optional(),
});
export type ToolCallRow = z.infer<typeof toolCallRowSchema>;

// 分享结果物是会话正式投影的一部分；ref 在本地投影中是受 Host 授权的读取引用，
// 公开分享投影必须将其替换为 zcode-artifact://share/:id，禁止透传本地路径。
export const conversationArtifactTypeSchema = z.enum([
  "pdf",
  "pptx",
  "docx",
  "xlsx",
  "image",
  "html",
  "md",
  "text",
]);
export type ConversationArtifactType = z.infer<typeof conversationArtifactTypeSchema>;

export const artifactRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("artifact"),
  artifactVersionId: z.string().trim().min(1),
  logicalArtifactKey: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  artifactType: conversationArtifactTypeSchema,
  mimeType: z.string().trim().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  ref: z.string().trim().min(1),
  state: z.literal("current"),
});
export type ArtifactRow = z.infer<typeof artifactRowSchema>;

// subagent。前提：subagent 镜像事件必须进事件日志。
export const subagentRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("subagent"),
  // 触发该子智能体的 Agent/Task 工具调用；并发 spawn 顺序不可作为关联依据。
  parentToolCallId: z.string().optional(),
  subagentType: z.string(),
  status: z.enum(["running", "success", "failed", "cancelled"]),
  summaryText: z.string(),
  // 存在 → UI 可下钻订阅 conversation/<childSessionId>（不内嵌 child rows）。
  childSessionId: z.string().optional(),
  backgrounded: z.literal(true).optional(),
  workId: z.string().optional(),
  startedAt: timestampSchema.optional(),
  endedAt: timestampSchema.optional(),
});
export type SubagentRow = z.infer<typeof subagentRowSchema>;

// Hook runtime descriptor 只用于 CLI event/projection 输入兼容。对话 wire row 使用下方
// client-safe summary，不携带命令、绝对路径、stdin/stdout/stderr/tool input 或环境变量。
export const hookExecutionDescriptorSchema = z
  .object({
    clientVisible: z.literal(true),
    sourceKind: z.enum(["user", "plugin", "project", "internal"]),
    sourcePath: z.string().optional(),
    pluginId: z.string().optional(),
    pluginName: z.string().optional(),
    statusMessage: z.string().optional(),
    executionType: z.enum(["process", "command"]),
    executionMode: z.enum(["foreground", "background"]),
    commandDisplay: z.string(),
    timeoutMs: z.number().int().positive(),
  })
  .strict();
export type HookExecutionDescriptor = z.infer<typeof hookExecutionDescriptorSchema>;

export const hookExecutionProjectionSchema = z
  .object({
    hookRunId: z.string().min(1),
    hookIndex: z.number().int().nonnegative(),
    // 同一 runId 已观察到 HookRunStarted 才为 true；admission-only blocked 为 false。
    didExecute: z.boolean(),
    state: z.enum(["running", "completed", "failed"]),
    outcome: z.enum(["success", "blocked", "failed", "cancelled", "timed_out"]).optional(),
    blockReason: z.string().trim().min(1).optional(),
    startedAt: timestampSchema,
    endedAt: timestampSchema.optional(),
    durationMs: z.number().nonnegative().optional(),
    displayName: z.string().trim().min(1),
    sourceKind: z.enum(["user", "plugin", "project"]),
    pluginName: z.string().optional(),
    toolName: z.string().optional(),
  })
  .strict();
export type HookExecutionProjection = z.infer<typeof hookExecutionProjectionSchema>;

export const hookInvocationRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("hookInvocation"),
  hookInvocationId: z.string().min(1),
  hookEventName: z.enum([
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
  ]),
  hookCount: z.number().int().positive(),
  state: z.enum(["running", "completed", "failed"]),
  startedAt: timestampSchema,
  endedAt: timestampSchema.optional(),
  durationMs: z.number().nonnegative().optional(),
  lane: z.enum(["assistantWork", "toolBefore", "toolAfter"]),
  anchorToolCallId: z.string().optional(),
  executions: z.array(hookExecutionProjectionSchema),
});
export type HookInvocationRow = z.infer<typeof hookInvocationRowSchema>;

// timelineMarker。
// compact.status=cancelled 表示 auto compact 被 stop；失败终态为 failed。
export const timelineMarkerPayloadSchema = z.union([
  z.object({
    type: z.literal("compact"),
    origin: z.enum(["manual", "auto"]),
    status: z.enum(["running", "success", "failed", "noop", "cancelled"]),
    tokensBefore: z.number().optional(),
    tokensAfter: z.number().optional(),
    summaryRef: z.string().optional(),
  }),
  // 出现在 child 会话首部（forkTimelineIsBoundary）。
  z.object({
    type: z.literal("forkNotice"),
    parentSessionId: z.string(),
    parentRowId: z.number(),
  }),
  // 出现在 parent（可选展示）。
  z.object({
    type: z.literal("forkCreated"),
    childSessionId: z.string(),
    atRowId: z.number(),
  }),
  z.object({
    type: z.literal("modelChange"),
    fromProvider: z.string(),
    fromModel: z.string(),
    toProvider: z.string(),
    toModel: z.string(),
    toThought: z.string(),
  }),
  z.object({
    type: z.literal("modelChange"),
    // 显式 ∅→X 模型边界没有来源；never 保证两个来源字段不能只出现一个，
    // 避免 renderer 接收到半个 provider/model 元组。
    fromProvider: z.never().optional(),
    fromModel: z.never().optional(),
    toProvider: z.string(),
    toModel: z.string(),
    toThought: z.string(),
  }),
  z.object({
    type: z.literal("goalSet"),
    objective: z.string(),
    previousObjective: z.string().optional(),
  }),
  z.object({
    type: z.literal("goalVerify"),
    iteration: z.number(),
    outcome: z.enum(["running", "pass", "notSatisfied", "failed"]),
    detail: z.string().optional(),
  }),
  z.object({
    type: z.literal("retryNotice"),
    attempt: z.number(),
    reasonCode: z.string(),
  }),
  // workspace 域动作在时间线上的回执。
  z.object({
    type: z.literal("checkpointRestored"),
    checkpointId: z.string(),
  }),
]);
export type TimelineMarkerPayload = z.infer<typeof timelineMarkerPayloadSchema>;

/**
 * marker 泳道：
 * 落位语义由 CLI 投影裁决，UI 只按 lane 装配、不得按 marker type 自行推断。
 * - assistantWork：assistant 工作活动（compact），进「已工作」折叠组；
 * - turnTailBoundary：轮尾边界（goalVerify/forkNotice），留轮结尾不折叠；
 * - lightBoundary：轮顶轻边界（modelChange），渲染在 user 输入之前。
 * optional = 老 snapshot 兼容（缺省时 UI 按 marker type 回落映射）。
 */
export const timelineMarkerLaneSchema = z.enum([
  "assistantWork",
  "turnTailBoundary",
  "lightBoundary",
]);
export type TimelineMarkerLane = z.infer<typeof timelineMarkerLaneSchema>;

export const timelineMarkerRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("timelineMarker"),
  // 用户触发的 marker 必带。
  sourceCommandId: z.string().optional(),
  lane: timelineMarkerLaneSchema.optional(),
  marker: timelineMarkerPayloadSchema,
});
export type TimelineMarkerRow = z.infer<typeof timelineMarkerRowSchema>;

export const conversationRowSchema = z.discriminatedUnion("kind", [
  turnHeaderRowSchema,
  userInputRowSchema,
  assistantTextRowSchema,
  reasoningRowSchema,
  toolCallRowSchema,
  artifactRowSchema,
  subagentRowSchema,
  hookInvocationRowSchema,
  timelineMarkerRowSchema,
]);
export type ConversationRow = z.infer<typeof conversationRowSchema>;
export type ConversationRowKind = ConversationRow["kind"];
