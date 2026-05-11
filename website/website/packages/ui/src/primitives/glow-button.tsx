import type { ComponentPropsWithoutRef, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "md" | "lg";

interface ButtonStylesOptions {
  className?: string;
  size?: ButtonSize;
  variant?: ButtonVariant;
}

const sizeClassNames: Record<ButtonSize, string> = {
  md: "min-h-11 px-4 text-sm",
  lg: "min-h-12 px-6 text-sm md:px-7",
};

const variantClassNames: Record<ButtonVariant, string> = {
  primary:
    "bg-linear-to-r from-primary to-primary-container text-white dark:text-black shadow-[0_0_40px_-14px] shadow-primary/40 hover:shadow-[0_0_50px_-10px] hover:shadow-primary/50 hover:brightness-110",
  secondary:
    "border border-outline-variant/40 bg-surface-low/50 text-foreground hover:border-primary/25 hover:bg-surface-high/60",
  ghost:
    "bg-transparent text-foreground-muted hover:bg-surface-low/60 hover:text-foreground",
};

export function buttonClassName({
  className = "",
  size = "lg",
  variant = "primary",
}: ButtonStylesOptions = {}) {
  return [
    "inline-flex items-center justify-center gap-2 rounded-xl font-display-ui font-semibold tracking-[-0.02em] transition-all duration-300 active:scale-[0.98]",
    sizeClassNames[size],
    variantClassNames[variant],
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

interface GlowButtonProps extends ComponentPropsWithoutRef<"button"> {
  children: ReactNode;
  size?: ButtonSize;
  variant?: ButtonVariant;
}

export function GlowButton({
  children,
  className = "",
  size = "lg",
  type = "button",
  variant = "primary",
  ...props
}: GlowButtonProps) {
  return (
    <button
      className={buttonClassName({ className, size, variant })}
      type={type}
      {...props}
    >
      {children}
    </button>
  );
}
