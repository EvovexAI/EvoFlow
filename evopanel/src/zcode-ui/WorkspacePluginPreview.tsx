import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import {
  compareDocumentPluginPriority,
  isPublicStoreMarketplaceId,
  resolvePluginDisplayName,
  sortPluginStoreEntries,
} from "@zcode/shared";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem,
} from "@/components/ui/command.js";
import { PluginIcon } from "@/components/PluginIcon.js";
import { usePluginReferenceCatalog } from "@/hooks/usePluginReferenceCatalog.js";
import { requestPluginStoreOpen } from "@/lib/pluginStoreNavigation.js";
import { buildPluginMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { Button } from "@/components/ui/button.js";
import { usePluginStoreOrder } from "@/hooks/usePluginStoreOrder.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";

type WorkspacePluginPreviewEntry = ReturnType<typeof usePluginReferenceCatalog>["entries"][number];

function isWorkspacePluginReferenceable(entry: WorkspacePluginPreviewEntry): boolean {
  return entry.enabled && entry.conflictingPluginIds.length === 0;
}

function buildWorkspacePluginMention(entry: WorkspacePluginPreviewEntry): ComposerMentionPrefill {
  return {
    id: `plugin:${entry.pluginId}`,
    category: "plugins",
    // canonical mention 使用 manifest name；本地化显示名只用于菜单展示。
    label: entry.name,
    value: entry.pluginId,
    markdown: buildPluginMentionMarkdown(entry.name, entry.pluginId),
    data: {
      pluginId: entry.pluginId,
      ...(entry.icon ? { icon: entry.icon } : {}),
    },
  };
}

export function WorkspacePluginPreview({
  onOpen,
  onSelectPlugin,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
}: {
  onOpen: () => void;
  onSelectPlugin: (mention: ComposerMentionPrefill) => void;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}) {
  const { intl, locale } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const { order } = usePluginStoreOrder();
  const [open, setOpen] = useState(false);
  const [retryRevision, setRetryRevision] = useState(0);
  const [lastCatalog, setLastCatalog] = useState<{
    workspaceKey: string;
    entries: ReturnType<typeof usePluginReferenceCatalog>["entries"];
  } | null>(null);
  const workspaceKey = `${workspaceIdentity?.trim() || workspacePath}|${remoteSessionId ?? "local"}`;
  const { entries, authority, loading, error } = usePluginReferenceCatalog(
    workspacePath,
    workspaceIdentity,
    null,
    true,
    {
      preferredRemoteSessionId: remoteSessionId,
      refreshRevision: retryRevision,
    },
  );
  useEffect(() => {
    if (authority !== null) setLastCatalog({ workspaceKey, entries });
  }, [authority, entries, workspaceKey]);
  // 刷新时目录 hook 会隔离旧请求；仅为同一 workspace 保留已成功加载的缩略图。
  const previewEntries =
    authority === null && lastCatalog?.workspaceKey === workspaceKey
      ? lastCatalog.entries
      : entries;
  const visibleEntries = useMemo(() => {
    const modeOrder = isOfficeMode ? order?.work : order?.code;
    const referenceableEntries = previewEntries.filter(isWorkspacePluginReferenceable);
    const publicEntries = sortPluginStoreEntries(
      referenceableEntries.filter((entry) => isPublicStoreMarketplaceId(entry.marketplace)),
      (entry) => ({
        id: entry.pluginId,
        category: entry.category,
        displayName: resolvePluginDisplayName(
          {
            name: entry.name,
            listing: {
              displayName: entry.displayName,
              displayNameI18n: entry.displayNameI18n,
            },
          },
          locale,
        ),
      }),
      locale,
      modeOrder,
    );
    return [
      ...publicEntries.toSorted((left, right) =>
        compareDocumentPluginPriority(left.pluginId, right.pluginId),
      ),
      ...referenceableEntries.filter((entry) => !isPublicStoreMarketplaceId(entry.marketplace)),
    ];
  }, [previewEntries, isOfficeMode, locale, order]);
  const browse = (pluginId?: string) => {
    setOpen(false);
    requestPluginStoreOpen(pluginId);
    onOpen();
  };
  const selectPlugin = (entry: (typeof visibleEntries)[number]) => {
    setOpen(false);
    onSelectPlugin(buildWorkspacePluginMention(entry));
  };
  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen && !loading) setRetryRevision((current) => current + 1);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="default"
          className="shrink-0 gap-1.5 rounded-full bg-transparent pl-3 pr-2 text-ui-base/relaxed text-foreground hover:bg-surface-hover focus-visible:bg-surface-hover"
          data-workspace-plugin-preview=""
        >
          <span className="isolate flex shrink-0 items-center -space-x-1" aria-hidden="true">
            {visibleEntries.slice(0, 3).map((entry) => (
              <PluginIcon
                key={entry.pluginId}
                pluginId={entry.pluginId}
                src={entry.icon}
                className="relative size-5 shrink-0 rounded-lg bg-card ring-1 ring-inset ring-border/30 [&>img]:size-4"
                iconClassName="size-4"
              />
            ))}
          </span>
          <span className="whitespace-nowrap">
            {intl.formatMessage({ id: "settings.plugin.tab.plugins" })}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        className="w-72 max-w-[calc(100vw-2rem)] gap-0 rounded-2xl bg-menu p-0 shadow-xs"
      >
        <Command className="bg-menu pb-0 [&_[data-slot=command-input-wrapper]]:border-b-0 [&_[data-slot=command-input-wrapper]]:p-0">
          <CommandInput
            placeholder={intl.formatMessage({
              id: "settings.plugin.plugins.searchPlaceholder",
            })}
          />
          <CommandList
            className="h-64 max-h-[min(16rem,calc(var(--radix-popover-content-available-height,100vh)-7rem))]"
            aria-busy={loading}
          >
            {loading ? (
              <div role="status" aria-label={intl.formatMessage({ id: "common.loading" })}>
                {Array.from({ length: 8 }, (_, index) => (
                  <div
                    key={index}
                    aria-hidden="true"
                    className="my-px flex h-8 items-center gap-3 px-3 motion-safe:animate-pulse"
                  >
                    <span className="size-5 shrink-0 rounded-md bg-surface-hover" />
                    <span className="h-3 w-28 rounded-sm bg-surface-hover" />
                  </div>
                ))}
              </div>
            ) : error ? (
              <div role="status" className="p-3 text-ui-caption text-foreground-subtle">
                {intl.formatMessage({ id: "chat.plugins.loadError" })}
              </div>
            ) : (
              <>
                <CommandEmpty>
                  {intl.formatMessage({
                    id: visibleEntries.length
                      ? "settings.plugins.store.searchEmpty"
                      : "settings.plugin.plugins.emptyInstalledTitle",
                  })}
                </CommandEmpty>
                {visibleEntries.map((entry) => {
                  const name = resolvePluginDisplayName(
                    {
                      name: entry.name,
                      listing: {
                        displayName: entry.displayName,
                        displayNameI18n: entry.displayNameI18n,
                      },
                    },
                    locale,
                  );
                  return (
                    <CommandItem
                      key={entry.pluginId}
                      value={entry.pluginId}
                      keywords={[name, entry.name, ...Object.values(entry.displayNameI18n ?? {})]}
                      onSelect={() => selectPlugin(entry)}
                      className="my-px h-8 gap-3 rounded-xl px-3 py-0 hover:bg-hover data-selected:bg-selected"
                    >
                      <PluginIcon
                        pluginId={entry.pluginId}
                        src={entry.icon}
                        className="size-5 rounded-lg bg-card ring-1 ring-inset ring-border/30 [&>img]:size-4"
                        iconClassName="size-4"
                      />
                      <span className="truncate">{name}</span>
                    </CommandItem>
                  );
                })}
              </>
            )}
          </CommandList>
        </Command>
        <div className="mx-1 mt-3 border-t border-border py-1">
          <Button
            variant="ghost"
            className="h-8 w-full justify-between rounded-xl px-3 py-1 text-ui-base/relaxed"
            onClick={() => browse()}
          >
            {intl.formatMessage({ id: "chat.plugins.browseMarketplace" })}
            <ArrowUpRight className="size-4" />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
