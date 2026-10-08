import {
  BUILTIN_PROVIDER_TEMPLATE_IDS,
  type AppSettings,
  type Locale,
  type ProviderFamilyDomain,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";

export type ApiKeyProviderChoice = "zai" | "bigmodel";

export function resolveLoginApiKeyDefaultProvider(locale: Locale): ApiKeyProviderChoice {
  return locale === "zh-CN" ? "bigmodel" : "zai";
}

export function resolveLoginApiKeyTemplateId(
  choice: ApiKeyProviderChoice,
): "zai-api" | "bigmodel-api" {
  return choice === "zai"
    ? BUILTIN_PROVIDER_TEMPLATE_IDS.zai
    : BUILTIN_PROVIDER_TEMPLATE_IDS.bigmodel;
}

export function resolveLoginApiKeyProviderLabel(choice: ApiKeyProviderChoice): string {
  // Welcome Screen API Key 错误提示需要使用 BigModel 品牌固定写法。
  return choice === "zai" ? "Z.ai" : "BigModel";
}

function resolveLoginApiKeyProviderFamilyDomain(
  choice: ApiKeyProviderChoice,
): ProviderFamilyDomain {
  return choice;
}

export function buildLoginApiKeySkipSettings(
  choice: ApiKeyProviderChoice,
  now: number,
): Pick<
  AppSettings,
  "providerFamilyDomain" | "providerFamilyDomainUpdatedAt" | "providerFamilyDomainMigrated"
> {
  return {
    providerFamilyDomain: resolveLoginApiKeyProviderFamilyDomain(choice),
    providerFamilyDomainUpdatedAt: now,
    providerFamilyDomainMigrated: true,
  };
}

export function shouldShowLoginApiKeyLink(
  apiKeyValue: string,
  apiKeyUrl: string | undefined,
): boolean {
  return Boolean(apiKeyUrl) && apiKeyValue.trim().length === 0;
}

export function buildLoginApiKeyDefaultModelPreferenceFromSelection(
  view: ModelSelectionView,
  providerId: string,
): string | null {
  const firstModel = view.providers.find((provider) => provider.providerId === providerId)
    ?.models[0]?.modelId;
  return firstModel ? encodeCustomModelValue(providerId, firstModel) : null;
}
