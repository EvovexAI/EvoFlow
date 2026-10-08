import { cn } from "@/components/lib/utils.js";

/**
 * 键帽组件（对齐 shadcn Kbd）：每个按键独立成 chip，固定高度 + 最小方形宽度 +
 * flex 居中，保证 ⌘/⇧ 等单符号键与字母键视觉尺寸一致；font-sans 避免符号从
 * 等宽字体回落造成的字形宽度参差（数据来自平台格式化 label，见 shortcuts/label.ts）。
 */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 w-fit min-w-5 select-none items-center justify-center gap-1 rounded-sm bg-muted px-1 font-sans text-ui-xs font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** 键帽组合容器：把一次组合的多个键横排（gap-1），如 ⌘ + K。 */
function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  );
}

export { Kbd, KbdGroup };
