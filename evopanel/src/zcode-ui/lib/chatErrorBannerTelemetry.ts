import {
  resolveTelemetryModelId,
  resolveTelemetryProviderScope,
  type ArmsCustomEventPayload,
  type IPlatformService,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  getProviderBusinessErrorUiAction,
  isProviderBusinessErrorCode,
  type ProviderBusinessErrorUiAction,
} from "@/lib/providerBusinessError.js";
import { resolveTelemetryAttribution } from "@/lib/chatErrorAttribution.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";

const CHAT_ERROR_BANNER_ARMS_EVENT_NAME = "chat_error_banner";
const CHAT_ERROR_BANNER_ARMS_GROUP = "ui_error";
export type ChatErrorBannerSurface = "chat_input_error_banner" | "session_subscription_error";

const CHAT_ERROR_BANNER_MESSAGE_LIMIT = 500;

function sanitizeUnderlyingTelemetryText(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  // 底层 message 可能包含认证头或原始响应，不能因新增诊断字段绕过遥测隐私边界。
  // 只影响上报副本；错误展示、分类及本地详情仍使用原值。
  if (
    /authorization|\b(?:bearer|basic)\s+\S+|(?:https?|wss?|file):\/\/|(?:api[_-]?key|token|password|secret)\s*["']?\s*[:=]|<(?:html|body|script|form|!doctype)\b/i.test(
      value,
    )
  ) {
    return "sensitive error redacted";
  }
  return truncateTelemetryText(value);
}

// provider/model 白名单与归一实现已收敛到 @zcode/shared 的 telemetryRedaction：
// plan_usage、ui_perf 等事件复用同一条白名单，避免多份副本各自漂移。

interface ChatProviderBusinessRecoveryAction {
  kind: ProviderBusinessErrorUiAction;
  providerBusinessCode: string;
}

export function resolveVisibleChatErrorTelemetryRecoveryAction(
  error: Pick<ZCodeUiError, "code" | "message">,
): ChatProviderBusinessRecoveryAction | null {
  // 修复原因：旧 UI 会把普通 provider 业务错误的可见恢复动作作为聚合维度上报；
  // 无可见动作的业务码（如 3007/3001）在这里自然返回 null，不再上报动作维度。
  if (!isProviderBusinessErrorCode(error.code)) {
    return null;
  }
  const kind = getProviderBusinessErrorUiAction(error.code);
  return kind ? { kind, providerBusinessCode: error.code } : null;
}

function truncateTelemetryText(value: string | undefined): string {
  if (!value) {
    return "";
  }
  return value.length > CHAT_ERROR_BANNER_MESSAGE_LIMIT
    ? value.slice(0, CHAT_ERROR_BANNER_MESSAGE_LIMIT)
    : value;
}

function normalizeTelemetryKeyPart(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed.replace(/[:\s]+/g, "_").slice(0, 128);
}

function hashTelemetryFingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function resolveErrorKey(params: {
  errorKey?: string | null;
  error: ZCodeUiError;
  displayMessage: string;
  providerBusinessRecoveryAction: ChatProviderBusinessRecoveryAction | null;
}): string {
  const providerBusinessRecoveryAction = params.providerBusinessRecoveryAction;
  const fingerprint = [
    params.errorKey?.trim() ?? "",
    params.error.taskId ?? "",
    params.error.code ?? "",
    params.error.traceId ?? "",
    params.error.message,
    params.displayMessage,
    providerBusinessRecoveryAction?.kind ?? "",
    providerBusinessRecoveryAction?.providerBusinessCode ?? "",
  ].join("\u001f");

  // 修复原因：UI 本地去重 key 包含完整 error.message，不能绕过 500 字符截断进入埋点。
  // telemetry 只保留结构化维度和短 hash，既能去重聚合，也避免扩大上报正文范围。
  return [
    normalizeTelemetryKeyPart(params.error.taskId, "no-task"),
    normalizeTelemetryKeyPart(params.error.code, "UNKNOWN"),
    normalizeTelemetryKeyPart(params.error.traceId, "no-trace"),
    normalizeTelemetryKeyPart(providerBusinessRecoveryAction?.kind, "no-action"),
    normalizeTelemetryKeyPart(
      providerBusinessRecoveryAction?.providerBusinessCode,
      "no-provider-code",
    ),
    hashTelemetryFingerprint(fingerprint),
  ].join(":");
}

