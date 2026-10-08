import { CircleDashed, Folder, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function SettingsScopeBadge({
  scope,
  label,
  includeMcpTestAttribute = false,
}: {
  scope: "default" | "user" | "workspace";
  label?: string;
  includeMcpTestAttribute?: boolean;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Badge
      variant="secondary"
      className="rounded-full border-border bg-surface text-ui-sm"
      data-settings-scope={scope}
      data-mcp-scope={includeMcpTestAttribute ? scope : undefined}
    >
      <span data-icon="inline-start" className="size-3.5" aria-hidden="true">
        {scope === "workspace" ? (
          <Folder className="size-full" />
        ) : scope === "user" ? (
          <UserRound className="size-full" />
        ) : (
          <CircleDashed className="size-full" />
        )}
      </span>
      {label ?? intl.formatMessage({ id: `settings.scope.${scope}` })}
    </Badge>
  );
}
