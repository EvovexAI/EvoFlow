import { OnboardingMeshBackground } from "@/onboarding/OnboardingMeshBackground.js";
import { useEffect, useState } from "react";
import { logger } from "@/logger.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { resolveWorkspaceShellPanelRadiusPx } from "@/app-shell/workspaceShellWindowChrome.js";
import { ZCodeStartupLogoBadge } from "@/root/RootStartupLoading.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { useResolvedThemeHeroPalette } from "@/openWorkspacePageThemeHero.js";
import "@/onboarding/onboardingLogoSweep.css";

export function OccupationOnboardingVisual({
  isMacDesktop,
  isWindowsDesktop,
}: {
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
}) {
  const platform = usePlatform();
  const [macOSMajorVersion, setMacOSMajorVersion] = useState<number | null>(null);
  useEffect(() => {
    if (!isMacDesktop || !platform.getDesktopWindowChromeState) return;
    let disposed = false;
    // 系统版本在会话内固定；复用主界面的版本查询和圆角规则，未知版本沿用其保守值。
    void platform.getDesktopWindowChromeState().then(
      (state) => {
        if (!disposed) setMacOSMajorVersion(state.macOSMajorVersion ?? null);
      },
      (error) => logger.warn("[onboarding] 读取窗口圆角信息失败", { error }),
    );
    return () => {
      disposed = true;
    };
  }, [isMacDesktop, platform]);
  const borderRadius = resolveWorkspaceShellPanelRadiusPx({
    isMacDesktop,
    isWindowsDesktop,
    macOSMajorVersion,
  });
  const { intl } = useZCodeIntl();
  const palette = useResolvedThemeHeroPalette();
  return (
    <aside
      style={{ borderRadius }}
      className="relative hidden min-h-0 flex-col items-center overflow-y-auto bg-surface-hover px-[clamp(64px,4vw,72px)] py-[clamp(32px,4vw,72px)] dark:bg-background-alt lg:flex"
    >
      <OnboardingMeshBackground />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-10 rounded-[inherit] border border-border"
      />
      <div className="relative my-auto flex w-full max-w-[640px] shrink-0 flex-col items-start [container-type:inline-size]">
        <div aria-hidden="true" className="relative mb-10 rounded-3xl">
          <ZCodeStartupLogoBadge animated={false} />
          <div className="onboarding-logo-sweep">
            <div />
          </div>
        </div>
        <h2
          className={cn(
            "whitespace-nowrap text-[clamp(24px,7cqw,48px)] leading-[1.15] font-semibold tracking-[-0.035em]",
            palette.heading,
          )}
        >
          {intl.formatMessage({ id: "occupationOnboarding.heroTitle" })}
        </h2>
        <p
          className={cn(
            "mt-6 w-full whitespace-pre-line text-[16px] leading-[26px]",
            palette.description,
            "dark:text-slate-200",
          )}
        >
          {intl.formatMessage({ id: "occupationOnboarding.heroDescription" })}
        </p>
      </div>
    </aside>
  );
}
