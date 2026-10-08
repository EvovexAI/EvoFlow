import type { ReactNode } from "react";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { cn } from "@/components/lib/utils.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";

export function UpdateReleaseNotesTooltip({
  children,
  locale,
  onOpenExternalUrl,
  releaseDateLabel,
  releaseNotesMarkdown,
  releaseNotesTitle,
}: {
  children: ReactNode;
  locale: string;
  onOpenExternalUrl: (url: string) => void;
  releaseDateLabel: string | null;
  releaseNotesMarkdown: string;
  releaseNotesTitle: string;
}) {
  return (
    <TooltipProvider>
      <Tooltip key={`${locale}:${releaseNotesTitle}`}>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent
          side="bottom"
          align="start"
          sideOffset={4}
          className="w-96 max-w-[calc(100vw-2rem)] flex-col items-start gap-2 rounded-xl border-popover-border bg-popover px-4 py-3 text-left text-popover-foreground shadow-md"
        >
          <div className="flex w-full min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-ui-sm font-medium leading-5 text-foreground">
                {releaseNotesTitle}
              </div>
              {releaseDateLabel ? (
                <div className="text-ui-sm leading-4 text-foreground-subtle">
                  {releaseDateLabel}
                </div>
              ) : null}
            </div>
          </div>
          <div className="max-h-72 w-full overflow-y-auto border-t border-border pt-2">
            <MessageResponse
              className={cn(
                "prose prose-sm max-w-none text-ui-sm leading-relaxed text-foreground dark:prose-invert",
                "prose-headings:font-semibold prose-headings:tracking-tight",
                "prose-h1:text-ui-lg prose-h2:text-ui-base prose-h3:text-ui-base",
              )}
              onOpenExternalUrl={onOpenExternalUrl}
            >
              {releaseNotesMarkdown}
            </MessageResponse>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
