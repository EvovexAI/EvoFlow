import { databaseStartupControlSchema, databaseStartupStateSchema } from "./database-startup.js";
import {
  sessionCreateTelemetrySchema,
  automationSessionCreateTelemetrySchema,
} from "./sessionCreateTelemetry.js";
/* eslint-disable max-lines -- 运行时 schema 当前集中在共享包入口，外部 relay payload 校验加入后先保持单一导出面。 */
import { z } from "zod";
import { zcodeProcessDiagnosticSchema } from "./process-diagnostic.js";
import { browserCommandSchema } from "./browser-use/commands.js";
import { browserCommandResultSchema } from "./browser-use/result.js";
import { REMOTE_ASSET_INSTALL_MODES } from "./remoteAssetInstallMode.js";
import { PROCESS_RESOURCE_CLI_LANES } from "./processResourceTelemetry.js";
import { isKnownRemoteResourcePackageId } from "./remoteResourcePackages.js";
import { zcodeProviderSchema } from "./providers.js";
import { zcodeAgentProviderSchema } from "./zcode-agent-policy.js";
import { modelSelectionSchema } from "./model-selection.js";
import { providerProvisioningTriggerSchema } from "./provider-provisioning.js";
import {
  zcodeMcpTelemetryEventSchema,
  zcodeMcpResourceSamplesSchema,
  zcodeToolExecResourceSchema,
  zcodeProcessResourceSampleSchema,
} from "./zcode-protocol/index.js";
import { zcodeTaskModeSchema } from "./zcode-task-mode-schema.js";
import { PROTOCOL_V4_LIMITS } from "./zcode-protocol-v4/core.js";
import { errorAttributionSchema } from "./zcode-protocol-v4/snapshot.js";
import { sessionWorkflowActivitySchema } from "./zcode-protocol-v4/sessions-index-workflow-activity.js";
import {
  taskOwnerCommandDeliverySchema,
  taskOwnerCommandRequestSchema,
  taskOwnerCommandResultSchema,
  taskRealtimeDeliveredEventSchema,
  taskRealtimeEventSchema,
  taskRealtimeHostDeliveryKindSchema,
  taskRunLeaseAcquireRequestSchema,
  taskRunLeaseResultSchema,
  taskRunLeaseTargetSchema,
  taskStreamMirrorPublishOpSchema,
  taskStreamMirrorTargetSchema,
} from "./task-realtime-core.js";

export { WSL_USER_MAX_LENGTH, isValidWslUser, wslUserSchema } from "./wslUserValidation.js";
export { zcodeTaskModeSchema } from "./zcode-task-mode-schema.js";
import { wslUserSchema } from "./wslUserValidation.js";
export {
  appSettingsOccupationEnum,
  appSettingsPatchSchema,
  appSettingsSchema,
  localeSchema,
  postUpdateReleaseNotesPayloadSchema,
} from "./validationAppSettings.js";

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

export const nonEmptyStringSchema = z.string().trim().min(1);
export const stringArraySchema = z.array(z.string());
export const credentialRecordSchema = z.record(z.string(), z.string());
export const credentialKeySchema = nonEmptyStringSchema;
export const credentialValueSchema = z.string();

export const sshConnectOptionsSchema = z.object({
  kind: z.literal("ssh"),
  host: nonEmptyStringSchema,
  port: z.number().int().positive().max(65535).optional(),
  username: nonEmptyStringSchema,
  sshConfigAlias: nonEmptyStringSchema.optional(),
  password: z.string().optional(),
  privateKeyPath: z.string().optional(),
  privateKeyPassphrase: z.string().optional(),
  assetInstallMode: z.enum(REMOTE_ASSET_INSTALL_MODES).optional(),
  resourcePackages: z
    .object({
      selectedPackageIds: z.array(z.string().refine(isKnownRemoteResourcePackageId)).optional(),
    })
    .optional(),
});

export const wslConnectOptionsSchema = z.object({
  kind: z.literal("wsl"),
  distro: z.string().optional(),
  user: wslUserSchema.optional(),
});

export const dockerConnectOptionsSchema = z.object({
  kind: z.literal("docker"),
  container: nonEmptyStringSchema,
});

export const remoteTargetSchema = z.discriminatedUnion("kind", [
  sshConnectOptionsSchema,
  wslConnectOptionsSchema,
  dockerConnectOptionsSchema,
]);

export const helloMessageSchema = z.object({
  type: z.literal("zcode-hello"),
  version: z.string(),
  platform: z.string(),
  arch: z.string(),
  pid: z.number().int(),
});

export const helloAckMessageSchema = z.object({
  type: z.literal("zcode-hello-ack"),
  version: z.string(),
  clientId: nonEmptyStringSchema,
});

export const rendererLogPayloadSchema = z.object({
  level: z.enum(["info", "warn", "error"]),
  args: z.array(z.unknown()),
});

export const taskNotificationPayloadSchema = z.object({
  taskId: nonEmptyStringSchema,
  status: z.enum([
    "completed",
    "failed",
    "permission_request",
    "elicitation_request",
    "feedback_update",
  ]),
  requestId: nonEmptyStringSchema.optional(),
  title: z.string(),
  body: z.string(),
});

export const telemetryRendererContextSchema = z.object({
  clientTimezone: nonEmptyStringSchema,
  clientLanguage: nonEmptyStringSchema,
  screenResolution: nonEmptyStringSchema,
});

export const rendererTelemetryEventPayloadSchema = z.object({
  context: telemetryRendererContextSchema,
  elementName: nonEmptyStringSchema,
  eventRegion: nonEmptyStringSchema,
  eventType: nonEmptyStringSchema,
  eventText: z.string().optional(),
  eventExtraDetail: z.record(z.string(), z.string()),
  userId: z.string().optional(),
  talkId: z.string().optional(),
  messageId: z.string().optional(),
});

export const armsCustomEventPayloadSchema = z.object({
  name: nonEmptyStringSchema,
  group: nonEmptyStringSchema,
  value: z.number().finite().optional(),
  properties: z
    .record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.undefined()]))
    .optional(),
});

export const broadcastMessageSchema = z.object({
  channel: nonEmptyStringSchema,
  payload: z.unknown(),
  sourceWindowId: z.number().int().optional(),
});

