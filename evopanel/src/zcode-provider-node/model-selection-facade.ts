import { ModelSelectionFacade, type ProviderRegistryFacadeSource } from "@zcode/provider";
import {
  isBuiltinModelProviderId,
  isStartPlanModelProviderId,
  OFF_PEAK_PROVIDER_IDS,
} from "@zcode/shared";
import { resolveLegacyReasoningLevel } from "./legacy-reasoning-level.js";

/** Host 与受管理 Worker 共用身份分类；解析仍由纯 Provider Facade 负责。 */
export function createNodeModelSelectionFacade(
  source: ProviderRegistryFacadeSource,
): ModelSelectionFacade {
  return new ModelSelectionFacade(
    source,
    (providerId) => {
      // Start 按真实 ID 解析；不能参与付费连接唯一性判断或被映射到付费额度。
      if (isStartPlanModelProviderId(providerId)) return "ordinary";
      if (isBuiltinModelProviderId(providerId)) return "account-plan";
      if (Object.values(OFF_PEAK_PROVIDER_IDS).some((id) => id === providerId))
        return "account-offpeak";
      return "ordinary";
    },
    resolveLegacyReasoningLevel,
  );
}
