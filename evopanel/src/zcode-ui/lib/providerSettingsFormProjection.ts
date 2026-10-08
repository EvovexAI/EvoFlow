import type { ProviderSettingsView } from "@zcode/services";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import type { ProviderOrderView } from "@/lib/modelProviderOrdering.js";

/** 把正式 Settings View 复制成当前编辑会话使用的可变表单状态。 */
export function projectProviderSettingsViewToFormProviders(
  view: ProviderSettingsView,
): ProviderSettingsFormProvider[] {
  return projectProviderSettingsProviders(view.providers);
}

function projectProviderSettingsProviders(
  providers: ProviderSettingsView["providers"],
): ProviderSettingsFormProvider[] {
  return providers.map((provider) => ({
    providerId: provider.providerId,
    providerName: provider.providerName,
    templateId: provider.templateId,
    executable: provider.executable,
    enabled: provider.enabled,
    accountState: provider.accountState,
    hasPersonalConfig: provider.personalConfig !== undefined,
    issues: provider.issues,
    personalConfig: structuredClone(provider.personalConfig ?? {}),
    config: structuredClone(provider.effectiveConfig),
    models: provider.models.map((model) => ({
      kind: model.kind,
      modelId: model.modelId,
      builtin: model.builtin,
      inheritedConfig: structuredClone(model.effectiveBuiltinConfig),
      personalConfig: structuredClone(model.personalExactConfig ?? {}),
      useRecommendedConfig: model.useRecommendedConfig,
      config: structuredClone(model.effectiveConfig),
      hasPersonalConfig: model.personalExactConfig !== undefined,
      executable: model.executable,
      selectable: model.selectable,
      issues: model.issues,
    })),
  }));
}

export function resolveProviderSettingsFormProviders(params: {
  view: ProviderSettingsView | null;
}): ProviderSettingsFormProvider[] {
  return params.view ? projectProviderSettingsViewToFormProviders(params.view) : [];
}

function resolvePersonalProviderIds(view: ProviderSettingsView): string[] {
  return view.providers
    .filter((provider) => provider.effectiveConfig.group === "standard-personal")
    .map((provider) => provider.providerId);
}

export function resolveProviderOrdering(params: {
  view?: ProviderSettingsView | null;
  providers: readonly ProviderSettingsFormProvider[];
}): {
  displayOrder: ProviderOrderView;
  reorderableProviderIds?: ReadonlySet<string>;
} {
  if (!params.view) {
    return {
      displayOrder: { providerIds: [] },
      reorderableProviderIds: new Set(),
    };
  }
  return {
    displayOrder: {
      providerIds: params.providers.map((provider) => provider.providerId),
    },
    reorderableProviderIds: new Set(resolvePersonalProviderIds(params.view)),
  };
}
