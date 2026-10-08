import { HardDrive } from "lucide-react";
import {
  type StorageVolumeGroup,
  TID_RESOURCE_MANAGER_STORAGE_DISK_CARD,
  TID_RESOURCE_MANAGER_STORAGE_ROOT,
  testId,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatBytes } from "@/resource-manager/resourceUsageView.js";
import { storageCategoryTitleId, type StorageLegendItem } from "./storageCategoryPresentation.js";

export function StorageDiskCard({
  group,
  index,
  legend,
  selected,
  selectable,
  onSelect,
}: {
  group: StorageVolumeGroup;
  index: number;
  legend: StorageLegendItem[];
  selected: boolean;
  selectable: boolean;
  onSelect: () => void;
}) {
  const { intl } = useZCodeIntl();
  const label =
    group.volume?.mountPoint ?? intl.formatMessage({ id: "resourceManager.storage.disk" });
  const body = (
    <>
      <div className="flex items-center gap-2 text-ui-base font-medium text-foreground">
        <HardDrive className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
        <span className="truncate" title={label}>
          {label}
        </span>
      </div>
      <div
        className="mt-4 flex h-2 w-full overflow-hidden rounded-full bg-surface"
        aria-hidden="true"
      >
        {legend.map((item) =>
          group.bytes > 0 ? (
            <div
              key={item.id}
              className="h-full"
              style={{ width: `${(item.bytes / group.bytes) * 100}%`, backgroundColor: item.color }}
            />
          ) : null,
        )}
      </div>
      <div className="mt-2 text-ui-caption text-foreground-subtle">
        {intl.formatMessage(
          { id: "resourceManager.storage.diskUsage" },
          { used: formatBytes(group.bytes) },
        )}
        {" · "}
        {group.volume
          ? intl.formatMessage(
              { id: "resourceManager.storage.diskFree" },
              {
                free: formatBytes(group.volume.freeBytes),
                total: formatBytes(group.volume.totalBytes),
              },
            )
          : intl.formatMessage({ id: "resourceManager.storage.diskUnknown" })}
      </div>
      <ul className="mt-3 space-y-1.5">
        {legend.map((item) => (
          <li key={item.id} className="flex items-center gap-2 text-ui-base">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: item.color }}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate text-foreground-subtle">
              {item.id === "rest"
                ? intl.formatMessage(
                    { id: "resourceManager.storage.legendMore" },
                    { count: item.restCount ?? 0 },
                  )
                : intl.formatMessage({ id: storageCategoryTitleId(item.id) })}
            </span>
            <span className="tabular-nums text-foreground">{formatBytes(item.bytes)}</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 border-t border-border pt-3">
        <div className="text-ui-caption font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "resourceManager.storage.roots" })}
        </div>
        <ul className="mt-1.5 space-y-1">
          {group.roots.map((root) => (
            <li
              key={root.id}
              data-testid={testId(TID_RESOURCE_MANAGER_STORAGE_ROOT, root.id)}
              className="flex items-center gap-2 text-ui-caption"
            >
              <span
                className="min-w-0 flex-1 truncate font-mono text-foreground-subtle"
                title={root.path}
              >
                {root.path}
              </span>
              <span className="tabular-nums text-foreground">{formatBytes(root.bytes)}</span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
  const className = cn(
    "w-full rounded-xl border border-card-border bg-card p-4 text-left",
    selectable && "cursor-pointer transition-colors hover:bg-surface-hover",
    selected && selectable && "bg-card-selected border-brand",
  );
  return selectable ? (
    <button
      type="button"
      data-testid={testId(TID_RESOURCE_MANAGER_STORAGE_DISK_CARD, String(index))}
      data-selected={selected ? "true" : "false"}
      className={className}
      onClick={onSelect}
    >
      {body}
    </button>
  ) : (
    <div
      data-testid={testId(TID_RESOURCE_MANAGER_STORAGE_DISK_CARD, String(index))}
      className={className}
    >
      {body}
    </div>
  );
}
