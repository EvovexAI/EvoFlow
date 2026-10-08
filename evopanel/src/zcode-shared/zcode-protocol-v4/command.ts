import { localTtftContextSchema, localTtftClockSchema } from "../localTtft.js";
// Command 层：信封 / ACK / 命令全集 payload。
// conversation rewind 无独立命令（裁决：= editUserQuery 的 UI 入口）；
// workspace-only 文件撤销走 applyFileRewind，不截断聊天历史。
import { z } from "zod";
import { conversationRowTargetSchema, timestampSchema } from "./core.js";
import { attachmentRefSchema } from "./attachment-ref.js";
import { v4ConversationFileRewindPreviewResultSchema } from "./transport.js";
import { modelSelectionSchema } from "../model-selection.js";
import { modelExecutionSchema } from "../model-execution.js";
import { submissionModeSchema } from "./submission.js";
import { zcodeAutomationBotDeliveryTargetSchema } from "../bots.js";
import {
  amendWorkflowRunSettingsPayloadSchema,
  amendWorkflowRunSettingsResultSchema,
} from "./workflow-run-settings-command.js";
import {
  workspaceHookReviewCommandTargetSchema,
  workspaceHookReviewDecisionSchema,
  workspaceHookTrustRevokeTargetSchema,
  requestWorkspaceHookReviewTargetSchema,
} from "./workspace-hook-review.js";
import {
  zcodeBrowserAmbientContextSchema,
  zcodeProtocolMcpServerSchema,
} from "../zcode-protocol/index.js";
import { sharedContextRefSchema } from "./shared-context-ref.js";
export type { SharedContextRef } from "./shared-context-ref.js";

const createSessionRequestedConfigSchema = z.object({
  modelSelection: modelSelectionSchema.optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  thought: z.string().optional(),
  followupMode: z.enum(["queue", "guide"]).optional(),
  // createSession.config 表达“请求覆盖字段”，不能复用 snapshot 的
  // sessionConfigStateSchema.partial()；snapshot 为兼容旧快照给 mode 设了 default("build")，
  // 会把“没传 mode”误变成“请求切回 build”，覆盖 workspace 默认 yolo。
  mode: z.string().optional(),
  planEnabled: z.boolean().optional(),
});

