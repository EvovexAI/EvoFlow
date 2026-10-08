import { InfoIcon } from "lucide-react";
import type { McpServerFailureKind } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function resolveMcpFailureMessageId(
  failureKind: McpServerFailureKind | undefined,
): `settings.mcp.failure.${McpServerFailureKind}` {
  return `settings.mcp.failure.${failureKind ?? "connection_failed"}`;
}

export function McpFailurePresentation({
  error,
  failureKind,
}: {
  error?: string;
  failureKind?: McpServerFailureKind;
}) {
  const { intl } = useZCodeIntl();
  const message = intl.formatMessage({
    id: resolveMcpFailureMessageId(failureKind),
  });
  const detailsLabel = intl.formatMessage({
    id: "settings.mcp.failure.technicalDetails",
  });
  return (
    <div className="mt-1 min-w-0 space-y-1">
      <div className="flex min-w-0 items-center gap-1 text-ui-base text-foreground-subtle">
        <span className="min-w-0">{message}</span>
        {error ? (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="-my-1 shrink-0 text-foreground-subtlest hover:text-foreground-subtle"
                aria-label={detailsLabel}
                title={detailsLabel}
                onClick={(event) => event.stopPropagation()}
              >
                <InfoIcon className="size-3.5" aria-hidden="true" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              side="top"
              className="w-80 max-w-[calc(100vw-1rem)] gap-2 p-3"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="text-ui-sm font-medium text-foreground">{detailsLabel}</div>
              <div className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-ui-xs text-foreground-subtle select-text">
                {error}
              </div>
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
    </div>
  );
}
