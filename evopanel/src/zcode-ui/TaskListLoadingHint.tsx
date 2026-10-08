import { Spinner } from "@/components/ui/spinner.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function TaskListLoadingHint() {
  const { intl } = useZCodeIntl();

  return (
    <div className="flex items-center gap-2 px-2.5 py-1 text-ui-base text-foreground-subtlest">
      <Spinner className="size-4 text-foreground-subtlest" />
      <span>{intl.formatMessage({ id: "taskList.loading" })}</span>
    </div>
  );
}
