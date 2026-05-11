import type { ComponentPropsWithoutRef, ReactNode } from "react";

type SurfaceCardPadding = "none" | "sm" | "md" | "lg" | "xl";
type SurfaceCardRadius = "sm" | "md" | "lg" | "xl";
type SurfaceCardVariant = "default" | "interactive" | "soft" | "contrast";

interface SurfaceCardProps extends ComponentPropsWithoutRef<"div"> {
  children: ReactNode;
  padding?: SurfaceCardPadding;
  radius?: SurfaceCardRadius;
  variant?: SurfaceCardVariant;
}

const paddingClassNames: Record<SurfaceCardPadding, string> = {
  none: "",
  sm: "p-4",
  md: "p-5",
  lg: "p-7 md:p-8",
  xl: "p-8 md:p-10",
};

const radiusClassNames: Record<SurfaceCardRadius, string> = {
  sm: "rounded-[24px]",
  md: "rounded-[28px]",
  lg: "rounded-[32px]",
  xl: "rounded-[36px]",
};

const variantClassNames: Record<SurfaceCardVariant, string> = {
  default:
    "bg-surface-low shadow-[inset_0_1px_0_rgba(255,255,255,0.03),0_20px_40px_rgba(0,0,0,0.18)]",
  interactive:
    "bg-surface-low shadow-[inset_0_1px_0_rgba(255,255,255,0.03),0_20px_40px_rgba(0,0,0,0.18)] transition-all duration-300 hover:-translate-y-1 hover:bg-surface-high",
  soft: "border-outline-variant/30 bg-surface-low/50 backdrop-blur-sm",
  contrast: "border-outline-variant/30 bg-black/20",
};

export function SurfaceCard({
  children,
  className = "",
  padding = "md",
  radius = "md",
  variant = "default",
  ...props
}: SurfaceCardProps) {
  return (
    <div
      className={[
        "relative overflow-hidden border border-outline-variant/20",
        paddingClassNames[padding],
        radiusClassNames[radius],
        variantClassNames[variant],
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </div>
  );
}
