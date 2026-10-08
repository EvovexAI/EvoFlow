import type { SkillSyncImportResult } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function RemoteSkillSyncResultList({ result }: { result: SkillSyncImportResult | null }) {
  const { intl } = useZCodeIntl();
  if (!result) {
    return null;
  }

  return (
    <div className="grid gap-2">
      <div className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-base text-foreground">
        {intl.formatMessage({ id: "settings.skills.remoteSync.complete" })}
      </div>
      {result.results.map((item) => (
        <div
          key={item.directoryName}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-base"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium text-foreground">{item.name}</span>
            <span className="text-foreground-subtle">
              {intl.formatMessage({ id: `settings.skills.remoteSync.${item.status}` })}
            </span>
          </div>
          {item.error ? (
            <div className="mt-1 break-words text-ui-base text-destructive">{item.error}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
