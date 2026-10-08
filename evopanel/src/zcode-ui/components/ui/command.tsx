import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";

import { cn } from "../lib/utils.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./dialog.js";
import { InputGroup, InputGroupAddon } from "./input-group.js";
import { SearchIcon, CheckIcon } from "lucide-react";

function Command({
  className,
  loop = false,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      loop={loop}
      className={cn(
        "flex size-full flex-col overflow-hidden rounded-xl bg-popover p-1 text-popover-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CommandDialog({
  title = "Command Palette",
  description = "Search for a command to run...",
  children,
  className,
  showCloseButton = false,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string;
  description?: string;
  className?: string;
  showCloseButton?: boolean;
}) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className={cn("top-1/3 translate-y-0 overflow-hidden p-0", className)}
        showCloseButton={showCloseButton}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}

function CommandInput({
  className,
  inputGroupClassName,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & {
  inputGroupClassName?: string;
}) {
  return (
    <div data-slot="command-input-wrapper" className="p-1 border-b border-border">
      <InputGroup
        className={cn(
          "h-8 border-0 !bg-transparent hover:border-input-border-hover",
          inputGroupClassName,
        )}
      >
        <CommandPrimitive.Input
          data-slot="command-input"
          className={cn(
            "w-full text-ui-base/relaxed text-foreground outline-hidden placeholder:text-foreground-subtlest disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
          {...props}
        />
        <InputGroupAddon>
          <SearchIcon className="size-4 shrink-0 text-foreground-subtlest" />
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        "scrollbar-hide max-h-72 scroll-py-1 overflow-x-hidden overflow-y-auto outline-none",
        className,
      )}
      {...props}
    />
  );
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn("py-6 text-center text-ui-base/relaxed", className)}
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden p-1 text-foreground **:[[cmdk-group-heading]]:px-2.5 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-ui-base **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-foreground-subtle",
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-1 my-1 h-px bg-border/50", className)}
      {...props}
    />
  );
}

function CommandItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        // cmdk 键盘上下键只会切换 data-selected，之前没有同步背景色，
        // 导致键盘选中态和鼠标 hover 态看起来不是同一个状态。这里让两者共用 menu-hover。
        "group/command-item relative flex min-h-7 cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-ui-base/relaxed outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 hover:bg-menu-hover data-selected:bg-menu-hover data-selected:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 data-selected:*:[svg]:text-foreground",
        className,
      )}
      {...props}
    >
      {children}
      <CheckIcon className="size-4 ml-auto !text-foreground-subtle hidden group-has-data-[slot=command-shortcut]/command-item:hidden group-data-[checked=true]/command-item:inline-block" />
    </CommandPrimitive.Item>
  );
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "ml-auto text-ui-xs tracking-widest text-foreground-subtlest group-data-selected/command-item:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
};
