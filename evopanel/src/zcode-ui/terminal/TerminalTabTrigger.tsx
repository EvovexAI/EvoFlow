import { X } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { TabsTrigger } from "@/components/ui/tabs.js";
import type { TerminalSessionDescriptor } from "@/terminal/terminalPanelState.js";

export function TerminalTabTrigger({
  session,
  title,
  closeLabel,
  isActive,
  onClose,
}: {
  session: TerminalSessionDescriptor;
  title: string;
  closeLabel: string;
  isActive: boolean;
  onClose: (sessionId: string) => void;
}) {
  return (
    <TabsTrigger value={session.id} asChild>
      <div
        data-active={isActive ? "" : undefined}
        data-state={isActive ? "active" : "inactive"}
        className={cn(
          "group relative inline-flex !h-7 w-auto max-w-36 min-w-0 flex-none shrink-0 cursor-default items-center justify-start gap-1 overflow-hidden whitespace-nowrap rounded-lg border !border-transparent !bg-transparent pl-2 pr-1 text-ui-base font-medium text-foreground-subtle transition-all",
          "hover:text-foreground",
          !isActive && "hover:!bg-hover",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring",
          "data-active:!bg-selected data-active:text-foreground",
        )}
      >
        <span
          data-terminal-tab-content=""
          className="flex min-w-0 flex-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,black_calc(100%-0.5rem),transparent)]"
        >
          <span className="shrink-0 whitespace-nowrap">{title}</span>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={closeLabel}
          className={cn(
            "shrink-0 rounded-md",
            !isActive &&
              "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
          )}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onClose(session.id);
          }}
        >
          <X className="size-3" />
        </Button>
      </div>
    </TabsTrigger>
  );
}
