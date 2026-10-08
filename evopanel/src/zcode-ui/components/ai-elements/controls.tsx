/*
 * Derived from vercel/ai-elements (packages/elements/src/controls.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

import { cn } from "../lib/utils.js";
import { Controls as ControlsPrimitive } from "@xyflow/react";
import type { ComponentProps } from "react";

export type ControlsProps = ComponentProps<typeof ControlsPrimitive>;

export const Controls = ({ className, ...props }: ControlsProps) => (
  <ControlsPrimitive
    className={cn(
      "gap-px overflow-hidden rounded-md border bg-card p-1 shadow-none!",
      "[&>button]:rounded-md [&>button]:border-none! [&>button]:bg-transparent! [&>button]:hover:bg-secondary!",
      className,
    )}
    {...props}
  />
);
