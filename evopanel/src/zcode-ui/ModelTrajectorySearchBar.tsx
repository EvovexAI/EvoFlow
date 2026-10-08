import { ArrowDownIcon, ArrowUpIcon, SearchIcon, XIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button.js";
import type { IntlShape } from "@/ModelTrajectoryPaneParts.js";

export function ModelTrajectorySearchBar({
  query,
  activeIndex,
  matchCount,
  onQueryChange,
  onMove,
  onClose,
  intl,
}: {
  query: string;
  activeIndex: number;
  matchCount: number;
  onQueryChange: (query: string) => void;
  onMove: (direction: "previous" | "next") => void;
  onClose: () => void;
  intl: IntlShape;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const previousLabel = intl.formatMessage({ id: "modelTrajectory.searchPrevious" });
  const nextLabel = intl.formatMessage({ id: "modelTrajectory.searchNext" });
  const closeLabel = intl.formatMessage({ id: "modelTrajectory.searchClose" });
  const disabled = matchCount === 0;

  return (
    <div
      data-trajectory-search-bar=""
      className="mt-2 flex h-8 min-w-0 items-center gap-1.5 rounded-lg border border-input-border bg-input px-2"
    >
      <SearchIcon className="size-3.5 shrink-0 text-foreground-subtle" aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "Enter") {
            event.preventDefault();
            onMove(event.shiftKey ? "previous" : "next");
          }
        }}
        placeholder={intl.formatMessage({ id: "modelTrajectory.searchPlaceholder" })}
        aria-label={intl.formatMessage({ id: "modelTrajectory.search" })}
        className="min-w-0 flex-1 bg-transparent text-ui-sm text-foreground outline-none placeholder:text-foreground-subtlest [&::-webkit-search-cancel-button]:appearance-none"
      />
      <span className="w-12 shrink-0 text-center font-mono text-ui-xs tabular-nums text-foreground-subtle">
        {matchCount > 0 ? `${activeIndex + 1}/${matchCount}` : "0/0"}
      </span>
      <span className="flex shrink-0 items-center gap-0.5 border-l border-border pl-1.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={disabled}
          aria-label={previousLabel}
          title={previousLabel}
          onClick={() => onMove("previous")}
        >
          <ArrowUpIcon className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={disabled}
          aria-label={nextLabel}
          title={nextLabel}
          onClick={() => onMove("next")}
        >
          <ArrowDownIcon className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={closeLabel}
          title={closeLabel}
          onClick={onClose}
        >
          <XIcon className="size-3.5" />
        </Button>
      </span>
    </div>
  );
}
