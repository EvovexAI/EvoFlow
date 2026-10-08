export type ConversationMessageProjectionPolicy =
  | "realUserInput"
  | "visibleAssistant"
  | "providerContextOnly"
  | "timelineOnly"
  | "hiddenSynthetic";

export interface ConversationProjectionMessage {
  info: {
    metadata?: unknown;
    role?: string;
    semantics?: ConversationProjectionMessageSemantics;
    source?: string;
    summary?: unknown;
    synthetic?: boolean;
    visibility?: string;
  };
  parts?: readonly ConversationProjectionPart[];
}

export interface ConversationProjectionMessageSemantics {
  kind?: string;
  origin?: string;
  providerVisibility?: string;
  source?: string;
  transcriptVisibility?: string;
  uiVisibility?: string;
}

export interface ConversationProjectionPart {
  ignored?: boolean;
  metadata?: unknown;
  summaryMessageId?: string;
  synthetic?: boolean;
  text?: string;
  timelineType?: string;
  type?: string;
}

const MODEL_ONLY_VISIBILITY = "model-only";
const FORK_SOURCE = "fork";
const GOAL_CONTINUATION_REMINDER_PREFIX = '<system-reminder source="goal-continuation">';
const GOAL_CONTINUATION_TEXT_MARKER = "Continue working toward the active session goal.";
const GOAL_STATE_TEXT_MARKER = "Current session goal state";
const TASK_NOTIFICATION_PREFIX = "<task-notification>";
const SUBAGENT_NOTIFICATION_PREFIX = "<subagent-notification>";
const REWIND_NOTICE_MARKERS = ["Conversation rewind applied.", "Workspace rewind applied."];

const PROVIDER_CONTEXT_SYNTHETIC_SOURCES = new Set([
  "agent_control_message",
  "background_task",
  "goal-continuation",
  "goal_completion_verification",
  "goal_state_change",
  "plugin_reference",
  "queued_system_notification",
  "resume_goal_state",
  "resume_referenced_session_context",
  "rewind",
  "selection_side_chat",
  "subagent",
  "subagent_message",
  "target_continuation",
  "task_notification",
  "task_status",
  "todo_reminder",
]);

const MODEL_ONLY_TURN_TRIGGER_SOURCES = new Set([
  "background_task",
  "task_notification",
  "subagent",
  "subagent_message",
  "goal-continuation",
  "target_continuation",
]);

export function getConversationMessageProjectionPolicy(
  message: ConversationProjectionMessage,
): ConversationMessageProjectionPolicy {
  const info = message.info;
  const parts = message.parts ?? [];
  const semantics = info.semantics;

  if (semantics?.kind === "compact_summary" || info.summary !== undefined) {
    return "providerContextOnly";
  }

  if (semantics) {
    if (semantics.kind === "timeline_event") {
      return "timelineOnly";
    }
    if (
      semantics.origin === "real_user" &&
      info.synthetic !== true &&
      info.visibility !== MODEL_ONLY_VISIBILITY
    ) {
      return "realUserInput";
    }
    if (
      info.role === "assistant" &&
      semantics.kind === "assistant_response" &&
      semantics.uiVisibility === "visible" &&
      semantics.transcriptVisibility === "visible"
    ) {
      // 正常 assistant 同时会进入 provider context 和可见 transcript；
      // providerVisibility 不能抢先把它归成 model-only，否则晚订阅的 cold hydration 会丢正文。
      return "visibleAssistant";
    }
    if (semantics.providerVisibility === "visible") {
      return "providerContextOnly";
    }
    if (semantics.kind === "fork_notice") {
      return "timelineOnly";
    }
    if (
      semantics.origin === "agent_runtime" ||
      semantics.uiVisibility === "hidden" ||
      semantics.transcriptVisibility === "hidden"
    ) {
      return "hiddenSynthetic";
    }
  }

  if (info.visibility === MODEL_ONLY_VISIBILITY || hasModelOnlyPart(parts)) {
    return "providerContextOnly";
  }

  if (isTimelineOnlyMessage(info, parts)) {
    return "timelineOnly";
  }

  const source = messageSource(info, parts);
  if (source === FORK_SOURCE) {
    return "timelineOnly";
  }
  if (source && PROVIDER_CONTEXT_SYNTHETIC_SOURCES.has(source)) {
    return "providerContextOnly";
  }

  if (hasLegacySystemReminderContextText(parts)) {
    return "providerContextOnly";
  }

  if (
    (info.synthetic === true || parts.some((part) => part.synthetic === true)) &&
    hasLegacyNotificationContextText(parts)
  ) {
    return "providerContextOnly";
  }

  if (info.synthetic === true || parts.some((part) => part.synthetic === true)) {
    return "hiddenSynthetic";
  }

  return info.role === "assistant" ? "visibleAssistant" : "realUserInput";
}

