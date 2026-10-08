import type { ModelSelectionView } from "@zcode/services";

interface ProviderAvailabilityState {
  readonly source: "registry";
  readonly hydrated: boolean;
  readonly providerCount: number;
  readonly hasUsableProvider: boolean;
}

export function resolveProviderAvailabilityState(params: {
  modelSelectionView: ModelSelectionView | null;
}): ProviderAvailabilityState {
  const providers = params.modelSelectionView?.providers ?? [];
  return {
    source: "registry",
    hydrated: params.modelSelectionView !== null,
    providerCount: providers.length,
    hasUsableProvider:
      params.modelSelectionView !== null &&
      providers.some((provider) => provider.models.length > 0),
  };
}
