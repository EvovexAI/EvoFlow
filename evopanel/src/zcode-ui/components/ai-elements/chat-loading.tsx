"use client";

import type { ComponentPropsWithoutRef } from "react";
import { LoaderIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface ChatLoadingProps extends ComponentPropsWithoutRef<"div"> {
  loading: boolean;
  size?: "default" | "sm";
  className?: string;
}

export function ChatLoading({ loading, size = "default", className, ...props }: ChatLoadingProps) {
  const { intl } = useZCodeIntl();

  if (!loading) {
    return null;
  }

  const sizeClasses = size === "sm" ? "size-4 text-ui-base" : "size-6";

  return (
    <div
      aria-label={intl.formatMessage({ id: "common.loading" })}
      {...props}
      data-zcode-chat-loading-animate="true"
      role="status"
      className={cn("flex items-center", className)}
    >
      <div className="flex size-4 items-center justify-center">
        <LoaderIcon
          aria-hidden="true"
          className={cn("animate-spin text-foreground-subtle", sizeClasses)}
        />
      </div>
    </div>
  );
}
