import { useZCodeIntl } from "@/i18n/IntlProvider.js";

interface SettingsResourceGroupHeaderProps {
  count: number;
  hint?: string;
  title: string;
}

export function SettingsResourceGroupHeader({
  count,
  hint,
  title,
}: SettingsResourceGroupHeaderProps) {
  const { intl } = useZCodeIntl();
  const itemCountLabel = intl.formatMessage(
    {
      id: count === 1 ? "settings.resourceGroup.item.one" : "settings.resourceGroup.item.other",
    },
    { count: String(count) },
  );

  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-1">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-ui-base font-medium text-foreground">{title}</span>
        <span className="shrink-0 text-ui-base text-foreground-subtlest">{itemCountLabel}</span>
      </div>
      {hint ? <div className="min-w-0 text-ui-base text-foreground-subtle">{hint}</div> : null}
    </div>
  );
}
