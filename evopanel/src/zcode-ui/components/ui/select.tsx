"use client";

import * as React from "react";
import { Select as SelectPrimitive } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils.js";
import { ChevronDownIcon, CheckIcon, ChevronUpIcon } from "lucide-react";

// resize 大会话时 Select trigger 跟随基础控件批量重排，
// transition-all 会把布局/滚动条相关属性也动画化；这里限定为颜色过渡。
const selectTriggerVariants = cva(
  "flex w-fit items-center justify-between gap-1.5 border whitespace-nowrap transition-colors outline-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 data-placeholder:text-foreground-subtlest *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        input:
          "border-input-border bg-input text-foreground hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:ring-0",
        default: "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
        outline:
          "border-border bg-transparent text-foreground hover:bg-input/50 hover:text-foreground aria-expanded:bg-selected aria-expanded:text-foreground",
        secondary:
          "border-transparent bg-secondary text-foreground hover:bg-secondary/80 aria-expanded:bg-secondary aria-expanded:text-foreground",
        ghost:
          "border-transparent bg-transparent text-foreground hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 aria-expanded:bg-destructive aria-expanded:text-destructive-foreground",
      },
      size: {
        xs: "h-5 rounded-sm pl-2 pr-1 text-ui-base [&_svg:not([class*='size-'])]:size-2.5",
        sm: "h-6 rounded-md pl-2 pr-1 text-ui-base/relaxed [&_svg:not([class*='size-'])]:size-3",
        default:
          "h-7 rounded-md pl-2 pr-1 text-ui-base/relaxed [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-8 rounded-lg pl-3 pr-2 text-ui-base [&_svg:not([class*='size-'])]:size-4",
      },
    },
    defaultVariants: {
      variant: "input",
      size: "default",
    },
  },
);

function Select({ ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectGroup({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cn("flex flex-col gap-0.5 scroll-my-1 p-1", className)}
      {...props}
    />
  );
}

function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

function SelectTrigger({
  className,
  variant = "input",
  size = "default",
  children,
  indicator,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> &
  VariantProps<typeof selectTriggerVariants> & {
    indicator?: React.ReactNode;
  }) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-variant={variant}
      data-size={size}
      className={cn(selectTriggerVariants({ variant, size }), className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        {indicator ?? (
          <ChevronDownIcon className="pointer-events-none size-3.5 text-foreground-subtle" />
        )}
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

// 圆角规范迁移：旧菜单沿用 xl/lg，统一为独立外壳 lg、内部选项 md；子菜单重新起算。
function SelectContent({
  className,
  children,
  position = "item-aligned",
  align = "center",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        data-align-trigger={position === "item-aligned"}
        className={cn(
          // 可操作的 Select 必须高于 z-50 tooltip，避免提示遮住选项。
          "relative z-[60] max-h-(--radix-select-content-available-height) min-w-32 origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border border-popover-border bg-menu p-1 text-foreground shadow-md duration-100 data-[align-trigger=true]:animate-none data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 [app-region:no-drag]",
          className,
        )}
        position={position}
        align={align}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          data-position={position}
          className={cn(
            // popper 模式下如果把 viewport 高度锁成 trigger 高度，
            // 会导致菜单可视区域被压成一行，无法完整展开选项。
            // 这里仅保留宽度对齐，交给内容容器的 max-height 控制可视高度。
            // Select 选项过去紧贴排列；在真正承载选项的 viewport 统一保留 2px。
            "flex flex-col gap-0.5 data-[position=popper]:w-full data-[position=popper]:min-w-(--radix-select-trigger-width)",
            position === "popper" && "",
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn("px-2 py-1.5 text-ui-base text-foreground-subtlest", className)}
      {...props}
    />
  );
}

type SelectItemProps = React.ComponentProps<typeof SelectPrimitive.Item> & {
  trailing?: React.ReactNode;
};

const SelectItem = React.forwardRef<React.ElementRef<typeof SelectPrimitive.Item>, SelectItemProps>(
  ({ className, children, trailing, ...props }, ref) => {
    return (
      <SelectPrimitive.Item
        ref={ref}
        data-slot="select-item"
        className={cn(
          "relative flex min-h-7 w-full cursor-default items-center gap-2 rounded-md px-2 py-1 text-ui-base/relaxed text-foreground outline-hidden select-none data-[highlighted]:bg-menu-hover data-[highlighted]:text-foreground data-disabled:pointer-events-none data-disabled:text-foreground-subtlest data-disabled:opacity-100 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
          className,
        )}
        {...props}
      >
        {trailing ? (
          <span className="pointer-events-auto absolute right-2 flex items-center justify-center">
            {trailing}
          </span>
        ) : null}
        <span className="pointer-events-none absolute right-2 flex items-center justify-center">
          <SelectPrimitive.ItemIndicator>
            <CheckIcon className="pointer-events-none size-4 text-foreground-subtle" />
          </SelectPrimitive.ItemIndicator>
        </span>
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      </SelectPrimitive.Item>
    );
  },
);

SelectItem.displayName = "SelectItem";

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("pointer-events-none my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn(
        "z-10 flex cursor-default items-center justify-center bg-menu py-1 text-foreground-subtle [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    >
      <ChevronUpIcon />
    </SelectPrimitive.ScrollUpButton>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn(
        "z-10 flex cursor-default items-center justify-center bg-menu py-1 text-foreground-subtle [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    >
      <ChevronDownIcon />
    </SelectPrimitive.ScrollDownButton>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  selectTriggerVariants,
};