export const remoteAssetDirsSchema = z.object({
  mockCdnDir: z.string().optional(),
  remoteCdnBaseUrl: z.string().optional(),
  remoteCdnBaseUrls: z.array(z.string()).optional(),
  remoteCacheDir: z.string().optional(),
});

const hostAgentWarmupTargetSchema = z.object({
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema.optional(),
});

export const hostInitLocalMessageSchema = z.object({
  type: z.literal("init-local"),
  databaseStartupId: z.string().min(1).max(128).optional(),
  hostId: nonEmptyStringSchema.optional(),
  deliveryKind: taskRealtimeHostDeliveryKindSchema.optional(),
  deviceMid: z.string().optional(),
  feedbackApiBase: z.string().url().optional(),
  workspacePath: nonEmptyStringSchema.optional(),
  workspaceIdentity: nonEmptyStringSchema.optional(),
  agentWarmupTargets: z.array(hostAgentWarmupTargetSchema).max(3).optional(),
  agentSpawnFallbackCwd: nonEmptyStringSchema.optional(),
  zcodeBuiltinProviderConfigFilePath: nonEmptyStringSchema,
  runtimeProcessEnvPatch: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string())
    .optional(),
});

export const windowHostRemoteWorkspaceDescriptorSchema = z
  .object({
    remoteSessionId: nonEmptyStringSchema,
    target: remoteTargetSchema,
    workspacePath: nonEmptyStringSchema.optional(),
    workspaceIdentity: nonEmptyStringSchema.optional(),
    generation: z.number().int().positive(),
  })
  .strict();
export type WindowHostRemoteWorkspaceDescriptor = z.infer<
  typeof windowHostRemoteWorkspaceDescriptorSchema
>;

export const windowHostAttachmentScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }).strict(),
  z
    .object({
      kind: z.literal("remote"),
      remoteSessionId: nonEmptyStringSchema,
      workspacePath: nonEmptyStringSchema,
      workspaceIdentity: nonEmptyStringSchema,
    })
    .strict(),
]);
export type WindowHostAttachmentScope = z.infer<typeof windowHostAttachmentScopeSchema>;

export const hostConnectRemoteWorkspaceMessageSchema = z
  .object({
    type: z.literal("connect-remote-workspace"),
    requestId: nonEmptyStringSchema,
    target: remoteTargetSchema,
    remoteAssets: remoteAssetDirsSchema,
    workspacePath: nonEmptyStringSchema.optional(),
    workspaceIdentity: nonEmptyStringSchema.optional(),
  })
  .strict();

export const hostCancelRemoteWorkspaceConnectMessageSchema = z
  .object({
    type: z.literal("cancel-remote-workspace-connect"),
    requestId: nonEmptyStringSchema,
  })
  .strict();

export const hostBindRemoteWorkspaceContextMessageSchema = z
  .object({
    type: z.literal("bind-remote-workspace-context"),
    requestId: nonEmptyStringSchema,
    remoteSessionId: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema,
  })
  .strict();

export const hostDisposeRemoteWorkspaceSessionMessageSchema = z
  .object({
    type: z.literal("dispose-remote-workspace-session"),
    requestId: nonEmptyStringSchema,
    remoteSessionId: nonEmptyStringSchema,
  })
  .strict();

export const hostAttachServicePortMessageSchema = z
  .object({
    type: z.literal("attach-service-port"),
    // main 只能声明 attachment 来源；connectionId 仍由 host process 分配。
    // desktop reload/remote reattach 必须显式 continuous，手机 shared-host 必须 replayable。
    requestId: nonEmptyStringSchema,
    attachmentId: nonEmptyStringSchema,
    clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]),
    scope: windowHostAttachmentScopeSchema,
  })
  .strict();

export const hostDetachServicePortMessageSchema = z.object({
  type: z.literal("detach-service-port"),
  attachmentId: nonEmptyStringSchema,
});

export const hostDisposeMessageSchema = z.object({
  type: z.literal("dispose"),
});

export const hostBroadcastEnvelopeSchema = z.object({
  type: z.literal("broadcast"),
  message: broadcastMessageSchema,
});

export const hostBroadcastClaimResultMessageSchema = z.discriminatedUnion("status", [
  z.object({
    type: z.literal("broadcast-claim-result"),
    requestId: nonEmptyStringSchema,
    status: z.literal("acquired"),
    claimToken: nonEmptyStringSchema,
  }),
  z.object({
    type: z.literal("broadcast-claim-result"),
    requestId: nonEmptyStringSchema,
    status: z.literal("busy"),
    retryAfterMs: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("broadcast-claim-result"),
    requestId: nonEmptyStringSchema,
    status: z.literal("committed"),
  }),
]);

export const hostTaskRealtimeDeliverMessageSchema = z.object({
  type: z.literal("task-realtime-deliver"),
  event: taskRealtimeDeliveredEventSchema,
});

export const hostTaskRunLeaseResultMessageSchema = z.object({
  type: z.literal("task-run-lease-result"),
  result: taskRunLeaseResultSchema,
});

export const hostTaskOwnerCommandDeliverMessageSchema = z.object({
  type: z.literal("task-owner-command-deliver"),
  command: taskOwnerCommandDeliverySchema,
});

export const hostTaskOwnerCommandResultMessageSchema = z.object({
  type: z.literal("task-owner-command-result"),
  result: taskOwnerCommandResultSchema,
});

export const hostBotRemoteWorkspaceReconnectResultMessageSchema = z.object({
  type: z.literal("bot-remote-workspace-reconnect-result"),
  requestId: nonEmptyStringSchema,
  ok: z.boolean(),
  sessionId: nonEmptyStringSchema.optional(),
  error: z.string().optional(),
});

export const hostBotRemoteWorkspaceConnectionStatusResultMessageSchema = z.object({
  type: z.literal("bot-remote-workspace-connection-status-result"),
  requestId: nonEmptyStringSchema,
  ok: z.boolean(),
  connected: z.boolean().optional(),
  error: z.string().optional(),
});

export const hostBotRemoteWorkspaceRuntimePortMessageSchema = z.object({
  type: z.literal("bot-remote-workspace-runtime-port"),
  requestId: nonEmptyStringSchema,
  ok: z.boolean(),
  error: z.string().optional(),
});

export const sessionMessageRequestSchema = z.object({
  content: nonEmptyStringSchema,
  createdAt: nonEmptyStringSchema,
  fromSessionId: nonEmptyStringSchema,
  messageId: nonEmptyStringSchema,
  requestId: nonEmptyStringSchema,
  toSessionId: nonEmptyStringSchema,
});

