import type { ComponentPropsWithoutRef, ReactNode } from "react";

interface GlassPanelProps extends ComponentPropsWithoutRef<"div"> {
  children: ReactNode;
}

export function GlassPanel({
  children,
  className = "",
  ...props
}: GlassPanelProps) {
  return (
    <div
      className={[
        "glass-panel rounded-2xl",
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </div>
  );
}
