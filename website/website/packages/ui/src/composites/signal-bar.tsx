"use client";

import { useEffect, useState, type ComponentPropsWithoutRef } from "react";
import { accentTextClassNames, type AccentTone } from "../tokens/accents";

interface SignalBarProps extends ComponentPropsWithoutRef<"div"> {
  accent?: AccentTone;
  label: string;
  value: number;
  valueLabel?: string;
  /** Animate bar in on mount (default true) */
  animate?: boolean;
}

export function SignalBar({
  accent = "secondary",
  animate = true,
  className = "",
  label,
  value,
  valueLabel,
  ...props
}: SignalBarProps) {
  const clampedValue = Math.max(0, Math.min(100, value));
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!animate) { setWidth(clampedValue); return; }
    setWidth(0);
    const t = setTimeout(() => setWidth(clampedValue), 80);
    return () => clearTimeout(t);
  }, [animate, clampedValue]);

  // Accent color values for inline gradient (avoids Tailwind v4 oklch muddy blending)
  const accentHex: Record<AccentTone, string> = {
    primary: "#d0bcff",
    secondary: "#5de6ff",
    tertiary: "#ffb95f",
  };
  const color = accentHex[accent];

  return (
    <div className={className} {...props}>
      <div className="font-label-ui mb-2 flex items-center justify-between text-[11px] uppercase tracking-[0.2em] text-foreground-muted">
        <span>{label}</span>
        <span className={accentTextClassNames[accent]}>
          {valueLabel ?? `${clampedValue}%`}
        </span>
      </div>
      {/* Track */}
      <div className="h-2 overflow-hidden rounded-full bg-outline-variant/30">
        <div
          className="h-full rounded-full transition-all duration-1000 ease-out"
          style={{
            width: `${width}%`,
            background: `linear-gradient(to right, ${color}55, ${color}ee)`,
            boxShadow: width > 0 ? `0 0 10px ${color}70` : "none",
          }}
        />
      </div>
    </div>
  );
}
