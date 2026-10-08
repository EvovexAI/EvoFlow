import { ChevronLeftIcon, ChevronRightIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function EmbeddedWebsiteHeader({
  title,
  loading,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  onReload,
  onClose,
}: {
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <header className="bg-background px-6 py-4 pb-0 max-sm:px-4">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 rounded-lg"
              aria-label={intl.formatMessage({ id: "quickPick.command.goBack" })}
              disabled={!canGoBack}
              onClick={onBack}
            >
              <ChevronLeftIcon className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 rounded-lg"
              aria-label={intl.formatMessage({ id: "quickPick.command.goForward" })}
              disabled={!canGoForward}
              onClick={onForward}
            >
              <ChevronRightIcon className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 rounded-lg"
              aria-label={intl.formatMessage({ id: "common.refresh" })}
              onClick={onReload}
            >
              <RefreshCwIcon className={cn("size-4", loading && "animate-spin")} />
            </Button>
          </div>
          <h2 className="truncate text-ui-lg font-medium">{title}</h2>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          className="rounded-xl"
          aria-label={intl.formatMessage({ id: "common.close" })}
          onClick={onClose}
        >
          <XIcon className="size-4" />
        </Button>
      </div>
    </header>
  );
}
