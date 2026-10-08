import type { ModelSelectionView } from "@zcode/services";

export function resolveProviderLabel(
  providerId: string | undefined,
  registryView: ModelSelectionView | null,
): string {
  const normalizedId = providerId?.trim() ?? "";
  if (!normalizedId) return "";
  const registryProvider = registryView?.providers.find(
    (provider) => provider.providerId === normalizedId,
  );
  if (registryProvider) {
    return registryProvider.providerName?.trim() || normalizedId;
  }
  return normalizedId;
}

export function resolveProviderBaseURL(
  providerId: string | undefined,
  registryView: ModelSelectionView | null,
): string | undefined {
  const normalizedId = providerId?.trim() ?? "";
  if (!normalizedId) return undefined;
  const registryProvider = registryView?.providers.find(
    (provider) => provider.providerId === normalizedId,
  );
  if (registryProvider) {
    return registryProvider.config.api?.baseUrl?.trim() || undefined;
  }
  return undefined;
}
