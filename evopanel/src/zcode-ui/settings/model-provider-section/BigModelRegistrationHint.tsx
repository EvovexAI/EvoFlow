import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function BigModelRegistrationHint({
  onOpenRegistration,
}: {
  onOpenRegistration?: () => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-ui-base text-foreground-subtle">
      {intl.formatMessage({
        id: "settings.modelProvider.codingPlan.bigmodel.unregisteredHint",
      })}
      {onOpenRegistration ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto p-0 text-ui-base/relaxed"
          onClick={onOpenRegistration}
        >
          {intl.formatMessage({
            id: "settings.modelProvider.codingPlan.bigmodel.registerAction",
          })}
        </Button>
      ) : null}
    </span>
  );
}

export function isBigModelUnregisteredAuthError(error: string | null | undefined): boolean {
  if (!error) {
    return false;
  }

  const normalized = error.toLowerCase();
  return (
    error.includes("BigModel 账号未注册") ||
    normalized.includes("bigmodel account is not registered") ||
    normalized.includes("not registered")
  );
}
