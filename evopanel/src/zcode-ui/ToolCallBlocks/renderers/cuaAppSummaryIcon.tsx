import { useEffect, useState, type ReactNode } from "react";
import type { ApplicationIconRequest } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { CUA_TOOL_ICON } from "@/ToolCallBlocks/renderers/cuaIcon.js";

export function CuaAppSummaryIcon({
  bundleId,
  fallback,
  iconRequest,
  name,
  className,
}: {
  bundleId?: string;
  /**
   * 图标取不到时显示什么（平台无 resolver、Linux 无 locator、读取失败）。
   * 默认沿用 CUA 图标；node_repl 工具卡传入自己的图标，避免同一张卡在解析失败时
   * 跳成另一个指针图形。
   */
  fallback?: ReactNode;
  iconRequest?: ApplicationIconRequest | string | null;
  name: string;
  className?: "size-4" | "size-5";
}) {
  const platform = useOptionalPlatform();
  const [iconDataUrl, setIconDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setIconDataUrl(null);
    const request = iconRequest ?? bundleId;
    if (!request || !platform?.getApplicationIcon) return () => undefined;
    void platform
      .getApplicationIcon(request)
      .then((result) => {
        if (active) setIconDataUrl(result?.iconDataUrl ?? null);
      })
      .catch(() => {
        if (active) setIconDataUrl(null);
      });
    return () => {
      active = false;
    };
  }, [bundleId, iconRequest, platform]);

  return iconDataUrl ? (
    <img
      src={iconDataUrl}
      alt={name}
      className={cn(className ?? "size-4", "shrink-0 rounded-sm object-contain")}
    />
  ) : (
    (fallback ?? CUA_TOOL_ICON)
  );
}
