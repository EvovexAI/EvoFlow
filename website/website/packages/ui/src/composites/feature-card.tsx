import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { SurfaceCard } from "../primitives/surface-card";
import { accentTextClassNames, type AccentTone } from "../tokens/accents";

interface FeatureCardProps extends ComponentPropsWithoutRef<"div"> {
  accent?: AccentTone;
  children?: ReactNode;
  description: string;
  eyebrow: string;
  interactive?: boolean;
  title: string;
}

export function FeatureCard({
  accent = "primary",
  children,
  className = "",
  description,
  eyebrow,
  interactive = false,
  title,
  ...props
}: FeatureCardProps) {
  return (
    <SurfaceCard
      className={className}
      padding="lg"
      radius="md"
      variant={interactive ? "interactive" : "default"}
      {...props}
    >
      <span
        className={[
          "font-label-ui text-xs uppercase tracking-[0.24em]",
          accentTextClassNames[accent],
        ].join(" ")}
      >
        {eyebrow}
      </span>
      <h4 className="font-display-ui mt-4 text-xl font-semibold tracking-[-0.03em]">
        {title}
      </h4>
      <p className="mt-3 text-sm leading-7 text-foreground-muted">
        {description}
      </p>
      {children ? <div className="mt-5">{children}</div> : null}
    </SurfaceCard>
  );
}
