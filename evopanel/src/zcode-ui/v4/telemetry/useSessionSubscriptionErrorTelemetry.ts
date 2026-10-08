import { useEffect, useRef } from "react";
import type { ConversationTelemetrySupervisor } from "@/v4/telemetry/conversationTelemetrySupervisor.js";

const SESSION_SUBSCRIPTION_ERROR_SURFACE = "session_subscription_error";
const FALLBACK_SUBSCRIPTION_ERROR_CODE = "fault.subscribe.unknown";
const STANDALONE_REASON_CODE_PATTERN = /^fault\.[A-Za-z0-9._-]+$/;
const SUFFIX_REASON_CODE_PATTERN = /\((fault\.[A-Za-z0-9._-]+)\)\s*$/;

type SubscriptionErrorReporter = Pick<ConversationTelemetrySupervisor, "reportVisibleChatError">;

function resolveSessionSubscriptionErrorCode(message: string): string {
  const trimmedMessage = message.trim();
  // Bug 原因：recovery fail-closed 会把纯 reasonCode 直接写入 lastError，旧逻辑只识别
  // “正文 (reasonCode)” 形式，导致结构化错误被错误聚合为 fault.subscribe.unknown。
  return (
    STANDALONE_REASON_CODE_PATTERN.exec(trimmedMessage)?.[0] ??
    SUFFIX_REASON_CODE_PATTERN.exec(trimmedMessage)?.[1] ??
    FALLBACK_SUBSCRIPTION_ERROR_CODE
  );
}

export function useSessionSubscriptionErrorTelemetry(params: {
  supervisor: SubscriptionErrorReporter | null;
  sessionId: string | null;
  lastError: string | null;
  visible: boolean;
}): void {
  const reportedKeysRef = useRef(new Set<string>());

  useEffect(() => {
    if (!params.visible || !params.supervisor || !params.sessionId || !params.lastError) {
      return;
    }
    const errorCode = resolveSessionSubscriptionErrorCode(params.lastError);
    const errorKey = `${params.sessionId}:${errorCode}:${params.lastError}`;
    if (reportedKeysRef.current.has(errorKey)) return;
    reportedKeysRef.current.add(errorKey);

    // Bug 原因：订阅失败被 store 收敛成可见 error state 后不会再抛到 ErrorBoundary，
    // 也绕过 Composer 的错误横幅埋点；这里复用 chat_error_banner 补齐真实可见曝光。
    params.supervisor.reportVisibleChatError({
      surface: SESSION_SUBSCRIPTION_ERROR_SURFACE,
      errorKey,
      displayMessage: params.lastError,
      error: {
        code: errorCode,
        message: params.lastError,
        taskId: params.sessionId,
      },
    });
  }, [params.lastError, params.sessionId, params.supervisor, params.visible]);
}
