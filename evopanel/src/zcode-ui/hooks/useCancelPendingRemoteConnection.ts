import { useCallback } from "react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";

export function useCancelPendingRemoteConnection() {
  const platform = usePlatform();

  return useCallback(
    async (requestId?: string) => {
      try {
        await (platform.cancelPendingRemoteConnection?.(requestId) ?? Promise.resolve());
      } catch (sessionError) {
        logger.warn("[SSHDialog] 取消进行中的远程连接失败:", sessionError);
      }
    },
    [platform],
  );
}
