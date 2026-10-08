import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";

interface RootStartupLoadingProps {
  label: string;
  children?: ReactNode;
  busy?: boolean;
}

export function RootStartupLoading({ label, children, busy = true }: RootStartupLoadingProps) {
  return (
    <div
      // Web 端全局 html/body/#root 为 Electron 透明背景让路，React 接管后会替换 HTML 启动壳。
      // 这里必须由阻塞态自身承接主题背景，否则远控链接会在 Root 恢复期间继续露出浏览器白底。
      className="flex h-full min-h-dvh flex-col items-center justify-center gap-6 bg-background text-foreground"
      role="status"
      aria-busy={busy}
      aria-label={label}
      data-testid="root-startup-loading"
    >
      <ZCodeStartupLogoBadge />
      {children}
    </div>
  );
}

/** 初始化与引导共用品牌图标，保持底色、描边、圆角和标志比例一致。 */
export function ZCodeStartupLogoBadge({ animated = true }: { animated?: boolean }) {
  return (
    <div className="relative flex size-24 items-center justify-center rounded-3xl bg-[linear-gradient(180deg,#000000_0%,#151718_100%)] text-[#ffffff] shadow-xl/20 before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:border before:border-[rgba(255,255,255,0.1)] before:content-['']">
      <ZCodeStartupLogo className="h-auto w-14" animated={animated} />
    </div>
  );
}

function ZCodeStartupLogo({
  className,
  animated = true,
}: {
  className?: string;
  animated?: boolean;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="118"
      height="100"
      fill="none"
      viewBox="0 0 256 218"
      className={cn("shrink-0 text-current", className)}
      aria-hidden="true"
      focusable="false"
    >
      {animated ? (
        <animate
          attributeName="opacity"
          begin="3s"
          dur="1.8s"
          repeatCount="indefinite"
          values="1;0.4;1"
        />
      ) : null}
      <path
        fill="currentColor"
        d="M134.4 0.130152L116.48 25.6022C113.665 29.5699 109.054 32.0019 104.064 32.0019H6.3999V0C6.3999 0.130149 134.4 0.130152 134.4 0.130152Z"
      />
      <path fill="currentColor" d="M256 0.130127L102.401 217.732H0L153.599 0.130127H256Z" />
      <path
        fill="currentColor"
        d="M121.601 217.732L139.65 192.134C142.465 188.166 147.076 185.734 152.067 185.734H249.604V217.736H121.601V217.732Z"
      />
    </svg>
  );
}
