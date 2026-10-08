/* oxlint-disable eslint(max-lines) -- re-home 产物：task realtime 运行时 schema 集中迁移，类型与校验就近。 */
// re-home 迁移产物（为删除旧协议树铺路）。
// 本文件承载 task realtime 传输面中仍被存活栈（validation.ts 外部 relay payload 校验）
// 消费的运行时 zod schema 与 resolveWorkspaceKey。
// task-realtime.ts 保留旧协议兼容接口；本文件集中定义对应的运行时 schema。

import { z } from "zod";
import type { ZCodeTaskMigrationSource, ZCodeTaskMode } from "./zcode-task-types-core.js";
import { zcodeAgentProviderSchema } from "./zcode-agent-policy.js";
import { zcodePermissionResponseSchema } from "./zcode-protocol-legacy-types.js";
// merge 冲突解决：两侧分别在相邻行新增独立 import（本分支 hook trust review
// 决策 schema、staging telemetry error attribution schema），二者无语义交集，均保留。
import { workspaceHookReviewDecisionSchema } from "./zcode-protocol-v4/workspace-hook-review.js";
import { errorAttributionSchema } from "./zcode-protocol-v4/snapshot.js";

const nonEmptyString = z.string().trim().min(1);
const zcodeTaskModeRealtimeValues = [
  "yolo",
  "plan",
  "edit",
  "auto",
  "autoEdit",
  "build",
] as const satisfies readonly ZCodeTaskMode[];
const zcodeTaskMigrationSourceRealtimeValues = [
  "claudeCode",
] as const satisfies readonly ZCodeTaskMigrationSource[];
const zcodeTaskChangeSummaryRealtimeSchema = z
  .object({
    fileCount: z.number().int().nonnegative(),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    files: z.array(
      z
        .object({
          path: z.string(),
          added: z.number().int().nonnegative(),
          removed: z.number().int().nonnegative(),
          writeCount: z.number().int().positive(),
          lastTurnIndex: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();
const taskMetaRealtimeSchema = z.object({
  taskId: nonEmptyString,
  traceId: nonEmptyString,
  title: z.string(),
  titleOverridden: z.boolean().optional(),
  workspacePath: nonEmptyString,
  workspaceIdentity: nonEmptyString.optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  // realtime deliver 的运行时 schema 之前把 mode 放宽成 string，
  // schema 推导类型因此无法回到 ZCodeTaskMeta，host typecheck 也就无法覆盖这条链路。
  mode: z.enum(zcodeTaskModeRealtimeValues),
  model: z.string().optional(),
  runtimeEpoch: z.number().int().nonnegative().optional(),
  provider: zcodeAgentProviderSchema.optional(),
  migrationSource: z.enum(zcodeTaskMigrationSourceRealtimeValues).optional(),
  forkedFromTaskId: nonEmptyString.optional(),
  unreadAt: z.number().int().nonnegative().optional(),
  status: z.enum(["running", "completed", "error"]).optional(),
  lastError: z
    .object({
      code: z.string().optional(),
      message: z.string().min(1),
      traceId: nonEmptyString.optional(),
      taskId: nonEmptyString.optional(),
      // 旧 realtime schema 会静默剥离 lastError.attribution，导致手机 replayable
      // task meta 与桌面 snapshot 的归因不一致；这里沿用共享 schema 保持 wire 约束一致。
      attribution: errorAttributionSchema.optional(),
    })
    .optional(),
  changeSummary: zcodeTaskChangeSummaryRealtimeSchema.optional(),
});
export function resolveWorkspaceKey(params: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  return params.workspaceIdentity?.trim() || params.workspacePath;
}
export const taskRealtimeReasonSchema = z.enum([
  "task_created",
  "user_message_saved",
  "assistant_message_saved",
  "task_status_changed",
  "task_meta_changed",
  // 切模型等纯配置变更独立成 reason，避免被当成归属相关 meta 变更触发列表整刷。
  "task_model_changed",
  // 标题更新（首条消息/自动标题）与归属无关且高频，独立 reason 避免全局 membership 重拉。
  "task_title_changed",
  "task_pinned",
  "task_unpinned",
  "task_archived",
  "task_unarchived",
  "task_deleted",
  "stream_mirror_gap",
  "stream_mirror_owner_lost",
]);
export const taskRealtimeDeliveryPurposeSchema = z.enum(["observer", "relay_owner"]);
export const taskRealtimeHostDeliveryKindSchema = z.enum(["desktop_window", "relay_bridge"]);
const taskRealtimeEnvelopeSchema = z
  .object({
    eventId: nonEmptyString,
    workspacePath: nonEmptyString,
    workspaceIdentity: nonEmptyString.optional(),
    workspaceKey: nonEmptyString,
    traceId: nonEmptyString,
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
const taskStreamWatermarkSchema = z
  .object({
    runId: nonEmptyString,
    opSeq: z.number().int().nonnegative(),
  })
  .strict();
const taskRealtimeInvalidationBaseEventSchema = taskRealtimeEnvelopeSchema
  .extend({
    reason: taskRealtimeReasonSchema,
    streamWatermark: taskStreamWatermarkSchema.optional(),
  })
  .strict();
const addWorkspaceKeyIssue = (
  ctx: z.RefinementCtx,
  event: { workspacePath: string; workspaceIdentity?: string; workspaceKey: string },
) => {
  const expectedWorkspaceKey = resolveWorkspaceKey(event);
  if (event.workspaceKey !== expectedWorkspaceKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["workspaceKey"],
      message: "workspaceKey must match workspaceIdentity fallback rule",
    });
  }
};
const addRunIdTraceIdIssue = (ctx: z.RefinementCtx, target: { runId: string; traceId: string }) => {
  if (target.runId !== target.traceId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["runId"],
      message: "runId must match traceId",
    });
  }
};
export const taskSnapshotInvalidatedEventSchema = taskRealtimeInvalidationBaseEventSchema
  .extend({
    type: z.literal("task_snapshot_invalidated"),
    taskId: nonEmptyString,
  })
  .strict();
export const workspaceTaskListInvalidatedEventSchema = taskRealtimeInvalidationBaseEventSchema
  .extend({
    type: z.literal("workspace_task_list_invalidated"),
    taskId: nonEmptyString.optional(),
    taskMeta: taskMetaRealtimeSchema.optional(),
  })
  .strict();
const zcodePromptAttachmentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("image"),
      filename: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number().int().nonnegative().optional(),
      dataBase64: z.string().optional(),
      localPath: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("audio"),
      filename: z.string(),
      mimeType: z.string(),
      dataBase64: z.string().optional(),
      localPath: z.string().optional(),
    })
    .strict(),
  // 附件类型新增 video 后，replayable schema 未同步，手机远控会拒绝合法附件。
  z
    .object({
      kind: z.literal("video"),
      filename: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number().int().nonnegative().optional(),
      dataBase64: z.string().optional(),
      localPath: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pdf"),
      filename: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number().int().nonnegative().optional(),
      dataBase64: z.string().optional(),
      localPath: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file"),
      filename: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      dataBase64: z.string().optional(),
      textContent: z.string().optional(),
      localPath: z.string().optional(),
    })
    .strict(),
]);
const taskStreamMirrorableEventSchema = z
  .object({
    type: nonEmptyString,
    taskId: nonEmptyString,
    traceId: nonEmptyString,
  })
  .passthrough();
