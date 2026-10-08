import { cn } from "@/components/lib/utils.js";

/** 模型编辑器专用：边框仅标记覆盖，Hover/焦点用同一底色，不修改全站控件。 */
export function modelEditorControlStyle(overridden: boolean, selected?: boolean) {
  return cn(
    "outline-none focus-visible:ring-0",
    overridden
      ? "border-primary/35 hover:border-primary/35 focus-visible:border-primary/35"
      : "border-border hover:border-border focus-visible:border-border",
    // 浅色 selected 与 hover 原本同为 5%，点击后看不出变化；仅方块底色增强，覆盖边框不变。
    selected === true
      ? "bg-foreground/15 bg-clip-border hover:bg-foreground/20 focus-visible:bg-foreground/20"
      : selected === false
        ? "bg-transparent hover:bg-hover focus-visible:bg-hover"
        : "bg-input hover:bg-hover focus-visible:bg-hover",
  );
}
