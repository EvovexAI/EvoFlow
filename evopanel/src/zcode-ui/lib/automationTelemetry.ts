import {
  decodeCustomModelValue,
  isAutomationCreateLimitError,
  sanitizeTelemetryErrorMessage,
  type IPlatformService,
  type ModelSelection,
  type ZCodeAutomation,
} from "@zcode/shared";
import type { ProviderSettingsView } from "@zcode/services";
import { isApiKeyAccess } from "@zcode/provider";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { legacyTelemetryProviderId } from "@/lib/providerTelemetryIdentity.js";

const EVENT_REGION = "app.automations";
type TelemetryPlatform = Pick<IPlatformService, "reportTelemetryEvent">;

function resolveAutomationModelTelemetry(
  modelValue: string | null | undefined,
  explicitProvider: string | null | undefined,
  providerSettingsView: ProviderSettingsView | null,
): Record<"model_name" | "model_provider" | "provider_name", string> {
  const model = modelValue?.trim() ?? "";
  const custom = decodeCustomModelValue(model);
  const slash = model.indexOf("/");
  const providerId =
    explicitProvider?.trim() ||
    custom?.providerId?.trim() ||
    (slash > 0 ? model.slice(0, slash).trim() : "");
  const modelName =
    custom?.modelName?.trim() || (slash > 0 ? model.slice(slash + 1).trim() : model);
  const provider = providerSettingsView?.providers.find(
    (candidate) => candidate.providerId === providerId,
  );
  let providerName = "";
  const baseURL = provider?.effectiveConfig.api?.baseUrl?.trim();
  if (
    provider &&
    provider.effectiveConfig.group === "standard-personal" &&
    !provider.templateId &&
    isApiKeyAccess(provider.effectiveConfig.access) &&
    baseURL
  ) {
    try {
      providerName = new URL(baseURL).hostname;
    } catch {
      providerName = "";
    }
  }
  return {
    model_name: modelName,
    model_provider: legacyTelemetryProviderId(providerId),
    provider_name: providerName,
  };
}

export function resolveAutomationSelectionTelemetry(
  selection: ModelSelection | null | undefined,
  providerSettingsView: ProviderSettingsView | null,
): Record<"model_name" | "model_provider" | "provider_name", string> {
  return resolveAutomationModelTelemetry(
    selection ? `${selection.providerId}/${selection.modelId}` : undefined,
    selection?.providerId,
    providerSettingsView,
  );
}

function sanitizeAutomationTelemetryError(error: string | null | undefined): string {
  // 修复原因：旧正则只遮住 Authorization 后的 Bearer，秘密值仍会泄露；统一丢弃原文。
  return sanitizeTelemetryErrorMessage(error);
}

function classifyAutomationTelemetryError(
  error: string | null | undefined,
): "limit" | "timeout" | "network" | "auth" | "validation" | "unknown" {
  // 修复原因：删除错误原文后，恒空的 error_code 让创建失败无法归因。
  // 只输出固定类别；错误已被 store 转成字符串，未知模式不猜测、更不回传原文。
  const message = error ?? "";
  if (isAutomationCreateLimitError(message)) return "limit";
  if (/\b(?:ETIMEDOUT|ESOCKETTIMEDOUT|TimeoutError|timed? out|timeout)\b/i.test(message)) {
    return "timeout";
  }
  if (
    /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ENETUNREACH|fetch failed|network error)\b/i.test(
      message,
    )
  ) {
    return "network";
  }
  if (/\b(?:unauthorized|unauthenticated|forbidden|authentication failed)\b/i.test(message)) {
    return "auth";
  }
  if (
    /\b(?:ZodError|invalid automation mode|validation failed|invalid cron)\b|Automation 模型选择不可用/i.test(
      message,
    )
  ) {
    return "validation";
  }
  return "unknown";
}

export function reportAutomationCreateResult(
  platform: TelemetryPlatform,
  params: {
    automationId?: string;
    cronExpr: string;
    templateId?: string;
    error?: string | null;
    modelFields: Record<"model_name" | "model_provider" | "provider_name", string>;
  },
): Promise<void> {
  return reportAppTelemetryEvent(
    platform,
    {
      elementName: "automation_create_result",
      eventRegion: EVENT_REGION,
      eventType: "result",
      eventExtraDetail: {
        status: params.automationId ? "success" : "fail",
        automation_id: params.automationId ?? "",
        create_source: "manual",
        cron_expr: params.cronExpr,
        template_id: params.templateId ?? "",
        error_code: params.automationId ? "" : classifyAutomationTelemetryError(params.error),
        error_msg: params.automationId ? "" : sanitizeAutomationTelemetryError(params.error),
        ...params.modelFields,
      },
    },
    "automation-telemetry",
  );
}

export function reportAutomationActionClick(
  platform: TelemetryPlatform,
  params: {
    action: "run_now" | "delete";
    source: "list" | "editor";
    automation: ZCodeAutomation;
    providerSettingsView: ProviderSettingsView | null;
  },
): Promise<void> {
  return reportAppTelemetryEvent(
    platform,
    {
      elementName: params.action === "run_now" ? "automation_run_now_ck" : "automation_delete_ck",
      eventRegion: EVENT_REGION,
      eventType: "ck",
      eventExtraDetail: {
        automation_id: params.automation.automationId,
        action_source: params.source,
        ...(params.action === "run_now"
          ? resolveAutomationSelectionTelemetry(
              params.automation.modelSelection,
              params.providerSettingsView,
            )
          : {}),
      },
    },
    "automation-telemetry",
  );
}