export const sessionMessageDeliveryResultSchema = z.object({
  error: z.string().optional(),
  messageId: nonEmptyStringSchema,
  requestId: nonEmptyStringSchema,
  sessionId: nonEmptyStringSchema,
  status: z.enum(["success", "failed"]),
});

export const sessionRouteSchema = z.object({
  sessionId: nonEmptyStringSchema,
});

export const hostSessionMessageDeliverMessageSchema = z.object({
  type: z.literal("session-message-deliver"),
  request: sessionMessageRequestSchema,
});

export const hostSessionMessageDeliveryResultMessageSchema = z.object({
  type: z.literal("session-message-delivery-result"),
  result: sessionMessageDeliveryResultSchema,
});

export const hostFeedbackLogArchiveResultMessageSchema = z.object({
  type: z.literal("feedback-log-archive-result"),
  requestId: nonEmptyStringSchema,
  ok: z.boolean(),
  path: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});

// main → host：定时任务到点派发。会话内 cron 带 targetTaskId 时直接 sendPrompt 到当前会话；
// 历史未绑定任务才 fallback createTask + sendPrompt 建 session。
export const hostCronRunMessageSchema = z.object({
  type: z.literal("cron-run"),
  automationId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: z.string().optional(),
  prompt: nonEmptyStringSchema,
  targetTaskId: nonEmptyStringSchema.optional(),
  modelSelection: modelSelectionSchema.optional(),
  mode: z.string().optional(),
});

// main → host：闲时任务派发（仿 cron-run，字段独立不复用）。首跑不带 conversationId/sessionId，
// host createTask 新建 session；3h 续跑 / 中断恢复带上两者 resume 同一会话。
// serverTicketId 供 idle plan 适配层注入 X-Off-Peak-Ticket-ID 请求头（run 作用域）。
export const hostOffPeakRunMessageSchema = z.object({
  type: z.literal("off-peak-run"),
  offPeakTaskId: nonEmptyStringSchema,
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: z.string().optional(),
  prompt: nonEmptyStringSchema,
  // 权限四档映射现有 ZCodeTaskMode；与 cron-run 的 mode 同样按宽松 string 传输
  permissionMode: nonEmptyStringSchema,
  modelSelection: modelSelectionSchema,
  conversationId: z.string().optional(),
  sessionId: z.string().optional(),
  serverTicketId: z.string().optional(),
});

// main → host：browser-use 命令执行结果（按 requestId 关联到 host 的 pending）。
export const hostBrowserExecuteResultMessageSchema = z.object({
  type: z.literal("browser-execute-result"),
  requestId: nonEmptyStringSchema,
  result: browserCommandResultSchema,
});

export const hostLocalMediaPreviewPathAuthorizeResultMessageSchema = z
  .object({
    type: z.literal("local-media-preview-path-authorize-result"),
    requestId: nonEmptyStringSchema,
    ok: z.boolean(),
    path: nonEmptyStringSchema.optional(),
    error: z.string().optional(),
  })
  .strict();

export const hostCuaPipFocusChangedMessageSchema = z
  .object({
    type: z.literal("cua-pip-focus-changed"),
    event: z
      .object({
        kind: z.literal("focus-changed"),
        revision: z.number().int().nonnegative().safe(),
        sourceWindowId: nonEmptyStringSchema.max(255),
        sessionId: nonEmptyStringSchema.max(255).nullable(),
      })
      .strict(),
  })
  .strict();

export const hostProviderProvisioningExecuteMessageSchema = z
  .object({
    type: z.literal("provider-provisioning-execute"),
    requestId: nonEmptyStringSchema,
    environmentKey: nonEmptyStringSchema,
    remoteSessionId: nonEmptyStringSchema,
    trigger: providerProvisioningTriggerSchema,
  })
  .strict();

export const hostResourceUsageSnapshotRequestMessageSchema = z
  .object({
    type: z.literal("resource-usage-snapshot-request"),
    requestId: nonEmptyStringSchema,
  })
  .strict();
export type HostResourceUsageSnapshotRequestMessage = z.infer<
  typeof hostResourceUsageSnapshotRequestMessageSchema
>;

export const hostIncomingMessageSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("database-startup-control"), control: databaseStartupControlSchema })
    .strict(),
  hostResourceUsageSnapshotRequestMessageSchema,
  z
    .object({ type: z.literal("resource-usage-snapshot-cancel"), requestId: nonEmptyStringSchema })
    .strict(),
  hostInitLocalMessageSchema,
  hostConnectRemoteWorkspaceMessageSchema,
  hostCancelRemoteWorkspaceConnectMessageSchema,
  hostBindRemoteWorkspaceContextMessageSchema,
  hostDisposeRemoteWorkspaceSessionMessageSchema,
  hostAttachServicePortMessageSchema,
  hostDetachServicePortMessageSchema,
  hostDisposeMessageSchema,
  hostBroadcastEnvelopeSchema,
  hostBroadcastClaimResultMessageSchema,
  hostTaskRealtimeDeliverMessageSchema,
  hostTaskRunLeaseResultMessageSchema,
  hostTaskOwnerCommandDeliverMessageSchema,
  hostTaskOwnerCommandResultMessageSchema,
  hostBotRemoteWorkspaceReconnectResultMessageSchema,
  hostBotRemoteWorkspaceConnectionStatusResultMessageSchema,
  hostBotRemoteWorkspaceRuntimePortMessageSchema,
  hostSessionMessageDeliverMessageSchema,
  hostSessionMessageDeliveryResultMessageSchema,
  hostFeedbackLogArchiveResultMessageSchema,
  hostCronRunMessageSchema,
  hostOffPeakRunMessageSchema,
  hostBrowserExecuteResultMessageSchema,
  hostLocalMediaPreviewPathAuthorizeResultMessageSchema,
  hostCuaPipFocusChangedMessageSchema,
  hostProviderProvisioningExecuteMessageSchema,
]);

export const hostRemoteWorkspaceConnectedResponseSchema = z
  .object({
    type: z.literal("remote-workspace-connected"),
    requestId: nonEmptyStringSchema,
    descriptor: windowHostRemoteWorkspaceDescriptorSchema,
  })
  .strict();

