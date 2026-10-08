import type { UsageEntitlementSnapshot } from "@zcode/shared";
import { hasActiveCodingPlanSnapshot } from "@/CodingPlanUsageRemainingPanel.js";

type SidebarFooterProfilePlanBadge =
  | {
      audience: "individual";
      snapshot: UsageEntitlementSnapshot;
    }
  | {
      audience: "team";
      snapshot?: never;
    };

export function resolveSidebarFooterProfilePlanBadge({
  hasTeamPlanEntitlement,
  individualEntitlements,
}: {
  hasTeamPlanEntitlement: boolean;
  individualEntitlements: Array<{
    providerId: string;
    snapshot: UsageEntitlementSnapshot | null;
    loading?: boolean;
  }>;
}): SidebarFooterProfilePlanBadge | null {
  const activeIndividualEntitlement = individualEntitlements.find((entitlement) =>
    hasActiveCodingPlanSnapshot(entitlement.snapshot, entitlement.providerId),
  );
  if (activeIndividualEntitlement?.snapshot) {
    return {
      audience: "individual",
      snapshot: activeIndividualEntitlement.snapshot,
    };
  }

  if (individualEntitlements.some((entitlement) => entitlement.loading)) {
    return null;
  }

  // 头像旁徽标只展示已确认的权益。个人权益显示套餐等级；没有个人权益但有团队权益时才显示团队。
  // 不能把当前连接方式或历史 selectedKey 当作 Team 兜底，否则切换 family 后会误显示 Team。
  return hasTeamPlanEntitlement ? { audience: "team" } : null;
}

export function resolveSidebarFooterPlanBadgeLabel(
  snapshot: UsageEntitlementSnapshot | null,
): string | null {
  if (!snapshot || snapshot.unavailableReason === "no_plan") {
    return null;
  }

  const rawLabel =
    snapshot.quota?.level?.trim() || snapshot.subscription?.details[0]?.productName?.trim() || null;
  if (!rawLabel) {
    return null;
  }

  const withoutPrefix = rawLabel.replace(/^glm\s+coding\s+/i, "").trim();
  const normalized = withoutPrefix || rawLabel;
  return normalized.length > 0 ? normalizePlanBadgeWordCasing(normalized) : null;
}

function normalizePlanBadgeWordCasing(label: string): string {
  if (!/^[a-z][a-z0-9 -]*$/i.test(label)) {
    return label;
  }

  return label.replace(/\b[a-z][a-z0-9]*\b/gi, (word) => {
    if (word.length <= 1) {
      return word.toUpperCase();
    }
    return word.slice(0, 1).toUpperCase() + word.slice(1).toLowerCase();
  });
}
