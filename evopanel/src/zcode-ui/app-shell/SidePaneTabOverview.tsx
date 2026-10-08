import { useEffect, useMemo, useState } from "react";
import { ChevronsDownIcon, XIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import {
  buildSearchFields,
  filterAndRankSearchItems,
  normalizeSearchQuery,
} from "@/app-shell/sidePaneTabSearch.js";
import { SidePaneTabIcon } from "@/app-shell/SidePaneTabTrigger.js";
import {
  getLocalizedSidePaneTabTitle,
  getSidePaneTabSearchHint,
  getSidePaneTabTypeLabel,
  type SidePaneTabPresentationLabels,
} from "@/app-shell/sidePaneTabPresentation.js";
import type { RecentClosedSidePaneTab } from "@/hooks/useAppPanels.js";
import type { WorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";

export function SidePaneTabOverview({
  tabs,
  activeTabId,
  recentClosedTabs,
  labels,
  onActivateTab,
  onCloseTab,
  onReopenClosedTab,
}: {
  tabs: WorkspaceSidePaneTab[];
  activeTabId: string;
  recentClosedTabs: RecentClosedSidePaneTab[];
  labels: SidePaneTabPresentationLabels & {
    title: string;
    searchPlaceholder: string;
    openTabs: string;
    recentlyClosedTabs: string;
    noResults: string;
    closeTab: (title: string) => string;
    relativeTime: (timestamp: number) => string;
  };
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onReopenClosedTab: (tabId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const queryParts = useMemo(() => normalizeSearchQuery(query), [query]);
  const tabItems = useMemo(
    () =>
      tabs.map((tab) => {
        const title = getLocalizedSidePaneTabTitle(tab, labels);
        const hint = getSidePaneTabSearchHint(tab);
        const typeLabel = getSidePaneTabTypeLabel(tab, labels);
        return {
          tab,
          title,
          hint,
          openedAtLabel: labels.relativeTime(tab.openedAt ?? currentTime),
          searchFields: buildSearchFields(title, hint, typeLabel),
        };
      }),
    [
      currentTime,
      labels.browserTitle,
      labels.codeViewerTitle,
      labels.relativeTime,
      labels.reviewTitle,
      labels.treemappingTitle,
      labels.whiteboardTitle,
      labels.developerToolsTitle,
      labels.terminalTitle,
      labels.subagentTypeLabel,
      tabs,
    ],
  );
  const recentClosedItems = useMemo(
    () =>
      recentClosedTabs.map((item) => {
        const title = getLocalizedSidePaneTabTitle(item.tab, labels);
        const hint = getSidePaneTabSearchHint(item.tab);
        const typeLabel = getSidePaneTabTypeLabel(item.tab, labels);
        return {
          item,
          title,
          hint,
          closedAtLabel: labels.relativeTime(item.closedAt),
          searchFields: buildSearchFields(title, hint, typeLabel),
        };
      }),
    [
      currentTime,
      labels.browserTitle,
      labels.codeViewerTitle,
      labels.relativeTime,
      labels.reviewTitle,
      labels.treemappingTitle,
      labels.whiteboardTitle,
      labels.developerToolsTitle,
      labels.terminalTitle,
      labels.subagentTypeLabel,
      recentClosedTabs,
    ],
  );
  const filteredTabItems = useMemo(
    () => filterAndRankSearchItems(tabItems, queryParts),
    [queryParts, tabItems],
  );
  const filteredRecentClosedItems = useMemo(
    () => filterAndRankSearchItems(recentClosedItems, queryParts),
    [queryParts, recentClosedItems],
  );
  const hasAnySearchResult = filteredTabItems.length > 0 || filteredRecentClosedItems.length > 0;

  useEffect(() => {
    if (!open) {
      return;
    }

    setCurrentTime(Date.now());
    const interval = window.setInterval(() => setCurrentTime(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, [open]);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setQuery("");
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          className="shrink-0"
          aria-label={labels.title}
        >
          <ChevronsDownIcon className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 gap-0 bg-menu p-0">
        <Command
          // 旧搜索菜单手写输入框、标题和列表项，和模型选择菜单的 Command 视觉体系不一致。
          // 这里复用 Command 容器统一搜索框、分组标题、hover 和键盘选中态，同时保留现有 ranking 逻辑。
          shouldFilter={false}
          className="bg-transparent p-0 text-foreground"
        >
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={labels.searchPlaceholder}
            className="h-8"
          />
          <CommandList className="max-h-80">
            {!hasAnySearchResult ? (
              <CommandGroup
                heading={labels.openTabs}
                className="border-border border-b p-1 last:border-b-0 **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-2 **:[[cmdk-group-heading]]:text-ui-base **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-foreground-subtle"
              >
                <CommandEmpty className="px-4 py-5 text-foreground-subtle">
                  {labels.noResults}
                </CommandEmpty>
              </CommandGroup>
            ) : null}

            {filteredTabItems.length > 0 ? (
              <CommandGroup
                heading={labels.openTabs}
                className="border-border border-b p-1 last:border-b-0 **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-2 **:[[cmdk-group-heading]]:text-ui-base **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-foreground-subtle"
              >
                {filteredTabItems.map(({ tab, title, openedAtLabel }) => {
                  const isActive = tab.id === activeTabId;
                  return (
                    <CommandItem
                      key={tab.id}
                      value={title}
                      className={cn(
                        "mb-0.5 min-h-8 cursor-pointer gap-2 px-2 text-ui-base last:mb-0",
                        isActive && "bg-selected data-selected:bg-selected",
                      )}
                      onSelect={() => {
                        onActivateTab(tab.id);
                        setOpen(false);
                      }}
                    >
                      <span className="flex size-5 shrink-0 items-center justify-center text-foreground-subtle">
                        <SidePaneTabIcon tab={tab} />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
                        {title}
                      </span>
                      <span className="mr-0.5 shrink-0 text-ui-base text-foreground-subtle">
                        {openedAtLabel}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={labels.closeTab(title)}
                        className="shrink-0 opacity-70 hover:opacity-100"
                        onPointerDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onCloseTab(tab.id);
                        }}
                      >
                        <XIcon className="size-3" />
                      </Button>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ) : null}

            {filteredRecentClosedItems.length > 0 ? (
              <CommandGroup
                heading={labels.recentlyClosedTabs}
                className="border-border border-b p-1 last:border-b-0 **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-2 **:[[cmdk-group-heading]]:text-ui-base **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-foreground-subtle"
              >
                {filteredRecentClosedItems.map(({ item, title, closedAtLabel }) => (
                  <CommandItem
                    key={item.tab.id}
                    value={title}
                    className="mb-0.5 min-h-8 cursor-pointer gap-2 px-2 text-ui-base last:mb-0"
                    onSelect={() => {
                      onReopenClosedTab(item.tab.id);
                      setOpen(false);
                    }}
                  >
                    <span className="flex size-5 shrink-0 items-center justify-center text-foreground-subtle">
                      <SidePaneTabIcon tab={item.tab} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
                      {title}
                    </span>
                    <span className="mr-0.5 shrink-0 text-ui-base text-foreground-subtle">
                      {closedAtLabel}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