export function isConversationRealUserTurnStarter(message: ConversationProjectionMessage): boolean {
  return (
    message.info.role === "user" &&
    getConversationMessageProjectionPolicy(message) === "realUserInput"
  );
}

/**
 * provider-context user carrier 中会真正启动独立 model-only turn 的统一 source policy。
 * live/cold 都必须消费这一个判据，否则冷恢复会跳过 carrier messageId 并生成临时 turn identity。
 */
export function getConversationModelOnlyTurnTriggerSource(
  message: ConversationProjectionMessage,
): string | null {
  if (message.info.role !== "user") return null;
  if (getConversationMessageProjectionPolicy(message) !== "providerContextOnly") {
    return null;
  }
  const source = messageSource(message.info, message.parts ?? []);
  if (source && MODEL_ONLY_TURN_TRIGGER_SOURCES.has(source)) return source;
  // legacy 数据无 source 标记：通知文本前缀仍按既有 background wake 语义恢复。
  if (hasLegacyNotificationContextText(message.parts ?? [])) return "background_task";
  return null;
}

export function isConversationProviderContextOnlyMessage(
  message: ConversationProjectionMessage,
): boolean {
  return getConversationMessageProjectionPolicy(message) === "providerContextOnly";
}

export function isConversationTimelineOnlyMessage(message: ConversationProjectionMessage): boolean {
  return getConversationMessageProjectionPolicy(message) === "timelineOnly";
}

export function isConversationHiddenSyntheticMessage(
  message: ConversationProjectionMessage,
): boolean {
  return getConversationMessageProjectionPolicy(message) === "hiddenSynthetic";
}

function isTimelineOnlyMessage(
  info: ConversationProjectionMessage["info"],
  parts: readonly ConversationProjectionPart[],
): boolean {
  if (info.semantics?.kind === "timeline_event") {
    return true;
  }
  const infoMetadata = metadataRecord(info.metadata);
  if (info.source === FORK_SOURCE || stringValue(infoMetadata?.source) === FORK_SOURCE) {
    return true;
  }
  return parts.some((part) => {
    const metadata = metadataRecord(part.metadata);
    return (
      part.type === "timeline" ||
      hasSessionForkContext(metadata) ||
      (part.type === "compaction" &&
        (typeof metadata?.timelineStatus === "string" || typeof part.summaryMessageId === "string"))
    );
  });
}

function hasModelOnlyPart(parts: readonly ConversationProjectionPart[]): boolean {
  return parts.some((part) => {
    const metadata = metadataRecord(part.metadata);
    return (
      metadata?.visibility === MODEL_ONLY_VISIBILITY ||
      stringValue(metadata?.source) === "goal-continuation"
    );
  });
}

function messageSource(
  info: ConversationProjectionMessage["info"],
  parts: readonly ConversationProjectionPart[],
): string | undefined {
  const infoMetadata = metadataRecord(info.metadata);
  return (
    info.source ??
    stringValue(infoMetadata?.source) ??
    info.semantics?.source ??
    parts
      .map((part) => stringValue(metadataRecord(part.metadata)?.source))
      .find((source): source is string => Boolean(source))
  );
}

function hasLegacySystemReminderContextText(parts: readonly ConversationProjectionPart[]): boolean {
  const text = textFromParts(parts).trimStart();
  return (
    text.startsWith(GOAL_CONTINUATION_REMINDER_PREFIX) ||
    (text.startsWith("<system-reminder>") &&
      (text.includes(GOAL_CONTINUATION_TEXT_MARKER) || text.includes(GOAL_STATE_TEXT_MARKER))) ||
    REWIND_NOTICE_MARKERS.some((marker) => text.includes(marker))
  );
}

function hasLegacyNotificationContextText(parts: readonly ConversationProjectionPart[]): boolean {
  const text = textFromParts(parts).trimStart();
  return text.startsWith(TASK_NOTIFICATION_PREFIX) || text.startsWith(SUBAGENT_NOTIFICATION_PREFIX);
}

function textFromParts(parts: readonly ConversationProjectionPart[]): string {
  return parts
    .filter((part) => part.type === "text" && part.ignored !== true)
    .map((part) => part.text ?? "")
    .join("");
}

function hasSessionForkContext(metadata: unknown): boolean {
  const forkContext = metadataRecord(metadata)?.forkContext;
  return (
    typeof forkContext === "object" &&
    forkContext !== null &&
    !Array.isArray(forkContext) &&
    (forkContext as Record<string, unknown>).kind === "session_fork"
  );
}

function metadataRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