export const hostRemoteWorkspaceConnectionLogResponseSchema = z
  .object({
    type: z.literal("remote-workspace-connection-log"),
    requestId: nonEmptyStringSchema,
    level: z.enum(["info", "warn", "error"]),
    message: nonEmptyStringSchema,
  })
  .strict();

export const hostRemoteWorkspaceConnectFailedResponseSchema = z
  .object({
    type: z.literal("remote-workspace-connect-failed"),
    requestId: nonEmptyStringSchema,
    error: nonEmptyStringSchema,
  })
  .strict();

export const hostRemoteWorkspaceClosedResponseSchema = z
  .object({
    type: z.literal("remote-workspace-closed"),
    remoteSessionId: nonEmptyStringSchema,
    reason: z.enum(["connection-closed", "disposed", "connect-cancelled"]),
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().nullable().optional(),
    error: z.string().optional(),
  })
  .strict();

export const hostLogResponseSchema = z.object({
  type: z.literal("log"),
  level: z.enum(["info", "warn", "error"]),
  source: z.string(),
  message: z.string(),
});

export { zcodeProviderSchema };

export const zcodeTaskMigrationSourceSchema = z.enum(["claudeCode"]);

export const hostAgentProcessSpawnedResponseSchema = z.object({
  type: z.literal("agent-process-spawned"),
  /** 进程泳道（mcp-status 等），旧 Host 不带该字段。 */
  lane: nonEmptyStringSchema.optional(),
  pid: z.number().int().positive(),
  provider: zcodeProviderSchema,
  workspacePath: nonEmptyStringSchema,
  command: z.string(),
  args: z.array(z.string()),
  startedAt: z.number().int().nonnegative(),
  runtimeGeneration: z.number().int().positive().optional(),
  runtimeInstanceId: nonEmptyStringSchema.optional(),
});
export type HostAgentProcessSpawnedResponse = z.infer<typeof hostAgentProcessSpawnedResponseSchema>;

export const hostAgentProcessReadyResponseSchema = z.object({
  type: z.literal("agent-process-ready"),
  /** 进程泳道（mcp-status 等），旧 Host 不带该字段。 */
  lane: nonEmptyStringSchema.optional(),
  pid: z.number().int().positive(),
  provider: zcodeProviderSchema,
  workspacePath: nonEmptyStringSchema,
  readyAt: z.number().int().nonnegative(),
  startupDurationMs: z.number().int().nonnegative(),
  runtimeGeneration: z.number().int().positive(),
  runtimeInstanceId: nonEmptyStringSchema,
});
export type HostAgentProcessReadyResponse = z.infer<typeof hostAgentProcessReadyResponseSchema>;

export const hostAgentProcessExitedResponseSchema = z.object({
  type: z.literal("agent-process-exited"),
  /** 进程泳道（mcp-status 等），旧 Host 不带该字段。 */
  lane: nonEmptyStringSchema.optional(),
  pid: z.number().int().positive(),
  provider: zcodeProviderSchema,
  workspacePath: nonEmptyStringSchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  endedAt: z.number().int().nonnegative(),
  terminationKind: z.enum(["expected", "unexpected", "watchdog_recycle"]),
  terminationReason: z.string().optional(),
  /** rolling-upgrade 兼容：旧 Host 缺字段时 desktop 映射 crash_phase=unknown。 */
  runtimeReady: z.boolean().optional(),
  runtimeGeneration: z.number().int().positive(),
  runtimeInstanceId: nonEmptyStringSchema.optional(),
  uptimeMs: z.number().int().nonnegative(),
  stderrLineCount: z.number().int().nonnegative(),
  stderrTail: z.array(z.string().max(1_100)).max(20).optional(),
});

export type HostAgentProcessExitedResponse = z.infer<typeof hostAgentProcessExitedResponseSchema>;

export const hostAgentProcessErrorResponseSchema = z.object({
  type: z.literal("agent-process-error"),
  /** 进程泳道（mcp-status 等），旧 Host 不带该字段。 */
  lane: nonEmptyStringSchema.optional(),
  pid: z.number().int().positive().nullable(),
  provider: zcodeProviderSchema,
  workspacePath: nonEmptyStringSchema,
  command: z.string(),
  args: z.array(z.string()),
  errorName: nonEmptyStringSchema,
  errorCode: z.string().optional(),
  errorMessage: z.string(),
  errorStack: z.string().optional(),
  runtimeGeneration: z.number().int().positive(),
  runtimeInstanceId: nonEmptyStringSchema.optional(),
  occurredAt: z.number().int().nonnegative(),
});

export type HostAgentProcessErrorResponse = z.infer<typeof hostAgentProcessErrorResponseSchema>;

export const hostAgentProcessExceptionResponseSchema = z
  .object({
    type: z.literal("agent-process-exception"),
    lane: nonEmptyStringSchema.optional(),
    pid: z.number().int().positive(),
    provider: zcodeProviderSchema,
    workspacePath: nonEmptyStringSchema,
    runtimeGeneration: z.number().int().positive(),
    runtimeInstanceId: nonEmptyStringSchema,
    diagnostic: zcodeProcessDiagnosticSchema,
  })
  .strict();
export type HostAgentProcessExceptionResponse = z.infer<
  typeof hostAgentProcessExceptionResponseSchema
>;

/**
 * services 打标后的 CLI 资源样本。
 *
 * `lane` 不是 CLI 协议字段：CLI 进程不知道自己被哪个进程管理器拉起，由 services 层在解析
 * 协议样本时按所属进程管理器补上。样本自身仍按 CLI 协议 schema 严格校验，因此 CLI 自报 lane
 * 会被协议层直接拒绝。`lane` 可选是为了兼容版本落后、还没打标的远端 server。
 */
export const processResourceCliLaneSchema = z.enum(PROCESS_RESOURCE_CLI_LANES);
export const agentLaneResourceSampleSchema = zcodeProcessResourceSampleSchema
  .extend({ lane: processResourceCliLaneSchema.optional() })
  .strict();
export type AgentLaneResourceSample = z.infer<typeof agentLaneResourceSampleSchema>;

/** Host 仅传运行环境的 SHA-256 哈希，避免原始主机、用户或 URL 进入消息与日志。 */
const resourceTelemetryEnvironmentKeySchema = z.string().regex(/^[a-f0-9]{64}$/);

