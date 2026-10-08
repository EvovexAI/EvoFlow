import type { CodingPlanResetType } from "@zcode/shared";
import type {
  CodingPlanQuotaResetDialogConfig,
  CodingPlanQuotaResetDialogResetItem,
  CodingPlanQuotaResetDialogUsageItem,
} from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetDialog.js";
import type { useCodingPlanQuotaResetUi } from "@/hooks/useCodingPlanQuotaResetUi.js";
import type { CodingPlanQuotaResetUiEntry } from "@/lib/codingPlanQuotaResetUi.js";

type CodingPlanQuotaResetUi = ReturnType<typeof useCodingPlanQuotaResetUi>;

function createResetItem(params: {
  enabled: boolean;
  entry: CodingPlanQuotaResetUiEntry | null;
  onReset: () => Promise<void>;
  opportunityVisible: boolean;
  processing: boolean;
  quotaFull: boolean;
  resetType: CodingPlanResetType;
}): CodingPlanQuotaResetDialogResetItem | null {
  const { enabled, entry, opportunityVisible, processing, quotaFull } = params;
  if (
    !enabled ||
    !entry ||
    (!processing && entry.status !== "completed" && (!opportunityVisible || quotaFull))
  ) {
    return null;
  }
  return {
    count: entry.opportunityCount,
    expiresAt: entry.opportunityExpiresAt,
    onReset: params.onReset,
    processing,
    resetType: params.resetType,
  };
}

export function buildCodingPlanQuotaResetDialogConfig(params: {
  fiveHourEnabled: boolean;
  fiveHourQuotaFull: boolean;
  resetUi: CodingPlanQuotaResetUi;
  usageItems: CodingPlanQuotaResetDialogUsageItem[];
  weekEnabled: boolean;
  weekQuotaFull: boolean;
}): CodingPlanQuotaResetDialogConfig {
  const { resetUi } = params;
  const resetItems = [
    createResetItem({
      enabled: params.fiveHourEnabled,
      entry: resetUi.entry,
      onReset: resetUi.reset,
      opportunityVisible: resetUi.opportunityVisible,
      processing: resetUi.processing,
      quotaFull: params.fiveHourQuotaFull,
      resetType: "FIVE_HOUR",
    }),
    createResetItem({
      enabled: params.weekEnabled,
      entry: resetUi.week.entry,
      onReset: resetUi.week.reset,
      opportunityVisible: resetUi.week.opportunityVisible,
      processing: resetUi.week.processing,
      quotaFull: params.weekQuotaFull,
      resetType: "WEEK",
    }),
  ].filter((item): item is CodingPlanQuotaResetDialogResetItem => item !== null);
  return { resetItems, usageItems: params.usageItems };
}
