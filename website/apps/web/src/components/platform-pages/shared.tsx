"use client";

import type { ReactNode } from "react";
import { accentTextClassNames, type AccentTone } from "@ai-site/ui";

export const accentBorderClassNames: Record<AccentTone, string> = {
  primary: "border-primary/25",
  secondary: "border-secondary/25",
  tertiary: "border-tertiary/25",
};

export const accentSurfaceClassNames: Record<AccentTone, string> = {
  primary: "bg-primary/10",
  secondary: "bg-secondary/10",
  tertiary: "bg-tertiary/10",
};

export const accentRingClassNames: Record<AccentTone, string> = {
  primary: "shadow-[0_0_20px_rgba(208,188,255,0.18)]",
  secondary: "shadow-[0_0_20px_rgba(93,230,255,0.18)]",
  tertiary: "shadow-[0_0_20px_rgba(255,185,95,0.18)]",
};

export function OutlineHeroWord({
  className = "",
  word,
}: {
  className?: string;
  word: string;
}) {
  return (
    <h1
      className={[
        "outline-display-text font-display-ui leading-none font-semibold tracking-[-0.08em] select-none",
        className,
      ].join(" ")}
    >
      {word}
    </h1>
  );
}

export function AccentEyebrow({
  accent,
  children,
  className = "",
}: {
  accent: AccentTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={[
        "font-label-ui text-[10px] uppercase tracking-[0.24em]",
        accentTextClassNames[accent],
        className,
      ].join(" ")}
    >
      {children}
    </p>
  );
}