export const hostAgentResourceSampleResponseSchema = z
  .object({
    type: z.literal("agent-resource-sample"),
    runtimeSurface: z.enum(["local", "remote"]),
    environmentKey: resourceTelemetryEnvironmentKeySchema.optional(),
    sample: agentLaneResourceSampleSchema,
  })
  .strict();
export type HostAgentResourceSampleResponse = z.infer<typeof hostAgentResourceSampleResponseSchema>;

/**
 * Node 进程（host / scheduler）每 60 秒自采的瞬时事实
 *
 * 只带这三项：CPU 与 RSS 由 main 的 `getAppMetrics()` 负责，heap 只有进程自己读得到。
 */
export const nodeSelfResourceSampleSchema = z
  .object({
    /**
     * 整机归一化 CPU 百分比，100 表示所有逻辑核占满。
     * 上限刻意放宽（与 CLI 的 `zcodeProcessResourceSampleSchema` 同口径）：读数异常时宁可让
     * 样本带着离谱数值上去、由平台侧数值异常规则暴露，也不在客户端静默丢样本。
     */
    cpuPercent: z.number().finite().nonnegative().max(100_000),
    rssKb: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    heapUsedKb: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type NodeSelfResourceSample = z.infer<typeof nodeSelfResourceSampleSchema>;

/**
 * 主窗口 renderer 每 60 秒经 preload 桥送 main 的 heap 读数
 *
 * 只带 heap：renderer 的 CPU 与 RSS 由 main 的 `getAppMetrics()` 负责，
 * renderer 自己也读不到。`strict` 保证 UI 侧不会顺手夹带路径、session 等隐私字段。
 */
export const rendererHeapSampleSchema = z
  .object({
    heapUsedKb: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type RendererHeapSample = z.infer<typeof rendererHeapSampleSchema>;

export const hostResourceSampleResponseSchema = z
  .object({
    type: z.literal("host-resource-sample"),
    sample: nodeSelfResourceSampleSchema,
  })
  .strict();
export type HostResourceSampleResponse = z.infer<typeof hostResourceSampleResponseSchema>;

export const hostMcpResourceSamplesResponseSchema = z
  .object({
    type: z.literal("mcp-resource-samples"),
    runtimeSurface: z.enum(["local", "remote"]),
    environmentKey: resourceTelemetryEnvironmentKeySchema.optional(),
    samples: zcodeMcpResourceSamplesSchema,
  })
  .strict();
export type HostMcpResourceSamplesResponse = z.infer<typeof hostMcpResourceSamplesResponseSchema>;

export const hostToolExecResourceResponseSchema = z
  .object({
    type: z.literal("tool-exec-resource"),
    runtimeSurface: z.enum(["local", "remote"]),
    sample: zcodeToolExecResourceSchema,
  })
  .strict();
export type HostToolExecResourceResponse = z.infer<typeof hostToolExecResourceResponseSchema>;

export const hostMcpTelemetryResponseSchema = z
  .object({
    type: z.literal("mcp-telemetry"),
    runtimeSurface: z.enum(["local", "remote"]),
    event: zcodeMcpTelemetryEventSchema,
  })
  .strict();
export type HostMcpTelemetryResponse = z.infer<typeof hostMcpTelemetryResponseSchema>;

export const hostSessionCreateTelemetryResponseSchema = z
  .object({
    type: z.literal("session-create-telemetry"),
    event: automationSessionCreateTelemetrySchema,
  })
  .strict();
export type HostSessionCreateTelemetryResponse = z.infer<
  typeof hostSessionCreateTelemetryResponseSchema
>;

export const hostAgentRunningTaskCountChangedResponseSchema = z.object({
  type: z.literal("agent-running-task-count-changed"),
  runningTaskCount: z.number().int().nonnegative(),
});

export const hostWorkspaceRunningTaskCountChangedResponseSchema = z.object({
  type: z.literal("workspace-running-task-count-changed"),
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema.optional(),
  runningTaskCount: z.number().int().nonnegative(),
});

export const hostCuaOperationStateResponseSchema = z
  .object({
    type: z.literal("cua-operation-state"),
    active: z.boolean(),
    sessionId: nonEmptyStringSchema,
    turnId: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema.optional(),
  })
  .strict();

export type HostCuaOperationStateResponse = z.infer<typeof hostCuaOperationStateResponseSchema>;

export const hostBroadcastClaimRequestResponseSchema = z.object({
  type: z.literal("broadcast-claim-request"),
  requestId: nonEmptyStringSchema,
  key: nonEmptyStringSchema.max(1_024),
});

export const hostBroadcastClaimCommitResponseSchema = z.object({
  type: z.literal("broadcast-claim-commit"),
  key: nonEmptyStringSchema.max(1_024),
  claimToken: nonEmptyStringSchema,
});

export const hostBroadcastClaimReleaseResponseSchema = z.object({
  type: z.literal("broadcast-claim-release"),
  key: nonEmptyStringSchema.max(1_024),
  claimToken: nonEmptyStringSchema,
});

export const hostTaskRealtimePublishResponseSchema = z.object({
  type: z.literal("task-realtime-publish"),
  event: taskRealtimeEventSchema,
});

export const hostTaskStreamOpPublishResponseSchema = z.object({
  type: z.literal("task-stream-op-publish"),
  target: taskStreamMirrorTargetSchema,
  op: taskStreamMirrorPublishOpSchema,
});

export const hostTaskRunLeaseAcquireResponseSchema = z.object({
  type: z.literal("task-run-lease-acquire"),
  request: taskRunLeaseAcquireRequestSchema,
});

export const hostTaskRunLeaseReleaseResponseSchema = z.object({
  type: z.literal("task-run-lease-release"),
  target: taskRunLeaseTargetSchema,
});

export const hostTaskOwnerCommandRequestResponseSchema = z.object({
  type: z.literal("task-owner-command-request"),
  command: taskOwnerCommandRequestSchema,
});

export const hostTaskOwnerCommandResultResponseSchema = z.object({
  type: z.literal("task-owner-command-result"),
  result: taskOwnerCommandResultSchema,
});

export const hostBotRemoteWorkspaceReconnectRequestResponseSchema = z.object({
  type: z.literal("bot-remote-workspace-reconnect-request"),
  requestId: nonEmptyStringSchema,
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema,
  target: remoteTargetSchema,
});

export const hostBotRemoteWorkspaceConnectionStatusRequestResponseSchema = z.object({
  type: z.literal("bot-remote-workspace-connection-status-request"),
  requestId: nonEmptyStringSchema,
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema,
  target: remoteTargetSchema,
});

export const hostBotRemoteWorkspaceRuntimePortRequestResponseSchema = z.object({
  type: z.literal("bot-remote-workspace-runtime-port-request"),
  requestId: nonEmptyStringSchema,
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema,
  target: remoteTargetSchema,
});

export const hostSessionMessageSendRequestedResponseSchema = z.object({
  type: z.literal("session-message-send-requested"),
  request: sessionMessageRequestSchema,
});

export const hostSessionRouteAnnounceResponseSchema = z.object({
  type: z.literal("session-route-announce"),
  route: sessionRouteSchema,
});

export const hostSessionMessageDeliverResultResponseSchema = z.object({
  type: z.literal("session-message-deliver-result"),
  result: sessionMessageDeliveryResultSchema,
});

export const hostFeedbackLogArchiveRequestResponseSchema = z.object({
  type: z.literal("feedback-log-archive-request"),
  requestId: nonEmptyStringSchema,
  sourceDir: nonEmptyStringSchema,
});

// host → main：定时任务派发结果。ok=已成功创建 session 且 prompt 已发出。
export const hostCronRunResultResponseSchema = z.object({
  type: z.literal("cron-run-result"),
  runId: nonEmptyStringSchema,
  ok: z.boolean(),
  taskId: z.string().optional(),
  sessionId: z.string().optional(),
  error: z.string().optional(),
  failureKind: z.enum(["transient", "permanent"]).optional(),
});

// host → main：闲时任务派发结果。ok=session 已确保存在且 prompt 已发出；迟到结果用 offPeakTaskId 兜底结算。
export const hostOffPeakRunResultResponseSchema = z.object({
  type: z.literal("off-peak-run-result"),
  offPeakTaskId: nonEmptyStringSchema,
  ok: z.boolean(),
  conversationId: z.string().optional(),
  sessionId: z.string().optional(),
  error: z.string().optional(),
  failureKind: z.enum(["transient", "permanent"]).optional(),
});

// host → main：manual run 落库后的 scheduler 唤醒请求；业务数据仍由 scheduler 从 sqlite 读取。
export const hostCronSchedulerWakeRequestResponseSchema = z.object({
  type: z.literal("cron-scheduler-wake-request"),
  automationId: nonEmptyStringSchema,
});

// host → main：闲时任务 schedulable 翻转后的 scheduler 唤醒；业务数据仍由 scheduler 从 sqlite 读取。
export const hostOffPeakSchedulerWakeRequestResponseSchema = z.object({
  type: z.literal("off-peak-scheduler-wake-request"),
  offPeakTaskId: z.string().optional(),
});

// host → main：执行一条 browser-use 命令（main 用 WebContentsView+CDP 执行）。
export const hostBrowserExecuteRequestResponseSchema = z.object({
  type: z.literal("browser-execute-request"),
  requestId: nonEmptyStringSchema,
  // 迁移兼容：旧 host bundle 没有 browserId/context；新 browser-client 链路始终携带。
  browserId: nonEmptyStringSchema.optional(),
  browserGeneration: z.number().int().nonnegative().optional(),
  sessionId: nonEmptyStringSchema,
  turnId: nonEmptyStringSchema.optional(),
  workspaceKey: nonEmptyStringSchema.optional(),
  workspacePath: nonEmptyStringSchema.optional(),
  workspaceIdentity: nonEmptyStringSchema.optional(),
  remoteSessionId: nonEmptyStringSchema.optional(),
  clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]).optional(),
  sessionContext: z.enum(["live", "cached"]).optional(),
  command: browserCommandSchema,
});

export const hostLocalMediaPreviewPathAuthorizeRequestResponseSchema = z
  .object({
    type: z.literal("local-media-preview-path-authorize-request"),
    requestId: nonEmptyStringSchema,
    path: nonEmptyStringSchema,
  })
  .strict();

export const networkObservationSchema = z.object({
  transport: z.enum(["http", "websocket", "rpc"]),
  interface: z.string(),
  durationMs: z.number(),
  ok: z.boolean(),
  statusCode: z.number().optional(),
  errorKind: z.string().optional(),
  attempt: z.number().int().positive().optional(),
  dnsMs: z.number().optional(),
  tcpMs: z.number().optional(),
  tlsMs: z.number().optional(),
  ttfbMs: z.number().optional(),
  downloadMs: z.number().optional(),
});

export const hostNetworkTelemetryBatchResponseSchema = z.object({
  type: z.literal("network-telemetry-batch"),
  observations: z.array(networkObservationSchema).max(500),
});

export const hostProviderProvisioningSourceChangedResponseSchema = z
  .object({
    type: z.literal("provider-provisioning-source-changed"),
    trigger: providerProvisioningTriggerSchema.exclude(["environment-online"]),
  })
  .strict();

export const hostProviderProvisioningExecutionResultResponseSchema = z
  .object({
    type: z.literal("provider-provisioning-execution-result"),
    requestId: nonEmptyStringSchema,
    environmentKey: nonEmptyStringSchema,
    status: z.enum(["applied", "already-applied", "unsupported", "failed", "rollback_failed"]),
    error: z.string().optional(),
  })
  .strict();

export const hostResourceUsageProcessSchema = z
  .object({
    pid: z.number().int().positive(),
    name: nonEmptyStringSchema,
    category: z.enum(["base", "builtin-plugin", "community-plugin"]),
    groupKey: nonEmptyStringSchema,
    groupLabel: nonEmptyStringSchema,
    cpuPercent: z.number().finite().nonnegative(),
    memoryBytes: z.number().finite().nonnegative(),
  })
  .strict();

export const hostResourceUsageSnapshotResultResponseSchema = z
  .object({
    type: z.literal("resource-usage-snapshot-result"),
    requestId: nonEmptyStringSchema,
    sampledAt: z.number().int().nonnegative(),
    processes: z.array(hostResourceUsageProcessSchema).max(10_000),
  })
  .strict();
export type HostResourceUsageSnapshotResultResponse = z.infer<
  typeof hostResourceUsageSnapshotResultResponseSchema
>;

export const hostResponseMessageSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("database-startup-state"), state: databaseStartupStateSchema })
    .strict(),
  hostResourceUsageSnapshotResultResponseSchema,
  hostRemoteWorkspaceConnectionLogResponseSchema,
  hostRemoteWorkspaceConnectedResponseSchema,
  hostRemoteWorkspaceConnectFailedResponseSchema,
  hostRemoteWorkspaceClosedResponseSchema,
  hostLogResponseSchema,
  hostAgentProcessSpawnedResponseSchema,
  hostAgentProcessReadyResponseSchema,
  hostAgentProcessExitedResponseSchema,
  hostAgentProcessErrorResponseSchema,
  hostAgentProcessExceptionResponseSchema,
  hostAgentResourceSampleResponseSchema,
  hostResourceSampleResponseSchema,
  hostMcpTelemetryResponseSchema,
  hostMcpResourceSamplesResponseSchema,
  hostToolExecResourceResponseSchema,
  hostSessionCreateTelemetryResponseSchema,
  hostAgentRunningTaskCountChangedResponseSchema,
  hostWorkspaceRunningTaskCountChangedResponseSchema,
  hostCuaOperationStateResponseSchema,
  hostBroadcastEnvelopeSchema,
  hostBroadcastClaimRequestResponseSchema,
  hostBroadcastClaimCommitResponseSchema,
  hostBroadcastClaimReleaseResponseSchema,
  hostTaskRealtimePublishResponseSchema,
  hostTaskStreamOpPublishResponseSchema,
  hostTaskRunLeaseAcquireResponseSchema,
  hostTaskRunLeaseReleaseResponseSchema,
  hostTaskOwnerCommandRequestResponseSchema,
  hostTaskOwnerCommandResultResponseSchema,
  hostBotRemoteWorkspaceReconnectRequestResponseSchema,
  hostBotRemoteWorkspaceConnectionStatusRequestResponseSchema,
  hostBotRemoteWorkspaceRuntimePortRequestResponseSchema,
  hostSessionMessageSendRequestedResponseSchema,
  hostSessionRouteAnnounceResponseSchema,
  hostSessionMessageDeliverResultResponseSchema,
  hostFeedbackLogArchiveRequestResponseSchema,
  hostBrowserExecuteRequestResponseSchema,
  hostLocalMediaPreviewPathAuthorizeRequestResponseSchema,
  hostNetworkTelemetryBatchResponseSchema,
  hostProviderProvisioningSourceChangedResponseSchema,
  hostProviderProvisioningExecutionResultResponseSchema,
  hostCronRunResultResponseSchema,
  hostOffPeakRunResultResponseSchema,
  hostCronSchedulerWakeRequestResponseSchema,
  hostOffPeakSchedulerWakeRequestResponseSchema,
]);