// ── 命令 payload 全集 ──
export const commandPayloadSchemas = {
  // firstInput 缺省 → phase=draft 空会话；携带 → 直接 turnHeader+userInput rows。
  createSession: z.object({
    workspaceId: z.string(),
    firstInput: z
      .object({
        text: z.string(),
        attachments: z.array(attachmentRefSchema).optional(),
        modelSelection: modelSelectionSchema.optional(),
        mode: submissionModeSchema.optional(),
        planEnabled: z.boolean().optional(),
      })
      .optional(),
    config: createSessionRequestedConfigSchema.optional(),
    // MCP 是 runtime 启动期配置，必须随 create 一次性进入 record，不能在首发后补写。
    mcpServers: z.array(zcodeProtocolMcpServerSchema).optional(),
    // Off-Peak 工具面 flag，与 legacy session/create 等价——V4 createSession 是桌面
    // 新会话的实际创建路径，不透传则 OffPeakCreate/OffPeakList 永不注册。additive，
    // 旧 CLI 的 z.object 会静默丢弃该键（fail-closed）。
    offPeakToolEnabled: z.boolean().optional(),
    // 动态工作流灰度 flag，与 offPeakToolEnabled 同一模式。
    dynamicWorkflowEnabled: z.boolean().optional(),
  }),
  // 父会话由 envelope.sessionId 指定；服务端从父 record 派生完整运行配置。
  // firstInput 存在时，child 创建完成后立即启动首条普通输入；缺省则保持空副屏。
  createSelectionSideSession: z.object({
    firstInput: z
      .object({
        text: z.string().trim().min(1),
        // 提交推荐只覆盖新 child 的完整选择，缺省保留父 runtime 继承。
        modelSelection: modelSelectionSchema.optional(),
      })
      .optional(),
  }),
  // 按 inputRouting 裁决：startNow / enqueue / guide / choice。
  // heldQueueDisposition：held 状态（inputRouting.mode=choice）下必带；
  // clear→清空 queue 后 startNow，keep→保留 queue 立即 startNow。
  sendText: z
    .object({
      text: z.string(),
      attachments: z.array(attachmentRefSchema).optional(),
      // Desktop Cmd/Ctrl+Enter 只覆盖本次 busy input，不改 session followupMode。
      // startNow 由 CLI 原子抢占当前 turn，不经过 queue admission。
      requestedDelivery: z.enum(["startNow", "queue", "guide"]).optional(),
      browserAmbientContext: zcodeBrowserAmbientContextSchema.optional(),
      // Share handover 只允许当前 session 的一个已导入上下文；完整正文由 runtime 从
      // 持久化 provenance 解析，不能随 command 从 renderer 传入。
      context_refs: z.array(sharedContextRefSchema).max(1).optional(),
      heldQueueDisposition: z.enum(["clearQueueAndSend", "keepQueueAndSend"]).optional(),
      // 暂停队列确认框打开时看到的 queueItemId 集合。CLI 在执行 clear/keep 前校验，
      // 防止桌面/手机并发增删后把用户没确认过的新队列一并处置。
      expectedHeldQueueItemIds: z.array(z.string().min(1)).optional(),
      // 迁移期允许旧发送端缺省；CLI admission 会把当前 Session Selection 固定进
      // canonical intent。Renderer 切换完成后，第一方用户提交始终显式携带这两项。
      modelSelection: modelSelectionSchema.optional(),
      mode: submissionModeSchema.optional(),
      planEnabled: z.boolean().optional(),
      // 本次执行仍使用上面的标准 Selection；这里只携带不持久化语义、动态鉴权和 child 策略。
      // 仅 idle startNow 接受，防止 Secret/Ticket 进入普通 CommandInbox。
      modelExecution: modelExecutionSchema.optional(),
      automationId: z.string().min(1).optional(),
      offPeakTaskId: z.string().min(1).optional(),
      offPeakRunType: z.enum(["init", "resume"]).optional(),
      // Bot 来源只由 Host 注入，用于 CronCreate 在当前 turn 内读取并持久化回推地址。
      botDeliveryTarget: zcodeAutomationBotDeliveryTargetSchema.optional(),
      // 定时任务会话的后续用户输入也必须保持 turn-scoped 工具面隔离；不能借用
      // automationId，否则会把普通用户输入误标成一次 automation 派发。
      toolDisallowlist: z.array(z.string().min(1)).optional(),
    })
    .superRefine((payload, context) => {
      if (payload.automationId && payload.offPeakTaskId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "automationId and offPeakTaskId are mutually exclusive",
        });
      }
      if (payload.offPeakRunType && !payload.offPeakTaskId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "offPeakRunType requires offPeakTaskId",
          path: ["offPeakRunType"],
        });
      }
      if (payload.modelExecution && !payload.modelSelection) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "modelExecution requires modelSelection",
          path: ["modelExecution"],
        });
      }
    }),
  sendGoalCommand: z.object({
    text: z.string(),
    displayText: z.string().optional(),
    modelSelection: modelSelectionSchema.optional(),
    mode: submissionModeSchema.optional(),
    planEnabled: z.boolean().optional(),
    heldQueueDisposition: z.enum(["clearQueueAndSend", "keepQueueAndSend"]).optional(),
    expectedHeldQueueItemIds: z.array(z.string().min(1)).optional(),
  }),
  stop: z.object({
    // 来自 activeWorks；CLI 用它拒绝会误杀后续无关执行的迟到 Stop。
    expectedForegroundExecutionId: z.string().min(1).optional(),
  }),
  // compact 是输入型维护命令：idle 时立即执行，busy/held 时进入 FIFO。
  // 因为 admission 与当前 revision 无关，不走 CAS；sourceCommandId 提供幂等边界。
  compact: z.object({}),
  // running 时对稳定 assistant row 可用。
  forkAssistant: z.object({ target: conversationRowTargetSchema }),
  applyFileRewind: z.object({ target: conversationRowTargetSchema }),
  editUserQuery: z.object({
    target: conversationRowTargetSchema,
    newText: z.string(),
    attachments: z.array(attachmentRefSchema).optional(),
    // 缺省 preserve：仅切 conversation branch；rewind 会先安全恢复该轮文件。
    workspaceMode: z.enum(["preserve", "rewind"]).optional(),
  }),
  retryTurn: z.object({ target: conversationRowTargetSchema }),
  setAssistantFeedback: z.object({
    target: conversationRowTargetSchema,
    feedback: z.enum(["like", "dislike"]).nullable(),
  }),
  sendQueuedNow: z.object({ queueItemId: z.string() }),
  editQueueItem: z.object({ queueItemId: z.string(), newText: z.string() }),
  // beforeQueueItemId = null → 移到队尾。
  reorderQueueItem: z.object({
    queueItemId: z.string(),
    beforeQueueItemId: z.string().nullable(),
  }),
  deleteQueueItem: z.object({ queueItemId: z.string() }),
  setAutoDrain: z.object({ autoDrain: z.boolean() }),
  // 先到先得，晚到 noop（reasonCode=proto.alreadyResolved）。
  resolveInteraction: z.object({
    interactionId: z.string(),
    answer: z.object({
      optionId: z.string().optional(),
      freeText: z.string().optional(),
      // （elicitation 回执收敛）：AskUserQuestion/plan-approval 的
      // 多题答案与注解无损承载。action 存在时 CLI broker 按 accept/decline/cancel
      // 精确映射（content 直传旧 userInput response 语义）；缺省沿用
      // optionId/freeText 兼容路径，旧客户端行为不变。
      action: z.enum(["accept", "decline", "cancel"]).optional(),
      content: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
  respondWorkspaceHookReview: workspaceHookReviewCommandTargetSchema.extend({
    decision: workspaceHookReviewDecisionSchema,
  }),
  toggleWorkspaceHookReviewItem: workspaceHookReviewCommandTargetSchema.extend({
    reviewItemId: z.string().trim().min(1),
    enabled: z.boolean(),
  }),
  revokeWorkspaceHookTrust: z.union([
    workspaceHookReviewCommandTargetSchema.extend({
      reviewItemIds: z.array(z.string().trim().min(1)).min(1),
    }),
    workspaceHookTrustRevokeTargetSchema,
  ]),
  // 软门禁：按需开审核 flow,克隆 revoke non-flow target 但不带 hookDeclarationDigests。
  requestWorkspaceHookReview: requestWorkspaceHookReviewTargetSchema,
  // AskUserQuestion 首次有效操作永久暂停本次自动结束；重复/迟到调用为幂等 noop。
  snoozeInteractionAutoResolution: z.object({
    interactionId: z.string(),
  }),
  switchModelConfig: z.object({
    provider: z.string(),
    model: z.string(),
    thought: z.string(),
  }),
  // additive（冻结面按黄金测试背书演进）：agent 协作模式切换。
  // 值域 = core CollaborationMode 的可切换子集（auto 非用户可切，不进 UI 命令面）。
  switchCollaborationMode: z.object({
    mode: z.enum(["build", "edit", "plan", "yolo"]),
  }),
  setFollowupMode: z.object({ mode: z.enum(["queue", "guide"]) }),
  pauseGoal: z.object({}),
  resumeGoal: z.object({}),
  cancelBackgroundWork: z.object({ workId: z.string() }),
  // cancel & resume：恢复一个已取消 / 被进程死亡
  // 打断的 dwf run。workId ≡ runId（与 cancelBackgroundWork 同一个身份等式）；`name` 可选，
  // 喂恢复后完成通知的主题（重启后原 CreateWorkflow 工具 input 不可得）。刻意不携
  // baseRevision：与 cancelBackgroundWork 同类（workflowRuns 面免 revision，假 CAS 失败
  // 只会误伤）。门在 CLI 侧（可恢复集 = cancelled ∪ failed+Interrupted），拒绝以
  // fault.command.workflowRunResumeRejected.<reason> 回 ACK。
  resumeWorkflowRun: z.object({ workId: z.string(), name: z.string().optional() }),
  // startSavedWorkflow：中枢「运行」不再合成
  // 对话文案，直接请 agent 在新会话里启动已保存工作流。与 cancelBackgroundWork / resumeWorkflowRun
  // 同类：不携 baseRevision（workflowRuns 面免 revision，假 CAS 失败只会误伤）。name 由 agent 从
  // 解析结果填（不变式 6），命令不收 name 覆盖。
  // 拒绝以 fault.command.savedWorkflowStartRejected.<reason> 回 ACK（词表见下方
  // savedWorkflowStartRejectionReasonSchema）；能力缺席（无 dwf 端口）→ V4CapabilityUnsupportedError
  // （与 resumeWorkflowRun 同一条错误）。
  startSavedWorkflow: z.object({
    name: z.string().min(1),
    scope: z.enum(["project", "global"]).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
  }),
  // amendWorkflowRunSettings：run 卡 / 详情页的「配置」直接请 agent 以新设置修订 run，不经模型轮。载荷、结果与拒绝
  // 词表见 workflow-run-settings-command.ts；能力缺席 → V4CapabilityUnsupportedError。
  amendWorkflowRunSettings: amendWorkflowRunSettingsPayloadSchema,
  renameSession: z.object({ title: z.string() }),
  deleteSession: z.object({}),
  discardSharedContext: z.object({ contextId: z.string().trim().min(1) }).strict(),
} as const;

export type CommandType = keyof typeof commandPayloadSchemas;
export type CommandPayloadMap = {
  [T in CommandType]: T extends "sendText"
    ? z.infer<(typeof commandPayloadSchemas)[T]> &
        import("../zcode-task-types-core.js").ZCodeBackgroundTurnAttribution
    : z.infer<(typeof commandPayloadSchemas)[T]>;
};

export const commandTypeSchema = z.enum(
  Object.keys(commandPayloadSchemas) as [CommandType, ...CommandType[]],
);

// startSavedWorkflow 拒绝词表：
// bootstrap handler 铸造 fault code，ui launcher 反查 i18n 文案，两侧共享此枚举避免漂移。
// invalid_name / not_found：解析阶段；invalid_args：实参校验；compile_failed：analyzeScript 诊断；
// session_busy：会话有活动 turn；start_failed：port.submit 之前的其它启动失败。
export const savedWorkflowStartRejectionReasonSchema = z.enum([
  "invalid_name",
  "not_found",
  "invalid_args",
  "compile_failed",
  "session_busy",
  "start_failed",
]);
export type SavedWorkflowStartRejectionReason = z.infer<
  typeof savedWorkflowStartRejectionReasonSchema
>;

// 完整 fault code = 前缀 + reason（如 fault.command.savedWorkflowStartRejected.not_found）。
// 与 workflowRunResumeRejected 命名空间同族；导出常量供 bootstrap 拼接、ui 前缀匹配。
export const SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX =
  "fault.command.savedWorkflowStartRejected." as const;

// resumeWorkflowRun 的拒绝：前缀 + 端口 reason（not_found / not_resumable / superseded /
// already_running / script_missing / script_mismatch / compile_failed）；`ack.message` 携带
// compile_failed 的有界诊断。
export const WORKFLOW_RUN_RESUME_REJECTED_FAULT_PREFIX =
  "fault.command.workflowRunResumeRejected." as const;

// cancelBackgroundWork 的拒绝：core 明确回「没有取消任何东西」时（任务不存在 / 已终结 / 类型不支持）
// 以前缀 + reason 上行，而不是一个假装成功的 accepted——详情页据此告诉用户这个 run 并不在跑。
// reason 即 core 的 stopBackgroundTask reason 去掉 `background_task_` 前缀：not_found /
// not_running / cancel_not_supported。
export const BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX =
  "fault.command.backgroundWorkCancelRejected." as const;

// CAS ✓ 的命令：信封必带 baseRevision。
export const COMMANDS_REQUIRING_BASE_REVISION: ReadonlySet<CommandType> = new Set([
  "applyFileRewind",
  "forkAssistant",
  "editUserQuery",
  "retryTurn",
  "setAssistantFeedback",
  "sendQueuedNow",
  "editQueueItem",
  "reorderQueueItem",
  "deleteQueueItem",
  "setAutoDrain",
  "switchModelConfig",
  "switchCollaborationMode",
  "setFollowupMode",
  "pauseGoal",
  "resumeGoal",
]);

export const ROW_TARGETING_COMMANDS: ReadonlySet<CommandType> = new Set([
  "applyFileRewind",
  "forkAssistant",
  "editUserQuery",
  "retryTurn",
  "setAssistantFeedback",
]);

// ── 信封 ──
export const commandEnvelopeSchema = z.object({
  ttft: localTtftContextSchema.optional(),
  // uuid v7，客户端生成，重试不变。
  commandId: z.string(),
  clientId: z.string(),
  // createSession 时为 null。
  sessionId: z.string().nullable(),
  baseRevision: z.number().optional(),
  baseLogEpoch: z.string().trim().min(1).optional(),
  type: commandTypeSchema,
  payload: z.unknown(),
  // 客户端时钟，仅遥测；服务端不用于任何裁决。
  issuedAt: timestampSchema,
});
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;

/** 校验信封并按 type 校验 payload（信封 schema 无法静态关联 payload，收口在这里）。 */
export function parseCommandEnvelope(
  value: unknown,
): { ok: true; envelope: CommandEnvelope } | { ok: false; error: z.ZodError } {
  const envelope = commandEnvelopeSchema.safeParse(value);
  if (!envelope.success) return { ok: false, error: envelope.error };
  const payload = commandPayloadSchemas[envelope.data.type].safeParse(envelope.data.payload);
  if (!payload.success) return { ok: false, error: payload.error };
  if (
    (COMMANDS_REQUIRING_BASE_REVISION.has(envelope.data.type) &&
      envelope.data.baseRevision === undefined) ||
    (ROW_TARGETING_COMMANDS.has(envelope.data.type) && envelope.data.baseLogEpoch === undefined)
  ) {
    return {
      ok: false,
      error: new z.ZodError([
        {
          code: "custom",
          path: [envelope.data.baseRevision === undefined ? "baseRevision" : "baseLogEpoch"],
          message: "CAS commands require baseRevision and baseLogEpoch",
        },
      ]),
    };
  }
  return {
    ok: true,
    envelope: { ...envelope.data, payload: payload.data },
  };
}

// ── ACK ──
export const commandResultSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["createSession", "createSelectionSideSession", "forkAssistant"]),
    sessionId: z.string(),
    input: z
      .object({
        delivery: z.enum(["startNow", "queue", "guide"]),
        inputId: z.string(),
        // Core admission ACK 不等待 TurnStarted；messageId 可能由后续事件补齐。
        messageId: z.string().optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("resolveInteraction"),
    resolvedBy: z.object({
      clientId: z.string(),
      optionId: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("applyFileRewind"),
    applied: z.boolean(),
    preview: v4ConversationFileRewindPreviewResultSchema,
    response: z.string(),
  }),
  z.object({
    type: z.literal("editUserQuery"),
    // fork 仅保留旧 ACK 解码兼容；新 editUserQuery 不再生成 child session。
    disposition: z.enum(["rewind", "fork", "blocked"]),
    sessionId: z.string().min(1),
    reasonCode: z.string().min(1).optional(),
    preview: v4ConversationFileRewindPreviewResultSchema.optional(),
  }),
  z.object({
    // startSavedWorkflow accepted ACK：
    // runId 联接启动轮 run 卡状态 / 通知 / 侧板；toolCallId = launch-<uuid>，联接合成 CreateWorkflow 轮。
    type: z.literal("startSavedWorkflow"),
    runId: z.string().min(1),
    toolCallId: z.string().min(1),
  }),
  amendWorkflowRunSettingsResultSchema,
  z.object({
    // messageId 只在 TurnStarted 后作为旁路归因补齐；Core admission ACK 不等待
    // projection commit，不能把 messageId 作为输入 accepted 的必要条件。
    type: z.literal("inputAccepted"),
    delivery: z.enum(["startNow", "queue", "guide"]),
    inputId: z.string(),
    messageId: z.string().optional(),
  }),
  z.object({
    // restart discarded 过去只返回一个无差别 fault，renderer 无法区分
    // runtime-local queue 与仍需人工确认的 startNow。delivery 来自 session_input
    // 持久事实，不能由客户端按当前 UI phase 猜测。
    type: z.literal("inputDisposition"),
    delivery: z.enum(["startNow", "queue", "guide"]),
  }),
]);
export type CommandResult = z.infer<typeof commandResultSchema>;

export const commandAckSchema = z.object({
  /** 会话创建期采用的 App Memory 开关；旧发送端缺省表示未知。 */
  memoryEnabled: z.boolean().optional(),
  ttftExcluded: z.literal("capacity").optional(),
  commandId: z.string(),
  // accepted 不承诺跨 CLI 进程存活；最终收口以权威数据（sourceCommandId）为准。
  status: z.enum(["accepted", "rejected", "stale", "duplicate", "noop", "failed"]),
  // rejected/stale/noop/failed 必带；= guard id 或 fault code（命名空间）。
  reasonCode: z.string().optional(),
  message: z.string().optional(),
  revisionAtDecision: z.number(),
  // duplicate 回放缓存结果；accepted 亦可即时带（fork）。
  result: commandResultSchema.optional(),
});
export type CommandAck = z.infer<typeof commandAckSchema>;

// ── commands/query ──
export const commandKeySchema = z
  .object({
    // null 只属于全局/createSession 幂等桶；session 命令必须携带 sessionId。
    sessionId: z.string().nullable(),
    commandId: z.string().min(1),
  })
  .strict();
export type CommandKey = z.infer<typeof commandKeySchema>;

export const commandsQueryParamsSchema = z
  .object({
    commands: z.array(commandKeySchema).min(1).max(64),
    clock: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (params) => !params.clock || params.commands.every((key) => key.sessionId === null),
    "clock probes cannot query session commands",
  );
export type CommandsQueryParams = z.infer<typeof commandsQueryParamsSchema>;

export const commandQueryItemSchema = z
  .object({
    key: commandKeySchema,
    result: z.union([commandAckSchema, z.literal("unknown")]),
  })
  .strict();
export type CommandQueryItem = z.infer<typeof commandQueryItemSchema>;

export const commandsQueryResultSchema = z
  .object({
    results: z.array(commandQueryItemSchema).min(1).max(64),
    clock: localTtftClockSchema.optional(),
  })
  .strict();
export type CommandsQueryResult = z.infer<typeof commandsQueryResultSchema>;
