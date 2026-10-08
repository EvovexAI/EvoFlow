import type { ZCodeModelTrajectoryMessage } from "@zcode/services";
import { Maximize2Icon, Minimize2Icon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ContentPartView } from "@/ModelTrajectoryPaneDetails.js";
import {
  trajectoryToolCallInputs,
  trajectoryToolHasError,
  trajectoryToolMetadata,
  trajectoryToolOutputs,
} from "@/ModelTrajectoryToolPayload.js";

type IntlShape = ReturnType<typeof useZCodeIntl>["intl"];

export function TrajectoryExpandedContent({
  message,
  role,
  open,
  searchRevealed,
  intl,
}: {
  message: ZCodeModelTrajectoryMessage;
  role: "system" | "user" | "assistant" | "tool";
  open: boolean;
  searchRevealed: boolean;
  intl: IntlShape;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const metadata = trajectoryToolMetadata(message);
  const toolPayloadHasError = trajectoryToolHasError(message);
  const toolPayloads = message.parts.some((part) => part.kind === "tool-result")
    ? trajectoryToolOutputs(message)
    : trajectoryToolCallInputs(message);

  const measureOverflow = useCallback(() => {
    const element = contentRef.current;
    if (!element || showAll) return;
    setIsOverflowing(element.scrollHeight > element.clientHeight + 2);
  }, [showAll]);

  useLayoutEffect(() => {
    measureOverflow();
  }, [measureOverflow]);

  useEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measureOverflow);
    observer?.observe(element);
    window.addEventListener("resize", measureOverflow);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measureOverflow);
    };
  }, [measureOverflow]);

  useEffect(() => {
    if (!open) setShowAll(false);
  }, [open]);

  const contentExpanded = showAll || searchRevealed;
  const clipped = isOverflowing && !contentExpanded;
  const maskImage = clipped
    ? "linear-gradient(to bottom, black 0%, black calc(100% - 72px), transparent 100%)"
    : undefined;

  return (
    <div data-trajectory-expanded-content-shell="" className="relative min-w-0">
      <div
        ref={contentRef}
        data-trajectory-message-content=""
        data-trajectory-user-content-card={role === "user" ? "" : undefined}
        data-overflow-clipped={clipped || undefined}
        className={cn(
          "flex w-full min-w-0 flex-col gap-1.5 overflow-hidden px-3 pt-0",
          isOverflowing ? "pb-14" : "pb-2",
          !contentExpanded && "max-h-64",
        )}
        style={{ maskImage, WebkitMaskImage: maskImage }}
      >
        {metadata.names || metadata.ids ? (
          <div className="flex min-w-0 items-center gap-1">
            {metadata.names ? (
              <Badge
                data-trajectory-expanded-tool-name=""
                data-trajectory-search-field="tool-name"
                variant="outline"
                className="h-5 rounded-full border-border bg-tag px-2 font-mono text-ui-xs text-foreground-subtle"
                title={metadata.names}
              >
                {metadata.names}
              </Badge>
            ) : null}
            {metadata.ids ? (
              <Badge
                data-trajectory-expanded-tool-id=""
                data-trajectory-search-field="tool-id"
                variant="outline"
                className="h-5 min-w-0 truncate rounded-full border-border bg-tag px-2 font-mono text-ui-xs text-foreground-subtle"
                title={metadata.ids}
              >
                {metadata.ids}
              </Badge>
            ) : null}
          </div>
        ) : null}
        {toolPayloads.length > 0
          ? toolPayloads.map((output, outputIndex) => (
              <pre
                key={outputIndex}
                data-trajectory-search-field="content"
                data-trajectory-tool-error-content={toolPayloadHasError ? "" : undefined}
                className={cn(
                  "min-w-0 whitespace-pre-wrap break-words font-mono text-ui-sm leading-relaxed",
                  toolPayloadHasError
                    ? "rounded-lg bg-destructive/10 px-2 py-1.5 text-destructive"
                    : "text-foreground",
                )}
              >
                {output.trim()}
              </pre>
            ))
          : message.parts.map((part, partIndex) => (
              <div key={partIndex} data-trajectory-search-field="content">
                <ContentPartView
                  part={
                    "text" in part && typeof part.text === "string"
                      ? { ...part, text: part.text.trim() }
                      : part
                  }
                  intl={intl}
                  showToolHeader={false}
                />
              </div>
            ))}
      </div>
      {isOverflowing && !searchRevealed ? (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2">
          <Button
            data-trajectory-overflow-toggle=""
            type="button"
            variant="outline"
            size="sm"
            className="rounded-full bg-surface/90 px-2 text-ui-sm shadow-sm supports-[backdrop-filter]:bg-surface/70 supports-[backdrop-filter]:backdrop-blur-md"
            onClick={() => setShowAll((current) => !current)}
          >
            {showAll ? (
              <Minimize2Icon className="size-3.5" />
            ) : (
              <Maximize2Icon className="size-3.5" />
            )}
            {intl.formatMessage({
              id: showAll ? "modelTrajectory.collapseContent" : "modelTrajectory.showAll",
            })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