const taskStreamMirrorUserMessagePublishOpSchema = z
  .object({
    kind: z.literal("user_message"),
    messageId: nonEmptyString,
    content: z.string(),
    attachments: z.array(zcodePromptAttachmentSchema).optional(),
    timestamp: z.number().finite(),
  })
  .strict();
const taskStreamMirrorStreamEventPublishOpSchema = z
  .object({
    kind: z.literal("stream_event"),
    event: taskStreamMirrorableEventSchema,
  })
  .strict();
export const taskStreamMirrorPublishOpSchema = z.discriminatedUnion("kind", [
  taskStreamMirrorUserMessagePublishOpSchema,
  taskStreamMirrorStreamEventPublishOpSchema,
]);
export const taskStreamMirrorOpSchema = z.discriminatedUnion("kind", [
  taskStreamMirrorUserMessagePublishOpSchema
    .extend({
      seq: z.number().int().positive(),
    })
    .strict(),
  taskStreamMirrorStreamEventPublishOpSchema
    .extend({
      seq: z.number().int().positive(),
    })
    .strict(),
]);
const taskStreamMirrorTargetRawSchema = z
  .object({
    workspacePath: nonEmptyString,
    workspaceIdentity: nonEmptyString.optional(),
    workspaceKey: nonEmptyString,
    taskId: nonEmptyString,
    runId: nonEmptyString,
    traceId: nonEmptyString,
    ownerClientId: nonEmptyString.optional(),
    ownerDeviceLabel: nonEmptyString.optional(),
  })
  .strict();
