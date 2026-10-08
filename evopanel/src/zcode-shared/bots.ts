/* oxlint-disable eslint(max-lines) -- Bot 共享合约集中维护 provider、状态和 schema，保持类型与校验就近。 */
import { z } from "zod";
import { modelSelectionSchema, type ModelSelection } from "./model-selection.js";
import { ZCODE_AGENT_PROVIDER, ZCODE_AGENT_PROVIDER_LABEL } from "./zcode-agent-policy.js";
import type {
  ZCodeConfigOption,
  ZCodeElicitationRequest,
  ZCodeElicitationQuestion,
  ZCodePermissionRequest,
  ZCodePromptAttachment,
  ZCodeProvider,
  ZCodeStreamEvent,
  ZCodeTaskMeta,
  ZCodeTaskRuntimeStatus,
} from "./zcode-task-types-core.js";
import {
  zcodeInteractionRequestOriginSchema,
  zcodePermissionResponseSchema,
  type ZCodeInteractionRequestOrigin,
  type ZCodePermissionResponse,
} from "./zcode-protocol-legacy-types.js";
import type { Locale } from "./protocol.js";

export const botProviders = [
  "telegram",
  "webhook",
  "feishu",
  "lark",
  "weixin",
  "discord",
  "wecom",
] as const;

export type BotProvider = (typeof botProviders)[number];
export type FeishuBotProvider = Extract<BotProvider, "feishu" | "lark">;

/**
 * 定时任务完成后的 Bot 回推目标。只保留未来仍稳定的会话地址；当前消息 id/context token
 * 属于一次入站交互，不能持久化后复用。该字段由 Host 注入，模型工具参数不直接暴露。
 */
export const zcodeAutomationBotDeliveryTargetSchema = z
  .object({
    provider: z.enum(["feishu", "lark", "weixin"]),
    botId: z.string().trim().min(1),
    providerUserId: z.string().trim().min(1),
    chatType: z.enum(["private", "group"]),
  })
  .strict();

export type ZCodeAutomationBotDeliveryTarget = z.infer<
  typeof zcodeAutomationBotDeliveryTargetSchema
>;

export function isFeishuBotProvider(provider: BotProvider): provider is FeishuBotProvider {
  return provider === "feishu" || provider === "lark";
}
export type BotContextMode = "draft" | "task";
export type BotReplyGranularity =
  | "assistant_changes"
  | "assistant_toolcalls_changes"
  | "summary_changes"
  | "streaming_card";

export const BOT_REPLY_GRANULARITIES = [
  "assistant_changes",
  "assistant_toolcalls_changes",
  "summary_changes",
  "streaming_card",
] as const satisfies readonly BotReplyGranularity[];

export const ALL_BOT_WORKSPACES = "*";
export const BOT_BIND_CODE_TTL_MS = 30_000;

