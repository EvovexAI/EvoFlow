import { Check } from "lucide-react";
import { modeOptionIcons } from "@/onboarding/occupationOptions.js";
import { cn } from "@/components/lib/utils.js";
import type { InterfaceMode } from "@/lib/interfaceMode.js";

interface ModeSelectorProps {
  mode: InterfaceMode | null;
  saving: boolean;
  onSelect: (value: InterfaceMode) => void;
  label: string;
  formatLabel: (key: string) => string;
}

/** 引导第二步的 UI 模式选择；从 OccupationOnboarding 抽出以控制文件行数。 */
export function OnboardingModeSelector({
  mode,
  saving,
  onSelect,
  label,
  formatLabel,
}: ModeSelectorProps) {
  return (
    <div className="mt-8 space-y-3" role="group" aria-label={label}>
      {(["coding", "office"] as const).map((value) => {
        const Icon = modeOptionIcons[value];
        return (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            disabled={saving}
            onClick={() => onSelect(value)}
            className={cn(
              "flex w-full items-start gap-4 rounded-xl border p-5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
              mode === value
                ? "border-foreground/60 bg-card-selected dark:border-foreground/50"
                : "border-card-border bg-card hover:border-border-hover hover:bg-surface-hover dark:border-border/60 dark:bg-transparent dark:hover:bg-surface/60",
            )}
          >
            <Icon className="mt-0.5 size-5 shrink-0 text-foreground-subtle" strokeWidth={1.5} />
            <span className="min-w-0 flex-1">
              <span className="block text-ui-base font-medium">
                {formatLabel(value === "office" ? "officeMode" : value)}
              </span>
              <span className="mt-2 block text-ui-sm leading-relaxed text-foreground-subtle">
                {formatLabel(value === "office" ? "officeModeDescription" : `${value}Description`)}
              </span>
            </span>
            <span
              aria-hidden="true"
              className={cn(
                "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                mode === value
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border",
              )}
            >
              {mode === value ? <Check className="size-3" /> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
