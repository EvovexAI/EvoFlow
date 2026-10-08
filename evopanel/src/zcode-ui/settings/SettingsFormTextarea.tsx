import type { ComponentProps } from "react";
import { cn } from "@/components/lib/utils.js";
import { Textarea } from "@/components/ui/textarea.js";

type SettingsFormTextareaProps = ComponentProps<typeof Textarea>;

export function SettingsFormTextarea({ className, ...props }: SettingsFormTextareaProps) {
  return (
    <Textarea
      className={cn(
        "rounded-lg border border-input-border bg-input px-2 py-2 text-ui-base shadow-none placeholder:text-foreground-subtlest hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:ring-0",
        className,
      )}
      {...props}
    />
  );
}
