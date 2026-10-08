import {
  projectModelSelectionProviderView,
  type ModelSelectionView,
  type ProviderRegistryView,
} from "@zcode/provider";
import { OFF_PEAK_PROVIDER_IDS } from "@zcode/shared";

/** Off-Peak 只投影固定隐藏 Provider，不向普通用户选择面开放隐藏候选。 */
export function buildOffPeakModelSelectionView(registry: ProviderRegistryView): ModelSelectionView {
  const providerIds = new Set<string>(Object.values(OFF_PEAK_PROVIDER_IDS));
  const providers = registry.providers.filter(
    (candidate) =>
      providerIds.has(candidate.providerId) && candidate.config.visibility === "hidden",
  );
  return Object.freeze({
    revision: registry.revision,
    providers: Object.freeze(providers.map(projectModelSelectionProviderView)),
  });
}
