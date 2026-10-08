"use client";

import type { ComponentProps } from "react";
import { cn } from "@/components/lib/utils.js";

export type MarkdownBlockquoteProps = ComponentProps<"blockquote"> & {
  node?: unknown;
};

export function MarkdownBlockquote({ className, node: _node, ...props }: MarkdownBlockquoteProps) {
  return (
    <blockquote
      className={cn(
        "my-4 border-border border-l-2 pl-3 text-foreground-subtle",
        "[&_p]:my-0 [&_p+p]:mt-2",
        className,
      )}
      data-markdown-blockquote=""
      {...props}
    />
  );
}
