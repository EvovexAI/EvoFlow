import { DesktopCommandIds, type UpdateStatePayload } from "@zcode/shared";
import { useEffect, useState } from "react";
import { usePlatform } from "@/hooks/usePlatform.js";
import {
  getUpdateMenuLabelId,
  getUpdateMenuLabelValues,
  shouldShowDesktopUpdateEntry,
} from "@/lib/desktopUpdateMenu.js";
import { logger } from "@/logger.js";

export function useDesktopUpdateMenu(isDesktop: boolean) {
  const platform = usePlatform();
  const visible = isDesktop && shouldShowDesktopUpdateEntry();
  const [state, setState] = useState<UpdateStatePayload | null>(null);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    let eventReceived = false;
    // main 持有更新状态；先订阅，避免较慢的初始快照覆盖已经收到的新状态。
    const dispose = platform.onUpdateStateChanged?.((payload) => {
      eventReceived = true;
      if (active) setState(payload);
    });
    void platform.getUpdateState?.().then(
      (payload) => {
        if (active && !eventReceived) setState(payload);
      },
      (error) => logger.warn("[HelpMenu] 同步自动更新状态失败", { error }),
    );
    return () => {
      active = false;
      dispose?.();
    };
  }, [platform, visible]);

  return {
    visible,
    disabled: state?.enabled === false,
    labelId: getUpdateMenuLabelId(state),
    labelValues: getUpdateMenuLabelValues(state),
    checkForUpdates: () => {
      void platform.executeDesktopCommand(DesktopCommandIds.CheckForUpdates);
    },
  };
}
