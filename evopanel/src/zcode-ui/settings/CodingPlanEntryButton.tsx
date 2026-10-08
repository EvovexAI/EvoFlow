import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";

export function useCodingPlanEntryGate() {
  const dialog = useOptionalCodingPlanUpgradeDialog();
  const { intl } = useZCodeIntl();
  const status = dialog?.inventory?.status ?? "ready";
  const label =
    status === "ready"
      ? undefined
      : intl.formatMessage({
          id: status === "loading" ? "purchase.entry.loading" : "purchase.entry.retry",
        });
  return { status, label, retry: dialog?.inventory?.retry };
}

/** 各入口共享同一查询状态；失败时按钮只重试，不继续执行购买动作。 */
export function CodingPlanEntryButton({
  children,
  disabled,
  onClick,
  bypassGate = false,
  ...props
}: ComponentProps<typeof Button> & { bypassGate?: boolean }) {
  const gate = useCodingPlanEntryGate();
  const status = bypassGate ? "ready" : gate.status;
  return (
    <Button
      {...props}
      disabled={disabled || status === "loading"}
      aria-label={status === "ready" ? props["aria-label"] : gate.label}
      aria-busy={status === "loading"}
      title={status === "ready" ? props.title : gate.label}
      onClick={(event) => {
        if (status === "error") {
          event.preventDefault();
          event.stopPropagation();
          gate.retry?.();
          return;
        }
        if (status === "ready") onClick?.(event);
      }}
    >
      {status === "ready" ? children : gate.label}
    </Button>
  );
}
