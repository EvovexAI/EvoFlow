import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import { cn } from "@/components/lib/utils.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";

function scrollRemoteConnectionLogsToLatest(
  viewport: Pick<HTMLElement, "scrollHeight" | "scrollTop">,
): void {
  viewport.scrollTop = viewport.scrollHeight;
}

function scheduleRemoteConnectionLogsScrollToLatest(
  viewport: Pick<HTMLElement, "scrollHeight" | "scrollTop">,
  scheduleFrame: (callback: () => void) => number = (callback) =>
    window.requestAnimationFrame(callback),
  cancelFrame: (frameId: number) => void = (frameId) => window.cancelAnimationFrame(frameId),
): () => void {
  scrollRemoteConnectionLogsToLatest(viewport);
  const frameId = scheduleFrame(() => scrollRemoteConnectionLogsToLatest(viewport));
  return () => cancelFrame(frameId);
}

export function ReconnectingRemoteWorkspaceLogTooltip({
  logs,
  children,
}: {
  logs: RemoteConnectionLogEntry[];
  children?: ReactElement;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const logViewportRef = useRef<HTMLDivElement | null>(null);
  const cancelScheduledScrollRef = useRef<() => void>(() => {});

  const scrollLogsToLatest = useCallback((viewport: HTMLDivElement) => {
    cancelScheduledScrollRef.current();

    // Tooltip 每次 hover 都会重新展示日志浮层，浏览器默认从 scrollTop=0 开始。
    // 连接日志需要优先看到最新进度，因此在节点挂载时先滚一次，并在下一帧布局稳定后再补滚一次。
    cancelScheduledScrollRef.current = scheduleRemoteConnectionLogsScrollToLatest(viewport);
  }, []);

  const setLogViewportRef = useCallback(
    (viewport: HTMLDivElement | null) => {
      logViewportRef.current = viewport;
      if (viewport) {
        scrollLogsToLatest(viewport);
      }
    },
    [scrollLogsToLatest],
  );

  useEffect(() => {
    if (open && logViewportRef.current) {
      scrollLogsToLatest(logViewportRef.current);
    }

    return undefined;
  }, [logs.length, open, scrollLogsToLatest]);

  useEffect(() => () => cancelScheduledScrollRef.current(), []);

  return (
    <TooltipProvider>
      <Tooltip onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          {children ? (
            children
          ) : (
            // 远程 workspace 在后台重连时，用户之前只能看到“连接中”，
            // 无法判断当前是否卡住、卡在哪一步。这里给连接中指示补充 hover 日志，
            // 让用户在不打断流程的情况下看到实时进展。
            <div
              className="flex shrink-0 items-center gap-1 text-ui-base text-foreground-subtle"
              aria-label={intl.formatMessage({
                id: "workspaceSidebar.connecting",
              })}
            >
              <LoaderCircle className="h-3 w-3 animate-spin" />
              <span>{intl.formatMessage({ id: "workspaceSidebar.connecting" })}</span>
            </div>
          )}
        </TooltipTrigger>
        <TooltipContent
          side="right"
          align="start"
          sideOffset={6}
          className="w-[min(24rem,calc(100vw-1rem))] max-w-[min(24rem,calc(100vw-1rem))] overflow-hidden px-3 py-2"
        >
          <div className="space-y-2">
            <div className="text-ui-sm font-medium text-tooltip-foreground">
              {intl.formatMessage({ id: "remote.connectionLog" })}
            </div>
            <div
              ref={setLogViewportRef}
              className="max-h-56 space-y-1 overflow-x-hidden overflow-y-auto font-mono text-ui-sm"
            >
              {logs.length > 0 ? (
                logs.map((entry) => (
                  <div key={entry.id} className="flex min-w-0 items-start leading-5">
                    <span className="shrink-0 text-tooltip-foreground/60">{entry.timestamp}</span>
                    <span
                      className={cn(
                        "mx-2 shrink-0",
                        entry.level === "success"
                          ? "text-success"
                          : entry.level === "warn"
                            ? "text-warning"
                            : entry.level === "error"
                              ? "text-destructive"
                              : "text-tooltip-foreground/70",
                      )}
                    >
                      [{entry.level.toUpperCase()}]
                    </span>
                    <span className="min-w-0 flex-1 break-all whitespace-pre-wrap text-tooltip-foreground">
                      {entry.message}
                    </span>
                  </div>
                ))
              ) : (
                <div className="text-tooltip-foreground/70">
                  [INFO] {intl.formatMessage({ id: "remote.connectionLogEmpty" })}
                </div>
              )}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