export const zcodeTaskPersistStatusSchema = z.enum(["running", "completed", "error"]);

export const zcodePromptImageAttachmentSchema = z.object({
  kind: z.literal("image"),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative().optional(),
  dataBase64: z.string().optional(),
  localPath: z.string().optional(),
});

// 附件 TypeScript 联合类型新增 video 后，手写的持久化运行时 schema 未同步，
// session 恢复解析会拒绝含视频的用户消息。字段与 image 的 inline/local 引用语义保持一致。
export const zcodePromptVideoAttachmentSchema = z.object({
  kind: z.literal("video"),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative().optional(),
  dataBase64: z.string().optional(),
  localPath: z.string().optional(),
});

export const zcodePromptPdfAttachmentSchema = z.object({
  kind: z.literal("pdf"),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative().optional(),
  dataBase64: z.string().optional(),
  localPath: z.string().optional(),
});

export const zcodePromptFileAttachmentSchema = z.object({
  kind: z.literal("file"),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  dataBase64: z.string().optional(),
  textContent: z.string().optional(),
  localPath: z.string().optional(),
});

export const zcodePromptAttachmentSchema = z.discriminatedUnion("kind", [
  zcodePromptImageAttachmentSchema,
  zcodePromptVideoAttachmentSchema,
  zcodePromptPdfAttachmentSchema,
  zcodePromptFileAttachmentSchema,
]);

