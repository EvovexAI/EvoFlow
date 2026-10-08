import { ZCODE_AGENT_PROVIDER, type PlanIdentitySnapshot, type ZCodeProvider } from "@zcode/shared";
import { buildPromptTelemetryExtraDetail } from "@/lib/messageTelemetry.js";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import {
  legacyTelemetryModelValue,
  legacyTelemetryProviderId,
} from "@/lib/providerTelemetryIdentity.js";

function resolveLegacyConversationModelValue(params: {
  configProvider?: string | null;
  modelName?: string | null;
}): string | null | undefined {
  const configProvider = params.configProvider?.trim();
  const modelName = params.modelName?.trim();
  if (!configProvider || !modelName || configProvider === ZCODE_AGENT_PROVIDER) {
    return params.modelName;
  }
  // 修复原因：V4 config 把 provider/model 拆开保存，直接上报 model 会丢失旧 UI
  // `custom:<provider>:<model>` 维度，导致同一模型在新旧版本落入两组数仓桶。
  return encodeCustomModelValue(legacyTelemetryProviderId(configProvider), modelName);
}

export function resolveLegacyRuntimeModelValue(params: {
  configProvider?: string | null;
  modelName?: string | null;
}): string | null | undefined {
  const configProvider = params.configProvider?.trim();
  const modelName = params.modelName?.trim();
  if (!configProvider || !modelName || configProvider === ZCODE_AGENT_PROVIDER) {
    return params.modelName;
  }
  if (modelName.startsWith(`${configProvider}/`)) return legacyTelemetryModelValue(modelName);
  return `${legacyTelemetryProviderId(configProvider)}/${modelName}`;
}

/** V4 config.provider 是实际模型 provider id；agentProvider 表示 ZCode 运行时。 */
export function buildV4ConversationPromptTelemetryExtraDetail(params: {
  agentProvider?: ZCodeProvider;
  configProvider?: string | null;
  modelName?: string | null;
  askMode?: string | null;
  providerBaseURL?: string | null;
  planIdentitySnapshot?: PlanIdentitySnapshot | null;
}): Record<string, string> {
  const agentProvider = params.agentProvider ?? ZCODE_AGENT_PROVIDER;
  const base = buildPromptTelemetryExtraDetail({
    askMode: params.askMode,
    modelName: resolveLegacyConversationModelValue(params),
    provider: agentProvider,
    providerBaseURL: params.providerBaseURL,
    planIdentitySnapshot: params.planIdentitySnapshot,
  });
  return {
    ...base,
    message_source: "chat",
    task_trigger: "",
    model_provider: legacyTelemetryProviderId(
      params.configProvider?.trim() || base.model_provider || "",
    ),
    // agent 表示 ZCode 运行时，不能用模型 provider id 替代。
    agent: agentProvider,
  };
}