export const taskStreamMirrorTargetSchema = taskStreamMirrorTargetRawSchema.superRefine(
  (target, ctx) => {
    addWorkspaceKeyIssue(ctx, target);
    addRunIdTraceIdIssue(ctx, target);
  },
);
const taskStreamMirrorBatchEventRawSchema = taskRealtimeEnvelopeSchema
  .extend({
    type: z.literal("task_stream_mirror_batch"),
    taskId: nonEmptyString,
    runId: nonEmptyString,
    ownerClientId: nonEmptyString.optional(),
    ownerDeviceLabel: nonEmptyString.optional(),
    batchSeq: z.number().int().positive(),
    fromSeq: z.number().int().positive(),
    toSeq: z.number().int().positive(),
    ops: z.array(taskStreamMirrorOpSchema),
    terminal: z.boolean(),
  })
  .strict();
export const taskRunLeaseTargetSchema = taskStreamMirrorTargetSchema;
export const taskRunLeaseAcquireRequestSchema = taskStreamMirrorTargetRawSchema
  .extend({
    leaseRequestId: nonEmptyString,
  })
  .strict()
  .superRefine((request, ctx) => {
    addWorkspaceKeyIssue(ctx, request);
    addRunIdTraceIdIssue(ctx, request);
  });
export const taskRunLeaseResultSchema = z.discriminatedUnion("acquired", [
  z
    .object({
      leaseRequestId: nonEmptyString,
      acquired: z.literal(true),
      ownerHostId: nonEmptyString,
    })
    .strict(),
  z
    .object({
      leaseRequestId: nonEmptyString,
      acquired: z.literal(false),
      ownerHostId: nonEmptyString,
      reason: z.literal("owned_by_other_host"),
    })
    .strict(),
]);
const taskOwnerCommandBaseSchema = z
  .object({
    commandRequestId: nonEmptyString,
    workspacePath: nonEmptyString,
    workspaceIdentity: nonEmptyString.optional(),
    workspaceKey: nonEmptyString,
    taskId: nonEmptyString,
    runId: nonEmptyString,
  })
  .strict();
const taskStopGenerationOwnerCommandRequestSchema = taskOwnerCommandBaseSchema
  .extend({
    type: z.literal("stop_generation"),
  })
  .strict();
const taskRespondPermissionOwnerCommandRequestSchema = taskOwnerCommandBaseSchema
  .extend({
    type: z.literal("respond_permission"),
    permissionRequestId: nonEmptyString,
    optionId: nonEmptyString,
    response: zcodePermissionResponseSchema,
  })
  .strict();
const taskRespondElicitationOwnerCommandRequestSchema = taskOwnerCommandBaseSchema
  .extend({
    type: z.literal("respond_elicitation"),
    elicitationRequestId: nonEmptyString,
    action: z.enum(["accept", "decline", "cancel"]),
    content: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const taskRespondWorkspaceHookReviewOwnerCommandRequestSchema = taskOwnerCommandBaseSchema
  .extend({
    type: z.literal("respond_workspace_hook_review"),
    remoteSessionId: nonEmptyString.optional(),
    sessionId: nonEmptyString,
    bundleDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    reviewFlowId: nonEmptyString,
    generation: z.number().int().positive(),
    interactionId: nonEmptyString,
    decision: workspaceHookReviewDecisionSchema,
  })
  .strict()
  .superRefine((command, context) => {
    if (command.remoteSessionId && !command.workspaceIdentity) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workspaceIdentity"],
        message: "remote workspace Hook review response requires workspaceIdentity",
      });
    }
  });
const zcodeTaskRuntimeCommandBaseSchema = z
  .object({
    commandId: nonEmptyString,
    taskId: nonEmptyString,
    traceId: nonEmptyString,
    workspacePath: nonEmptyString,
    workspaceIdentity: nonEmptyString.optional(),
    workspaceKey: nonEmptyString,
    status: z.enum(["accepted", "running", "failed"]),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    clientId: nonEmptyString.optional(),
    clientLabel: nonEmptyString.optional(),
    error: z.string().optional(),
  })
  .strict();
const zcodeTaskRuntimeCommandSchema = z.discriminatedUnion("type", [
  zcodeTaskRuntimeCommandBaseSchema
    .extend({
      type: z.literal("send_prompt"),
      content: z.string(),
      attachments: z.array(zcodePromptAttachmentSchema).optional(),
      automationId: nonEmptyString.optional(),
    })
    .strict(),
]);
const taskEnqueueCommandOwnerCommandRequestSchema = taskOwnerCommandBaseSchema
  .extend({
    type: z.literal("enqueue_task_command"),
    taskCommand: zcodeTaskRuntimeCommandSchema,
  })
  .strict();
