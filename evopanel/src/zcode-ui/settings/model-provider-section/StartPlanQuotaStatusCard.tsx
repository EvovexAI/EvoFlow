import type { UsageQuotaLimit } from "@zcode/shared";
import { StartPlanBalanceCard } from "@/settings/model-provider-section/StartPlanBalanceCard.js";

export function StartPlanQuotaStatusCard({
  isChecking,
  limits,
  expireTime,
  embedded = false,
}: {
  isChecking: boolean;
  limits: UsageQuotaLimit[];
  expireTime?: string | null;
  embedded?: boolean;
}) {
  return (
    <StartPlanBalanceCard
      isChecking={isChecking}
      limits={limits}
      expireTime={expireTime}
      embedded={embedded}
    />
  );
}
