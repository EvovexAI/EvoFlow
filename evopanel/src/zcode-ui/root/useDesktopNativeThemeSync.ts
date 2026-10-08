import { useEffect } from "react";
import type { IPlatformService } from "@zcode/shared";
import { logger } from "@/logger.js";
import { resolveTheme, type Theme } from "@/useTheme.js";

export function useDesktopNativeThemeSync({
  enabled,
  isDesktop,
  platform,
  theme,
}: {
  enabled: boolean;
  isDesktop?: boolean;
  platform: IPlatformService;
  theme: Theme;
}) {
  useEffect(() => {
    if (!enabled || !isDesktop) {
      return;
    }

    let disposed = false;
    const titleBarTheme = theme === "system" ? "system" : resolveTheme(theme);

    // 原生窗口主题会影响 macOS vibrancy；启动 loading 阶段先不写 nativeTheme，
    // 避免 RootStartupLoading 观察窗口壳时被应用主题提前覆盖，进入主界面后再同步。
    platform.setTitleBarTheme(titleBarTheme).catch((error) => {
      if (disposed) {
        return;
      }
      logger.error("[Root] 同步标题栏主题失败", { titleBarTheme, error });
    });

    return () => {
      disposed = true;
    };
  }, [enabled, isDesktop, platform, theme]);
}
