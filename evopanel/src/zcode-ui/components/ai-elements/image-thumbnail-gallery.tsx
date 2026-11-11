"use client";

import type { ComponentProps } from "react";
import { cn } from "@/components/lib/utils.js";

/**
 * Compact thumbs (h-28 ≈ 7rem)：原比例、横排多放几张；点开仍走大图预览。
 * 旧 max-h-44 / 20rem 一张太大，一行塞不下几张。
 */
export const imageThumbnailTriggerClassName =
  "my-1.5 mr-1.5 inline-block w-fit max-w-[min(100%,10rem)] cursor-zoom-in overflow-hidden rounded-lg align-top outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

export const imageThumbnailClassName =
  "h-auto max-h-28 max-w-full rounded-lg border border-border bg-background object-contain";

/**
 * Prefer horizontal packing; wrap only when the row is full.
 * Fixed height + w-auto keeps aspect ratio; object-contain avoids crop.
 */
export function ImageThumbnailGallery({
  children,
  className,
  grouped = true,
  ...props
}: ComponentProps<"div"> & { grouped?: boolean }) {
  return (
    <div
      className={cn(
        grouped
          ? "my-1.5 flex flex-wrap items-start gap-1.5 [&>[data-image-thumbnail-trigger]]:my-0 [&>[data-image-thumbnail-trigger]]:mr-0 [&>[data-image-thumbnail-trigger]]:h-28 [&>[data-image-thumbnail-trigger]]:w-auto [&>[data-image-thumbnail-trigger]]:max-w-[min(100%,10rem)] [&>[data-image-thumbnail-trigger]]:shrink-0 [&>[data-image-thumbnail-trigger]>img]:h-28 [&>[data-image-thumbnail-trigger]>img]:w-auto [&>[data-image-thumbnail-trigger]>img]:max-h-28 [&>[data-image-thumbnail-trigger]>img]:max-w-none [&>[data-image-thumbnail-trigger]>img]:object-contain"
          : "contents",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