export interface BotWorkspaceRef {
  id: string;
  label: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface BotAllowedCommands {
  status: boolean;
  new: boolean;
  workspace: boolean;
  model: boolean;
  mode?: boolean;
  thoughtLevel: boolean;
  sandboxMode?: boolean;
  approvalPolicy?: boolean;
  reply: boolean;
}

export type BotCommandPolicy = BotAllowedCommands;

export interface BotCurrentOptions {
  modelSelection?: ModelSelection;
  mode?: string;
  sandboxMode?: string;
  approvalPolicy?: string;
}

export type BotReplyMode = BotReplyGranularity;

export interface BotConfig {
  id: string;
  name: string;
  provider: BotProvider;
  enabled: boolean;
  credentialRef?: string;
  webhookSecretRef?: string;
  webhookUrl?: string;
  webhookAuthHeaderName?: string;
  feishuAppId?: string;
  providerUserId?: string;
  displayName?: string;
  allowedWorkspaces: string[];
  allowedCommands: BotAllowedCommands;
  currentOptions: BotCurrentOptions;
  replyMode: BotReplyMode;
}

export interface BotPendingPermissionOption {
  requestId: string;
  optionId: string;
  command: "approve" | "deny";
  label: string;
  response: ZCodePermissionResponse;
  handledAt?: number;
}

export interface BotPendingElicitation {
  taskId: string;
  requestId: string;
  runId: string;
  origin?: ZCodeInteractionRequestOrigin;
  actorKey?: string;
  currentQuestionIndex: number;
  questions: ZCodeElicitationQuestion[];
  answers: Record<string, string[]>;
  renderContext?: {
    kind: "plan_approval";
    plan: string;
  };
  expandedCustomAnswerQuestionIndexes?: number[];
  handledAt?: number;
}

export interface BotStructuredElicitationResponse {
  requestId: string;
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

export interface BotOutboundElicitationRequest {
  requestId: string;
  taskId: string;
  runId: string;
  currentQuestionIndex: number;
  questions: ZCodeElicitationQuestion[];
  answers?: Record<string, string[]>;
  status?: "pending" | "completed" | "cancelled";
  expandedCustomAnswerQuestionIndexes?: number[];
  schema?: unknown;
}

export interface BotDraftOptions {
  provider: ZCodeProvider;
  modelSelection?: ModelSelection;
  mode?: string;
}

export interface BotsConfigFile {
  version: 3;
  bots: BotConfig[];
}

export interface BotState {
  botId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceId?: string;
  mode: BotContextMode;
  activeTaskId: string | null;
  draftOptions?: BotDraftOptions;
  pendingPermissionOptions?: BotPendingPermissionOption[];
  pendingElicitation?: BotPendingElicitation;
  telegramOffset?: number;
  weixinGetUpdatesBuf?: string;
  weixinActivatedAt?: number;
  updatedAt: number;
}

export type BotContextState = BotState;

export interface BotsStateFile {
  version: 3;
  bots: Record<string, BotState>;
}

export interface BotRuntimeInfo {
  /** 最近一次消息投递错误；独立于长连接状态，成功投递后清除。 */
  deliveryError?: string;
  botId: string;
  provider: BotProvider;
  status: "disabled" | "idle" | "polling" | "connected" | "error";
  messageId?: string;
  message?: string;
  lastUpdateAt?: number;
  offset?: number;
}

export interface BotActor {
  provider: BotProvider;
  botId: string;
  providerUserId: string;
  displayName?: string;
  chatType: "private" | "group";
  chatId?: string;
  providerMessageId?: string;
  providerContextToken?: string;
}

export type BotInboundAttachmentKind = "image" | "audio" | "video" | "file";

export interface BotInboundAttachment {
  id: string;
  kind: BotInboundAttachmentKind;
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  providerFileId?: string;
  downloadUrl?: string;
  dataBase64?: string;
  localPath?: string;
  providerMetadata?: Record<string, string>;
}

export type BotCommand =
  | { type: "bind"; code: string }
  | { type: "help" }
  | { type: "status" }
  | { type: "new" }
  | { type: "reconnect" }
  | { type: "workspace.list" }
  | { type: "workspace.set"; value: string }
  | { type: "model.list" }
  | { type: "model.provider.set"; value: string }
  | { type: "model.set"; value: string }
  | { type: "mode.list" }
  | { type: "mode.set"; value: string }
  | { type: "thoughtLevel.list" }
  | { type: "thoughtLevel.set"; value: string }
  | { type: "task.list" }
  | { type: "task.set"; value: string }
  | { type: "reply.list" }
  | { type: "reply.set"; value: string }
  | { type: "stop" }
  | { type: "permission.respond"; value: string }
  | { type: "elicitation.respond"; value: string }
  | { type: "elicitation.submit" }
  | { type: "approve"; requestId: string; optionId: string }
  | { type: "deny"; requestId: string }
  | { type: "unknown"; name: string; raw: string }
  | { type: "selection.cancel" }
  | { type: "message"; text: string };

export interface SelectionPrompt {
  id: string;
  token?: string;
  title: string;
  currentId?: string;
  cancelLabel?: string;
  showCancel?: boolean;
  action:
    | "workspace.set"
    | "model.provider.set"
    | "model.set"
    | "mode.set"
    | "thoughtLevel.set"
    | "task.set"
    | "reply.set"
    | "permission.respond"
    | "elicitation.respond";
  options: Array<{
    id: string;
    label: string;
    description?: string;
  }>;
}

export interface BotInboundMessage {
  botId: string;
  actor: BotActor;
  text: string;
  attachments?: BotInboundAttachment[];
  elicitationResponse?: BotStructuredElicitationResponse;
  receivedAt?: number;
}

export interface BotOutboundMessage {
  botId: string;
  provider: BotProvider;
  providerUserId: string;
  text: string;
  locale?: Locale;
  selection?: SelectionPrompt;
  elicitation?: BotOutboundElicitationRequest;
  providerContextToken?: string;
}

export interface BotTaskSummary {
  taskId: string;
  title: string;
  status: ZCodeTaskRuntimeStatus | "persisted-completed" | "persisted-error" | "unknown";
  workspacePath: string;
  workspaceIdentity?: string;
  provider?: ZCodeProvider;
  model?: string;
}

export const BOT_TASK_BROADCAST_CHANNEL = "bots:task";
export const BOT_TASK_STREAM_BROADCAST_CHANNEL = "bots:task-stream";

export type BotTaskBroadcastEvent =
  | "created"
  | "prompt_sent"
  | "resumed"
  | "streaming"
  | "permission_request"
  | "permission_resolved"
  | "elicitation_request"
  | "elicitation_resolved"
  | "updated"
  | "completed"
  | "error";

export interface BotTaskBroadcastPayload {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  event: BotTaskBroadcastEvent;
  updatedAt: number;
  task?: ZCodeTaskMeta;
  provider?: ZCodeProvider;
  configOptions?: ZCodeConfigOption[];
  prompt?: {
    content: string;
    attachments?: ZCodePromptAttachment[];
    messageId: string;
    sentAt: number;
  };
  permissionRequest?: ZCodePermissionRequest;
  elicitationRequest?: ZCodeElicitationRequest;
  requestId?: string;
  error?: string;
}

export interface BotTaskStreamBroadcastPayload {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  event: ZCodeStreamEvent;
  updatedAt: number;
}

export interface BotServiceStatus {
  botsCount: number;
  enabledBotsCount: number;
  contextsCount: number;
  botRuntime: BotRuntimeInfo[];
}

export interface BotProviderCallbackResult {
  ok: boolean;
  replies: BotOutboundMessage[];
  responseBody?: unknown;
  status?: number;
}

export const botAllowedCommandsSchema = z
  .object({
    status: z.boolean(),
    new: z.boolean(),
    workspace: z.boolean(),
    model: z.boolean(),
    mode: z.boolean().optional(),
    thoughtLevel: z.boolean(),
    sandboxMode: z.boolean().optional(),
    approvalPolicy: z.boolean().optional(),
    // 兼容旧 bot-config.json；/cli 命令已移除，新配置不会再写入这个字段。
    cli: z.boolean().optional(),
    reply: z.boolean(),
  })
  .strict();

export const botCommandPolicySchema = botAllowedCommandsSchema;

export const botCurrentOptionsSchema = z
  .object({
    modelSelection: modelSelectionSchema.optional(),
    mode: z.string().min(1).optional(),
    sandboxMode: z.string().min(1).optional(),
    approvalPolicy: z.string().min(1).optional(),
    // 兼容旧 bot-config.json；CLI provider 现在统一由 ZCode Protocol 侧配置决定。
    cli: z.literal(ZCODE_AGENT_PROVIDER).optional(),
  })
  .strict();

export const botDraftOptionsSchema = z
  .object({
    provider: z.literal(ZCODE_AGENT_PROVIDER),
    modelSelection: modelSelectionSchema.optional(),
    mode: z.string().min(1).optional(),
  })
  .strict();

const botElicitationOptionSchema = z
  .object({
    value: z.string(),
    label: z.string(),
    description: z.string().optional(),
  })
  .strict();

const botElicitationQuestionSchema = z
  .object({
    question: z.string(),
    header: z.string(),
    options: z.array(botElicitationOptionSchema),
    multiSelect: z.boolean().optional(),
  })
  .strict();

const botPendingElicitationSchema = z
  .object({
    taskId: z.string().min(1),
    requestId: z.string().min(1),
    runId: z.string().min(1),
    origin: zcodeInteractionRequestOriginSchema.optional(),
    actorKey: z.string().min(1).optional(),
    currentQuestionIndex: z.number().int().min(0),
    questions: z.array(botElicitationQuestionSchema),
    answers: z.record(z.string(), z.array(z.string())),
    renderContext: z
      .object({
        kind: z.literal("plan_approval"),
        plan: z.string().min(1),
      })
      .strict()
      .optional(),
    expandedCustomAnswerQuestionIndexes: z.array(z.number().int().min(0)).optional(),
    handledAt: z.number().optional(),
  })
  .strict();

export const botConfigSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    provider: z.enum(botProviders),
    enabled: z.boolean(),
    credentialRef: z.string().min(1).optional(),
    webhookSecretRef: z.string().min(1).optional(),
    webhookUrl: z.string().url().optional(),
    webhookAuthHeaderName: z.string().min(1).optional(),
    feishuAppId: z.string().min(1).optional(),
    providerUserId: z.string().min(1).optional(),
    displayName: z.string().optional(),
    allowedWorkspaces: z.array(z.string().min(1)),
    allowedCommands: botAllowedCommandsSchema,
    currentOptions: botCurrentOptionsSchema,
    replyMode: z.enum([
      "assistant_changes",
      "assistant_toolcalls_changes",
      "summary_changes",
      "streaming_card",
    ]),
  })
  .strict();

