import { useCallback } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { logger } from "@/logger.js";

type RootProviderStateServices = Pick<IServiceAccessor, "providerSettingsService">;

async function refreshRootProviderState(services: RootProviderStateServices): Promise<void> {
  try {
    // Provider Runtime 统一刷新 Config、Account Source 与 Registry；Root 不再维护旧快照。
    await services.providerSettingsService.refresh("root-provider-state-refresh");
  } catch (error) {
    logger.error("[Root] 刷新 Provider Runtime 失败:", error);
  }
}

export function useRootProviderStateRefresh(services: IServiceAccessor) {
  return useCallback(() => refreshRootProviderState(services), [services.providerSettingsService]);
}
