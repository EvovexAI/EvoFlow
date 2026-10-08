"use client";

import * as React from "react";
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui";

import { cn } from "../lib/utils.js";

function ScrollArea({
  className,
  scrollbarClassName,
  children,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  scrollbarClassName?: string;
}) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className="size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar className={scrollbarClassName} />
      <ScrollAreaPrimitive.Corner className="bg-transparent" />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "flex touch-none select-none transition-colors data-horizontal:h-2 data-horizontal:flex-col data-horizontal:p-[2px] data-vertical:h-full data-vertical:w-2 data-vertical:p-[2px]",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative min-h-2 min-w-2 flex-1 rounded-full bg-border"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}

export { ScrollArea, ScrollBar };
