import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { accentTextClassNames, type AccentTone } from "../tokens/accents";

interface SignalPillProps extends ComponentPropsWithoutRef<"span"> {
  accent?: AccentTone;
  children: ReactNode;
}

export function SignalPill({
  accent = "primary",
  children,
  className = "",
  ...props
}: SignalPillProps) {
  return (
    <span
      className={[
        "inline-flex items-center rounded-full bg-surface-low/50 px-3 py-2 font-label-ui text-[11px] uppercase tracking-[0.2em]",
        accentTextClassNames[accent],
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </span>
  );
}
