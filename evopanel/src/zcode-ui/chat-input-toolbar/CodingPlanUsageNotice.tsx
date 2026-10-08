import { InfoIcon, RefreshCwIcon } from "lucide-react";

export function CodingPlanUsageNotice({
  message,
  onRefresh,
  refreshLabel,
}: {
  message: string;
  onRefresh?: () => void | Promise<void>;
  refreshLabel: string;
}) {
  return (
    <div
      data-coding-plan-usage-notice="true"
      className="col-span-full flex w-full min-w-0 items-center gap-2 rounded-lg bg-surface px-2.5 py-2 text-ui-base text-foreground-subtle"
    >
      <InfoIcon className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-foreground">{message}</span>
      {onRefresh ? (
        <button
          type="button"
          aria-label={refreshLabel}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-foreground-subtle hover:bg-hover hover:text-foreground"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void onRefresh();
          }}
        >
          <RefreshCwIcon className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
