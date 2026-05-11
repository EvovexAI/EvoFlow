import type { ComponentPropsWithoutRef } from "react";
import { SurfaceCard } from "../primitives/surface-card";
import { accentTextClassNames, type AccentTone } from "../tokens/accents";

type MetricTileVariant = "default" | "soft";

interface MetricTileProps extends ComponentPropsWithoutRef<"div"> {
  accent?: AccentTone;
  label: string;
  value: string;
  variant?: MetricTileVariant;
}

export function MetricTile({
  accent,
  className = "",
  label,
  value,
  variant = "default",
  ...props
}: MetricTileProps) {
  return (
    <SurfaceCard
      className={className}
      padding={variant === "soft" ? "sm" : "md"}
      radius="sm"
      variant={variant === "soft" ? "soft" : "default"}
      {...props}
    >
      <p className="font-label-ui text-[11px] uppercase tracking-[0.24em] text-foreground-muted">
        {label}
      </p>
      <p
        className={[
          "font-display-ui mt-3 text-lg font-semibold tracking-[-0.03em]",
          accent ? accentTextClassNames[accent] : "text-foreground",
        ].join(" ")}
      >
        {value}
      </p>
    </SurfaceCard>
  );
}
