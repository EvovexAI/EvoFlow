import { CircleIcon } from "lucide-react";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const presentation = {
  disabled: { label: "settings.modelProvider.disabledStatus", color: "text-foreground-subtlest" },
  unavailable: { label: "settings.modelProvider.unavailableStatus", color: "text-warning" },
  ready: { label: "settings.modelProvider.readyStatus", color: "text-success" },
} as const;

export function ProviderStatusIndicator({
  provider,
}: {
  provider?: Pick<ProviderSettingsFormProvider, "enabled" | "executable"> | null;
}) {
  const { intl } = useZCodeIntl();
  // 只做展示映射，不能在 UI 再检查 Key、权益或模型成员。
  const status =
    provider?.enabled === false ? "disabled" : provider?.executable ? "ready" : "unavailable";
  const { label, color } = presentation[status];
  return (
    <CircleIcon
      data-provider-status={status}
      aria-label={intl.formatMessage({ id: label })}
      className={`size-2 shrink-0 fill-current max-md:absolute max-md:right-1 max-md:bottom-1 max-md:rounded-full max-md:ring-2 max-md:ring-card ${color}`}
    />
  );
}