export const botsConfigFileSchema = z
  .object({
    version: z.literal(3),
    bots: z.array(botConfigSchema),
  })
  .strict();

export const botsStateFileSchema = z
  .object({
    version: z.literal(3),
    bots: z.record(
      z.string(),
      z.object({
        botId: z.string().min(1),
        workspacePath: z.string().min(1),
        workspaceIdentity: z.string().min(1).optional(),
        workspaceId: z.string().min(1).optional(),
        mode: z.enum(["draft", "task"]),
        activeTaskId: z.string().min(1).nullable(),
        draftOptions: botDraftOptionsSchema.optional(),
        pendingPermissionOptions: z
          .array(
            z.object({
              requestId: z.string().min(1),
              optionId: z.string().min(1),
              command: z.enum(["approve", "deny"]),
              label: z.string().min(1),
              response: zcodePermissionResponseSchema,
              handledAt: z.number().optional(),
            }),
          )
          .optional(),
        pendingElicitation: botPendingElicitationSchema.optional(),
        telegramOffset: z.number().optional(),
        weixinGetUpdatesBuf: z.string().optional(),
        weixinActivatedAt: z.number().optional(),
        updatedAt: z.number(),
      }),
    ),
  })
  .strict();

export const DEFAULT_BOT_COMMANDS: BotAllowedCommands = {
  status: true,
  new: true,
  workspace: true,
  model: true,
  mode: true,
  thoughtLevel: true,
  reply: true,
};

export const DEFAULT_BOT_REPLY_GRANULARITY: BotReplyGranularity = "assistant_changes";

export function getSupportedBotReplyGranularities(
  provider: BotProvider,
): readonly BotReplyGranularity[] {
  return isFeishuBotProvider(provider)
    ? (["streaming_card"] as const)
    : BOT_REPLY_GRANULARITIES.filter(
        // Bugfix: streaming card 依赖 Feishu/Lark Card JSON 2.0，其他 channel 无法渲染或更新该消息形态。
        (granularity) => granularity !== "streaming_card",
      );
}

export function normalizeBotReplyGranularity(
  provider: BotProvider,
  replyMode: BotReplyGranularity | undefined,
): BotReplyGranularity {
  const supported = getSupportedBotReplyGranularities(provider);
  const candidate = replyMode ?? DEFAULT_BOT_REPLY_GRANULARITY;
  return supported.includes(candidate) ? candidate : supported[0]!;
}

export const BOT_ZCODE_PROVIDER_OPTIONS: Array<{
  id: ZCodeProvider;
  label: string;
}> = [{ id: ZCODE_AGENT_PROVIDER, label: ZCODE_AGENT_PROVIDER_LABEL }];