export const zcodePersistedToolCallSchema = z.object({
  toolName: z.string().optional(),
  title: z.string().optional(),
  kind: z.string().optional(),
  status: z.enum(["completed", "failed", "denied", "stopped"]).optional(),
  input: z.unknown(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  raw: z.unknown().optional(),
  snapshotRefs: z
    .array(
      z.object({
        field: z.enum(["input", "output", "raw"]),
        refId: z.string(),
        hash: z.string(),
        fullBytes: z.number().int().nonnegative(),
        previewBytes: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});

const zcodePersistedMessagePartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("content"), content: z.string() }),
  z.object({ type: z.literal("thought"), content: z.string() }),
  z.object({
    type: z.literal("tool-call"),
    toolIndex: z.number().int().nonnegative(),
  }),
]);

export const zcodePersistedMessageSchema = z.object({
  id: z.string().optional(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  timestamp: z.number().int().nonnegative(),
  model: z.string().optional(),
  characterCount: z.number().int().nonnegative().optional(),
  // assistant 历史耗时已经在服务层落盘为 durationMs，
  // 但校验 schema 没同步，saveTask/getTaskSnapshot 解析时会把它静默剥掉，
  // 导致新消息结束后 UI 仍然只能看到“Worked”。这里补上字段以保留持久化值。
  durationMs: z.number().int().nonnegative().optional(),
  interrupted: z.boolean().optional(),
  feedback: z.enum(["like", "dislike"]).optional(),
  attachments: z.array(zcodePromptAttachmentSchema).optional(),
  tools: z.array(zcodePersistedToolCallSchema).optional(),
  thought: z.string().optional(),
  parts: z.array(zcodePersistedMessagePartSchema).optional(),
  checkpointState: z.enum(["partial"]).optional(),
  checkpointReason: z.enum(["tool_completed", "part_boundary", "periodic"]).optional(),
  checkpointUpdatedAt: z.number().int().nonnegative().optional(),
  turnIndex: z.number().int().nonnegative().optional(),
  // snapshot 按需加载依赖 bodyRefs（content/thought -> refId）定位完整内容；
  // 若 schema 缺字段，Zod 会在解析 session 文件时静默剥离，导致“加载完整内容”功能失效。
  bodyRefs: z
    .array(
      z.object({
        field: z.enum(["content", "thought"]),
        refId: z.string(),
        hash: z.string(),
        fullBytes: z.number().int().nonnegative(),
        previewBytes: z.number().int().nonnegative(),
      }),
    )
    .optional(),
  toolSlice: z
    .object({
      persistedMessageIndex: z.number().int().nonnegative(),
      totalTools: z.number().int().nonnegative(),
      startToolIndex: z.number().int().nonnegative(),
      endToolIndexExclusive: z.number().int().nonnegative(),
    })
    .optional(),
});

export const zcodeTaskGoalStatusSchema = z.enum(["active", "paused", "budget_limited", "complete"]);

export const zcodeTaskTargetChangedActionSchema = z.enum([
  "set",
  "status_updated",
  "cleared",
  "usage_accounted",
  "run_started",
  "run_finished",
  "summary_updated",
]);

export const zcodeTaskTargetChangedSourceSchema = z.enum(["command", "tool", "runtime"]);

export const zcodeTaskGoalSchema = z.object({
  sessionID: nonEmptyStringSchema,
  targetID: nonEmptyStringSchema,
  objective: nonEmptyStringSchema,
  // 2.15.0 之前的 /goal 历史任务没有写 summaryTitle。
  // 读取 task index 老数据时要补成 null，否则整个任务列表会被运行时 schema 拒绝。
  summaryTitle: z.string().min(1).nullable().default(null),
  status: zcodeTaskGoalStatusSchema,
  tokenBudget: z.number().int().positive().nullable(),
  tokensUsed: z.number().int().nonnegative(),
  timeUsedSeconds: z.number().int().nonnegative(),
  activeInputId: nonEmptyStringSchema.nullable().optional(),
  activeRunStartedAtMs: z.number().int().nonnegative().nullable().optional(),
  activeRunLastSeenAtMs: z.number().int().nonnegative().nullable().optional(),
  time: z.object({
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
  }),
});

export const zcodeTaskGoalChangedPatchSchema = z.object({
  action: zcodeTaskTargetChangedActionSchema,
  source: zcodeTaskTargetChangedSourceSchema,
  target: zcodeTaskGoalSchema.nullable(),
  previousTarget: zcodeTaskGoalSchema.nullable().optional(),
});

export const zcodeTaskTargetStatusSchema = zcodeTaskGoalStatusSchema;
export const zcodeTaskTargetSchema = zcodeTaskGoalSchema;
export const zcodeTaskTargetChangedPatchSchema = zcodeTaskGoalChangedPatchSchema;

export const zcodeTaskMetaSchema = z.object({
  taskId: nonEmptyStringSchema,
  traceId: nonEmptyStringSchema,
  title: z.string(),
  titleOverridden: z.boolean().optional(),
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema.optional(),
  workspacePurpose: z.enum(["project", "conversation"]).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  mode: zcodeTaskModeSchema,
  model: z.string().optional(),
  thoughtLevel: nonEmptyStringSchema.optional(),
  runtimeEpoch: z.number().int().nonnegative().optional(),
  provider: zcodeAgentProviderSchema.optional(),
  migrationSource: zcodeTaskMigrationSourceSchema.optional(),
  forkedFromTaskId: nonEmptyStringSchema.optional(),
  // cron automation 身份：随 meta_json 一起持久化（单一来源），同时在写入时投影到 tasks 表
  // cron_automation_id 索引列，供按 automation 反查 session。runId 属于 automation_runs /
  // 投递 metadata，不属于 task 表。
  cronAutomationId: nonEmptyStringSchema.optional(),
  // off-peak 身份：与 cron 同款持久化策略——meta_json 单一来源 + tasks 表
  // off_peak_task_id 索引投影列（兜底/反查）。
  offPeakTaskId: nonEmptyStringSchema.optional(),
  unreadAt: z.number().int().nonnegative().optional(),
  status: zcodeTaskPersistStatusSchema.optional(),
  lastError: z
    .object({
      code: z.string().optional(),
      detail: z.string().optional(),
      message: z.string().min(1),
      traceId: nonEmptyStringSchema.optional(),
      taskId: nonEmptyStringSchema.optional(),
      attribution: errorAttributionSchema.optional(),
    })
    .optional(),
  changeSummary: z
    .object({
      fileCount: z.number().int().nonnegative(),
      added: z.number().int().nonnegative(),
      removed: z.number().int().nonnegative(),
      files: z.array(
        z.object({
          path: z.string(),
          added: z.number().int().nonnegative(),
          removed: z.number().int().nonnegative(),
          writeCount: z.number().int().positive(),
          lastTurnIndex: z.number().int().nonnegative(),
        }),
      ),
    })
    .optional(),
  target: zcodeTaskGoalSchema.nullable().optional(),
});

export const zcodeTaskIndexEntrySchema = z.object({
  workspaceHash: nonEmptyStringSchema,
  taskId: nonEmptyStringSchema,
});

export const zcodePinnedTasksFileSchema = z.object({
  version: z.literal("1"),
  tasks: z.array(zcodeTaskIndexEntrySchema),
});

const zcodePersistedFileSnapshotSchema = z.object({
  path: z.string(),
  beforeContent: z.string().nullable(),
  afterContent: z.string(),
  writeCount: z.number().int().positive(),
  contentRefs: z
    .array(
      z.object({
        field: z.enum(["beforeContent", "afterContent"]),
        refId: z.string(),
        hash: z.string(),
        fullBytes: z.number().int().nonnegative(),
        previewBytes: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});

const zcodePersistedFileChangeSchema = z.object({
  turnIndex: z.number().int().nonnegative(),
  snapshots: z.array(zcodePersistedFileSnapshotSchema),
  fileState: z.enum(["applied", "reverted"]).optional(),
});

const zcodePersistedTurnCheckpointSchema = z.object({
  turnIndex: z.number().int().nonnegative(),
  baseFileCheckpointId: nonEmptyStringSchema,
  resultFileCheckpointId: nonEmptyStringSchema.optional(),
});

export const zcodeSessionFileSchema = z.object({
  meta: zcodeTaskMetaSchema,
  messages: z.array(zcodePersistedMessageSchema),
  fileChanges: z.array(zcodePersistedFileChangeSchema).optional(),
  turnCheckpoints: z.array(zcodePersistedTurnCheckpointSchema).optional(),
});
