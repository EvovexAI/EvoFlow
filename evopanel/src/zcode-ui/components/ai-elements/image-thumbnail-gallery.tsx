"use client";

import type { ComponentProps } from "react";
import { cn } from "@/components/lib/utils.js";

/** Standalone / in-flow thumb: inline so consecutive images sit on one row and wrap. */
export const imageThumbnailTriggerClassName =
  "my-2 mr-2 inline-block w-fit max-w-[min(100%,20rem)] cursor-zoom-in overflow-hidden rounded-xl align-top outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

export const imageThumbnailClassName =
  "h-auto max-h-44 max-w-full rounded-xl border border-border bg-background object-cover";

/**
 * Prefer horizontal packing; wrap only when the row is full.
 * (Avoid grid-cols-1 which forced every shot onto its own row.)
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
          ? "my-2 flex flex-wrap items-start gap-2 [&>[data-image-thumbnail-trigger]]:my-0 [&>[data-image-thumbnail-trigger]]:mr-0 [&>[data-image-thumbnail-trigger]]:h-44 [&>[data-image-thumbnail-trigger]]:w-auto [&>[data-image-thumbnail-trigger]]:max-w-[min(100%,20rem)] [&>[data-image-thumbnail-trigger]]:shrink-0 [&>[data-image-thumbnail-trigger]>img]:h-44 [&>[data-image-thumbnail-trigger]>img]:w-auto [&>[data-image-thumbnail-trigger]>img]:max-h-44 [&>[data-image-thumbnail-trigger]>img]:max-w-none"
          : "contents",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
