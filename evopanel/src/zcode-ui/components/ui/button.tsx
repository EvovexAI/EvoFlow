import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "../lib/utils.js";

// 大会话窗口 resize trace 显示基础按钮的 transition-all 会批量启动
// scrollbar-color/尺寸等非合成动画，放大主线程 style/layout 压力；按钮只需要颜色过渡。
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-ui-base/relaxed whitespace-nowrap transition-colors outline-none select-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        outline:
          "border-border text-foreground hover:border-border-hover hover:bg-input/50 hover:text-foreground aria-expanded:bg-input/50 aria-expanded:text-foreground",
        secondary:
          "bg-secondary text-foreground hover:bg-secondary/80 aria-expanded:bg-secondary aria-expanded:text-foreground",
        ghost:
          "text-foreground hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 aria-expanded:bg-destructive aria-expanded:text-destructive-foreground",
        warning:
          "bg-warning text-warning-foreground hover:bg-warning/90 focus-visible:border-warning/40 focus-visible:ring-warning/20 aria-expanded:bg-warning aria-expanded:text-warning-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-7 gap-1 px-2 text-ui-base has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        xs: "h-5 gap-1 rounded-sm px-2 text-ui-base has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-2.5",
        sm: "h-6 gap-1 px-2 text-ui-base/relaxed has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        lg: "h-8 gap-1 rounded-lg px-2.5 text-ui-base has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-4",
        icon: "size-7 [&_svg:not([class*='size-'])]:size-4",
        "icon-xs": "size-5 rounded-sm [&_svg:not([class*='size-'])]:size-2.5",
        "icon-sm": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-md": "size-7 rounded-lg [&_svg:not([class*='size-'])]:size-4",
        "icon-lg": "size-8 rounded-lg [&_svg:not([class*='size-'])]:size-4",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
