import { AlertTriangle, Loader2, RefreshCw, Trash2 } from "lucide-react";
import type { ZCodePluginMarketplaceSummary } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveMarketplaceDisplayName } from "@/settings/pluginSourceLabel.js";
import {
  isPublicStoreMarketplaceId,
  sortMarketplaceSources,
} from "@/settings/pluginStoreListing.js";

// 官方市场不可移除：移除后启动时会被重新补种，只会造成「删了又回来」的困惑。
function isRemovableMarketplace(marketplace: ZCodePluginMarketplaceSummary): boolean {
  return !isPublicStoreMarketplaceId(marketplace.id);
}

function PluginStoreSourceRefreshFailure({
  failure,
}: {
  failure: NonNullable<ZCodePluginMarketplaceSummary["refreshFailure"]>;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div
      className="mt-1 flex min-w-0 items-start gap-1 text-ui-base text-destructive"
      data-testid="plugin-store-source-refresh-failure"
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">
        {intl.formatMessage(
          { id: "settings.plugins.store.sources.refreshFailed" },
          { time: formatSourceTime(failure.failedAt) },
        )}
        {`: ${failure.message}`}
      </span>
    </div>
  );
}

/** 顶栏齿轮 → 市场源管理：列出已登记市场，支持刷新与移除（新增走 New 按钮）。 */
export function PluginStoreSourcesDialog({
  open,
  onOpenChange,
  marketplaces,
  onUpdateMarketplace,
  onRemoveMarketplace,
  operationId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  marketplaces: ZCodePluginMarketplaceSummary[];
  onUpdateMarketplace: (marketplace: string) => void;
  onRemoveMarketplace: (marketplace: string) => void;
  operationId: string | null;
}) {
  const { intl, locale } = useZCodeIntl();
  const sortedMarketplaces = sortMarketplaceSources(marketplaces, locale);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(480px,calc(100vw-2rem))] max-w-none"
        data-testid="plugin-store-sources-dialog"
      >
        <DialogTitle className="text-ui-lg font-medium text-foreground">
          {intl.formatMessage({ id: "settings.plugins.store.sources.title" })}
        </DialogTitle>
        <div className="max-h-[min(420px,60vh)] space-y-1 overflow-y-auto">
          {sortedMarketplaces.length === 0 ? (
            <p className="px-1 py-2 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.plugins.store.sources.empty" })}
            </p>
          ) : (
            sortedMarketplaces.map((marketplace) => {
              const updating = operationId === `marketplace:update:${marketplace.id}`;
              const removing = operationId === `marketplace:remove:${marketplace.id}`;
              return (
                <div
                  key={marketplace.id}
                  data-testid="plugin-store-source-row"
                  data-marketplace-id={marketplace.id}
                  className="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-hover"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-ui-base font-medium text-foreground">
                        {resolveMarketplaceDisplayName(marketplace.id, [marketplace])}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-ui-base text-foreground-subtle">
                      {intl.formatMessage(
                        { id: "settings.plugins.store.sources.pluginCount" },
                        { count: String(marketplace.pluginCount) },
                      )}
                      {marketplace.lastUpdated
                        ? ` · ${intl.formatMessage(
                            { id: "settings.plugins.store.sources.lastUpdated" },
                            { time: formatSourceTime(marketplace.lastUpdated) },
                          )}`
                        : ""}
                    </div>
                    {marketplace.refreshFailure ? (
                      <PluginStoreSourceRefreshFailure failure={marketplace.refreshFailure} />
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    data-testid="plugin-store-source-update"
                    data-marketplace-id={marketplace.id}
                    variant="ghost"
                    size="icon-lg"
                    aria-label={intl.formatMessage({
                      id: "settings.plugins.store.sources.update",
                    })}
                    disabled={updating}
                    onClick={() => onUpdateMarketplace(marketplace.id)}
                  >
                    <RefreshCw
                      className={updating ? "size-3.5 animate-spin" : "size-3.5"}
                      aria-hidden="true"
                    />
                  </Button>
                  {isRemovableMarketplace(marketplace) ? (
                    <Button
                      type="button"
                      data-testid="plugin-store-source-remove"
                      data-marketplace-id={marketplace.id}
                      variant="ghost"
                      size="icon-lg"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      aria-label={intl.formatMessage({
                        id: "settings.plugins.store.sources.remove",
                      })}
                      disabled={removing}
                      onClick={() => onRemoveMarketplace(marketplace.id)}
                    >
                      {removing ? (
                        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                      ) : (
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      )}
                    </Button>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function formatSourceTime(value: string): string {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return value;
  return time.toLocaleString();
}
