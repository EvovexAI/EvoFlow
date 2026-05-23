import type { ComponentPropsWithoutRef } from "react";
import { GlassPanel } from "../primitives/glass-panel";
import { accentTextClassNames, type AccentTone } from "../tokens/accents";

interface PromptPanelItem {
  accent?: AccentTone;
  label: string;
  highlighted?: boolean;
}

interface PromptPanelProps extends ComponentPropsWithoutRef<"div"> {
  items: PromptPanelItem[];
  label: string;
}

export function PromptPanel({
  className = "",
  items,
  label,
  ...props
}: PromptPanelProps) {
  return (
    <GlassPanel
      className={["relative z-20 rounded-[24px] p-6", className].join(" ")}
      {...props}
    >
      <div className="border-b border-outline-variant/30 pb-4 text-sm text-foreground-muted">
        {label}
      </div>
      <div className="mt-4 grid gap-3">
        {items.map((item, index) => (
          <div
            key={`${item.label}-${index}`}
            className={[
              "rounded-xl px-3 py-3 text-sm transition-colors duration-300",
              item.highlighted
                ? [
                    "bg-primary/10",
                    accentTextClassNames[item.accent ?? "primary"],
                  ].join(" ")
                : "bg-surface-high/40 text-foreground-muted",
            ].join(" ")}
          >
            {item.label}
          </div>
        ))}
      </div>
    </GlassPanel>
  );
}
