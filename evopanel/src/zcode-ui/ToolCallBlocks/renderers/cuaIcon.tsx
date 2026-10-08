import { MousePointerClick } from "lucide-react";

export const CUA_FALLBACK_ICON = (
  <MousePointerClick className="size-4 shrink-0 text-foreground-subtle" />
);

// 兼容 CUA 分组摘要的语义名称；底层视觉仍统一使用同一个 fallback。
export const CUA_TOOL_ICON = CUA_FALLBACK_ICON;
