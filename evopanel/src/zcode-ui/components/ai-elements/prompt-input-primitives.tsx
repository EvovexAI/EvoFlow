/*
 * Derived from vercel/ai-elements (packages/elements/src/prompt-input.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: split components and adapt local imports and behavior.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../ui/command.js";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.js";
import { cn } from "../lib/utils.js";
import type { ComponentProps, HTMLAttributes } from "react";

// ============================================================================
// Select Wrappers
// ============================================================================

export type PromptInputSelectProps = ComponentProps<typeof Select>;

export const PromptInputSelect = (props: PromptInputSelectProps) => <Select {...props} />;

export type PromptInputSelectTriggerProps = ComponentProps<typeof SelectTrigger>;

export const PromptInputSelectTrigger = ({
  className,
  ...props
}: PromptInputSelectTriggerProps) => (
  <SelectTrigger
    className={cn(
      "border-none bg-transparent font-medium text-muted-foreground shadow-none transition-colors",
      "hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground",
      className,
    )}
    {...props}
  />
);

export type PromptInputSelectContentProps = ComponentProps<typeof SelectContent>;

export const PromptInputSelectContent = ({
  className,
  ...props
}: PromptInputSelectContentProps) => <SelectContent className={cn(className)} {...props} />;

export type PromptInputSelectItemProps = ComponentProps<typeof SelectItem>;

export const PromptInputSelectItem = ({ className, ...props }: PromptInputSelectItemProps) => (
  <SelectItem className={cn(className)} {...props} />
);

export type PromptInputSelectValueProps = ComponentProps<typeof SelectValue>;

export const PromptInputSelectValue = ({ className, ...props }: PromptInputSelectValueProps) => (
  <SelectValue className={cn(className)} {...props} />
);

// ============================================================================
// HoverCard Wrappers
// ============================================================================

export type PromptInputHoverCardProps = ComponentProps<typeof HoverCard>;

export const PromptInputHoverCard = ({
  openDelay = 0,
  closeDelay = 0,
  ...props
}: PromptInputHoverCardProps) => (
  <HoverCard closeDelay={closeDelay} openDelay={openDelay} {...props} />
);

export type PromptInputHoverCardTriggerProps = ComponentProps<typeof HoverCardTrigger>;

export const PromptInputHoverCardTrigger = (props: PromptInputHoverCardTriggerProps) => (
  <HoverCardTrigger {...props} />
);

export type PromptInputHoverCardContentProps = ComponentProps<typeof HoverCardContent>;

export const PromptInputHoverCardContent = ({
  align = "start",
  ...props
}: PromptInputHoverCardContentProps) => <HoverCardContent align={align} {...props} />;

// ============================================================================
// Tabs Components
// ============================================================================

export type PromptInputTabsListProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTabsList = ({ className, ...props }: PromptInputTabsListProps) => (
  <div className={cn(className)} {...props} />
);

export type PromptInputTabProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTab = ({ className, ...props }: PromptInputTabProps) => (
  <div className={cn(className)} {...props} />
);

export type PromptInputTabLabelProps = HTMLAttributes<HTMLHeadingElement>;

export const PromptInputTabLabel = ({ className, ...props }: PromptInputTabLabelProps) => (
  // Content provided via children in props
  // oxlint-disable-next-line eslint-plugin-jsx-a11y(heading-has-content)
  <h3
    className={cn("mb-2 px-3 font-medium text-muted-foreground text-ui-base", className)}
    {...props}
  />
);

export type PromptInputTabBodyProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTabBody = ({ className, ...props }: PromptInputTabBodyProps) => (
  <div className={cn("space-y-1", className)} {...props} />
);

export type PromptInputTabItemProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTabItem = ({ className, ...props }: PromptInputTabItemProps) => (
  <div
    className={cn("flex items-center gap-2 px-3 py-2 text-ui-base hover:bg-accent", className)}
    {...props}
  />
);

// ============================================================================
// Command Palette Wrappers
// ============================================================================

export type PromptInputCommandProps = ComponentProps<typeof Command>;

export const PromptInputCommand = ({ className, ...props }: PromptInputCommandProps) => (
  <Command className={cn(className)} {...props} />
);

export type PromptInputCommandInputProps = ComponentProps<typeof CommandInput>;

export const PromptInputCommandInput = ({ className, ...props }: PromptInputCommandInputProps) => (
  <CommandInput className={cn(className)} {...props} />
);

export type PromptInputCommandListProps = ComponentProps<typeof CommandList>;

export const PromptInputCommandList = ({ className, ...props }: PromptInputCommandListProps) => (
  <CommandList className={cn(className)} {...props} />
);

export type PromptInputCommandEmptyProps = ComponentProps<typeof CommandEmpty>;

export const PromptInputCommandEmpty = ({ className, ...props }: PromptInputCommandEmptyProps) => (
  <CommandEmpty className={cn(className)} {...props} />
);

export type PromptInputCommandGroupProps = ComponentProps<typeof CommandGroup>;

export const PromptInputCommandGroup = ({ className, ...props }: PromptInputCommandGroupProps) => (
  <CommandGroup className={cn(className)} {...props} />
);

export type PromptInputCommandItemProps = ComponentProps<typeof CommandItem>;

export const PromptInputCommandItem = ({ className, ...props }: PromptInputCommandItemProps) => (
  <CommandItem className={cn(className)} {...props} />
);

export type PromptInputCommandSeparatorProps = ComponentProps<typeof CommandSeparator>;

export const PromptInputCommandSeparator = ({
  className,
  ...props
}: PromptInputCommandSeparatorProps) => <CommandSeparator className={cn(className)} {...props} />;
