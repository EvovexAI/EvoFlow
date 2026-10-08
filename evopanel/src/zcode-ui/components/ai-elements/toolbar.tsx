/*
 * Derived from vercel/ai-elements (packages/elements/src/toolbar.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
import { cn } from "../lib/utils.js";
import { NodeToolbar, Position } from "@xyflow/react";
import type { ComponentProps } from "react";

type ToolbarProps = ComponentProps<typeof NodeToolbar>;

export const Toolbar = ({ className, ...props }: ToolbarProps) => (
  <NodeToolbar
    className={cn("flex items-center gap-1 rounded-sm border bg-background p-1.5", className)}
    position={Position.Bottom}
    {...props}
  />
);
