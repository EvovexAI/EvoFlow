import type { ComponentPropsWithoutRef, ReactNode } from "react";

type StatusChipTone = "neutral" | "primary" | "secondary" | "tertiary";

const toneClassNames: Record<StatusChipTone, string> = {
  neutral: "text-foreground-muted",
  primary: "text-primary",
  secondary: "text-secondary",
  tertiary: "text-tertiary",
};

const dotClassNames: Record<StatusChipTone, string> = {
  neutral: "bg-surface-bright",
  primary: "bg-primary",
  secondary: "bg-secondary",
  tertiary: "bg-tertiary",
};

interface StatusChipProps extends ComponentPropsWithoutRef<"div"> {
  children: ReactNode;
  pulse?: boolean;
  tone?: StatusChipTone;
}

export function StatusChip({
  children,
  className = "",
  pulse = true,
  tone = "primary",
  ...props
}: StatusChipProps) {
  return (
    <div
      className={[
        "inline-flex items-center gap-2 rounded-full border border-outline-variant/30 bg-surface-high/40 px-3 py-1 font-label-ui text-[11px] uppercase tracking-[0.24em]",
        toneClassNames[tone],
        className,
      ].join(" ")}
      {...props}
    >
      <span
        className={[
          "h-2 w-2 rounded-full",
          dotClassNames[tone],
          pulse ? "pulse-dot" : "",
        ].join(" ")}
      />
      <span>{children}</span>
    </div>
  );
}