function buildChatErrorBannerTelemetryPayload(params: {
  surface?: ChatErrorBannerSurface;
  errorKey?: string | null;
  displayMessage: string;
  error: ZCodeUiError;
  providerBusinessRecoveryAction: ChatProviderBusinessRecoveryAction | null;
}): ArmsCustomEventPayload {
  const errorMsg = truncateTelemetryText(params.displayMessage);
  const underlyingErrorMessage = sanitizeUnderlyingTelemetryText(
    params.error.underlyingErrorMessage,
  );
  const taskId = params.error.taskId ?? "";
  const providerBusinessRecoveryAction = params.providerBusinessRecoveryAction;
  const attribution = params.error.attribution;
  const provider = resolveTelemetryProviderScope(attribution?.providerId);
  const { errorSource, failureReason } = resolveTelemetryAttribution({
    displayMessage: params.displayMessage,
    error: params.error,
  });

  return {
    name: CHAT_ERROR_BANNER_ARMS_EVENT_NAME,
    group: CHAT_ERROR_BANNER_ARMS_GROUP,
    value: 1,
    properties: {
      surface: params.surface ?? "chat_input_error_banner",
      error_key: resolveErrorKey({
        errorKey: params.errorKey,
        error: params.error,
        displayMessage: params.displayMessage,
        providerBusinessRecoveryAction,
      }),
      error_code: params.error.code ?? "",
      error_message: errorMsg,
      ...(underlyingErrorMessage ? { error_detail_message: underlyingErrorMessage } : {}),
      // 现行遥测契约禁止上传完整 detail；仅在本地协议中保留，不能照搬上游 error_detail_text。
      trace_id: params.error.traceId ?? "",
      task_id: taskId,
      has_detail: Boolean(params.error.detail),
      provider_business_action: providerBusinessRecoveryAction?.kind ?? "",
      provider_business_code: providerBusinessRecoveryAction?.providerBusinessCode ?? "",
      error_source: errorSource,
      failure_reason: failureReason,
      failure_phase: attribution?.errorPhase ?? "",
      failure_exception_kind: attribution?.exceptionKind ?? "",
      provider_scope: provider.providerScope,
      provider_id: provider.providerId,
      model_id: resolveTelemetryModelId(provider.providerScope, attribution?.modelId),
      provider_kind: attribution?.providerKind ?? "",
      transport: attribution?.transport ?? "",
      status_code: attribution?.statusCode ?? "",
      provider_error_code: attribution?.providerErrorCode ?? "",
      failure_retryable: attribution?.retryable ?? "",
    },
  };
}

export async function reportChatErrorBannerTelemetry(
  platform: Pick<IPlatformService, "reportArmsCustomEvent">,
  params: {
    surface?: ChatErrorBannerSurface;
    errorKey?: string | null;
    displayMessage: string;
    error: ZCodeUiError;
    providerBusinessRecoveryAction: ChatProviderBusinessRecoveryAction | null;
  },
): Promise<void> {
  try {
    // 修复原因：错误横幅属于异常可观测，不能走数仓业务 telemetry；
    // 这里改走 ARMS custom，与 React ErrorBoundary 保持同一监控出口。
    await platform.reportArmsCustomEvent(buildChatErrorBannerTelemetryPayload(params));
  } catch (error) {
    logger.warn("[ChatViewErrorBanner] ARMS 上报失败:", error);
  }
}
