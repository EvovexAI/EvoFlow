import { useEffect } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { connectProviderSettingsSnapshot } from "@/lib/providerSettingsSnapshot.js";
import { logger } from "@/logger.js";

export function useRootProviderSettingsSnapshot(services: IServiceAccessor): void {
  useEffect(() => {
    const service = services.providerSettingsService;
    if (!service) return;

    const connection = connectProviderSettingsSnapshot(service);
    void connection.ready.catch((error) => {
      logger.warn("[Root] 加载 Provider Settings View 失败", {
        error,
      });
    });
    return () => connection.dispose();
  }, [services.providerSettingsService]);
}