const taskPromoteCommandOwnerCommandRequestSchema = taskOwnerCommandBaseSchema
  .extend({
    type: z.literal("promote_task_command"),
    commandId: nonEmptyString,
    clientMode: z.literal("web-remote-replayable"),
  })
  .strict();
const taskCancelCommandOwnerCommandRequestSchema = taskOwnerCommandBaseSchema
  .extend({
    type: z.literal("cancel_task_command"),
    commandId: nonEmptyString,
    clientMode: z.literal("web-remote-replayable"),
  })
  .strict();
export const taskOwnerCommandRequestSchema = z
  .discriminatedUnion("type", [
    taskStopGenerationOwnerCommandRequestSchema,
    taskRespondPermissionOwnerCommandRequestSchema,
    taskRespondElicitationOwnerCommandRequestSchema,
    taskRespondWorkspaceHookReviewOwnerCommandRequestSchema,
    taskEnqueueCommandOwnerCommandRequestSchema,
    taskPromoteCommandOwnerCommandRequestSchema,
    taskCancelCommandOwnerCommandRequestSchema,
  ])
  .superRefine((command, ctx) => {
    addWorkspaceKeyIssue(ctx, command);
  });
export const taskOwnerCommandDeliverySchema = z
  .discriminatedUnion("type", [
    taskStopGenerationOwnerCommandRequestSchema
      .extend({
        requesterHostId: nonEmptyString,
      })
      .strict(),
    taskRespondPermissionOwnerCommandRequestSchema
      .extend({
        requesterHostId: nonEmptyString,
      })
      .strict(),
    taskRespondElicitationOwnerCommandRequestSchema
      .extend({
        requesterHostId: nonEmptyString,
      })
      .strict(),
    taskRespondWorkspaceHookReviewOwnerCommandRequestSchema
      .extend({
        requesterHostId: nonEmptyString,
      })
      .strict(),
    taskEnqueueCommandOwnerCommandRequestSchema
      .extend({
        requesterHostId: nonEmptyString,
      })
      .strict(),
    taskPromoteCommandOwnerCommandRequestSchema
      .extend({
        requesterHostId: nonEmptyString,
      })
      .strict(),
    taskCancelCommandOwnerCommandRequestSchema
      .extend({
        requesterHostId: nonEmptyString,
      })
      .strict(),
  ])
  .superRefine((command, ctx) => {
    addWorkspaceKeyIssue(ctx, command);
  });
export const taskOwnerCommandErrorCodeSchema = z.enum([
  "NO_ACTIVE_TASK_OWNER",
  "STALE_TASK_OWNER_COMMAND",
  "OWNER_COMMAND_FAILED",
]);
export const taskOwnerCommandResultSchema = z.discriminatedUnion("success", [
  z
    .object({
      commandRequestId: nonEmptyString,
      success: z.literal(true),
      taskCommand: zcodeTaskRuntimeCommandSchema.optional(),
    })
    .strict(),
  z
    .object({
      commandRequestId: nonEmptyString,
      success: z.literal(false),
      error: z.string(),
      code: taskOwnerCommandErrorCodeSchema.optional(),
    })
    .strict(),
]);
export const taskRealtimeEventSchema = z
  .discriminatedUnion("type", [
    taskSnapshotInvalidatedEventSchema,
    workspaceTaskListInvalidatedEventSchema,
    taskStreamMirrorBatchEventRawSchema,
  ])
  .superRefine((event, ctx) => {
    addWorkspaceKeyIssue(ctx, event);
    if (event.type === "task_stream_mirror_batch") {
      addRunIdTraceIdIssue(ctx, event);
    }
  });
export const taskRealtimeDeliveredEventSchema = z
  .discriminatedUnion("type", [
    taskSnapshotInvalidatedEventSchema
      .extend({
        originHostId: nonEmptyString,
        deliveryPurpose: taskRealtimeDeliveryPurposeSchema.optional(),
      })
      .strict(),
    workspaceTaskListInvalidatedEventSchema
      .extend({
        originHostId: nonEmptyString,
        deliveryPurpose: taskRealtimeDeliveryPurposeSchema.optional(),
      })
      .strict(),
    taskStreamMirrorBatchEventRawSchema
      .extend({
        originHostId: nonEmptyString,
        deliveryPurpose: taskRealtimeDeliveryPurposeSchema.optional(),
      })
      .strict(),
  ])
  .superRefine((event, ctx) => {
    addWorkspaceKeyIssue(ctx, event);
    if (event.type === "task_stream_mirror_batch") {
      addRunIdTraceIdIssue(ctx, event);
    }
  });
