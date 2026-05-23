import type { CSSProperties, ReactNode } from "react";

interface HeroTitleProps {
  children: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function HeroTitle({
  children,
  subtitle,
  badge,
  className = "",
  style,
}: HeroTitleProps) {
  return (
    <div className={className} style={style}>
      {badge && <div className="mb-4">{badge}</div>}
      <h1 className="font-display-ui text-[clamp(4.8rem,14vw,10rem)] font-semibold leading-none tracking-[-0.08em]">
        {children}
      </h1>
      {subtitle && (
        <p className="font-display-ui mt-6 max-w-3xl text-2xl font-medium leading-tight tracking-[-0.04em] text-foreground md:text-4xl">
          {subtitle}
        </p>
      )}
    </div>
  );
}
