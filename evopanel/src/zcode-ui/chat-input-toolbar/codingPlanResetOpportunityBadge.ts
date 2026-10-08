import type { CodingPlanUsageRemainingState } from "@/CodingPlanUsageRemainingPanel.js";
import type { CodingPlanQuotaResetUiController } from "@/hooks/useCodingPlanQuotaResetUi.js";
import {
  findCodingPlanQuotaLimit,
  isCodingPlanQuotaLimitFull,
} from "@/lib/codingPlanQuotaPresentation.js";
import {
  mergeCodingPlanQuotaResetOpportunityBadges,
  resolveCodingPlanQuotaResetLimit,
} from "@/lib/codingPlanQuotaResetUi.js";

export function resolveChatCodingPlanResetOpportunityBadge(
  state: CodingPlanUsageRemainingState | null,
  resetUi: Pick<CodingPlanQuotaResetUiController, "entry" | "opportunityVisible" | "week">,
) {
  const limits = state?.visibleSnapshot?.quota?.limits ?? [];
  const fiveHourTokenLimit = resolveCodingPlanQuotaResetLimit(
    findCodingPlanQuotaLimit(limits, "TOKENS_LIMIT", 3, 5),
    resetUi.entry,
  );
  const weeklyTokenLimit = resolveCodingPlanQuotaResetLimit(
    findCodingPlanQuotaLimit(limits, "TOKENS_LIMIT", 6),
    resetUi.week.entry,
  );

  return mergeCodingPlanQuotaResetOpportunityBadges([
    {
      count: resetUi.entry?.opportunityCount ?? 0,
      expiresAt: resetUi.entry?.opportunityExpiresAt ?? null,
      visible:
        Boolean(fiveHourTokenLimit) &&
        resetUi.opportunityVisible &&
        !isCodingPlanQuotaLimitFull(fiveHourTokenLimit),
    },
    {
      count: resetUi.week.entry?.opportunityCount ?? 0,
      expiresAt: resetUi.week.entry?.opportunityExpiresAt ?? null,
      visible:
        Boolean(weeklyTokenLimit) &&
        resetUi.week.opportunityVisible &&
        !isCodingPlanQuotaLimitFull(weeklyTokenLimit),
    },
  ]);
}
