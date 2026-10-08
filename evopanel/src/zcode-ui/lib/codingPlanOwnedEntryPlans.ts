import { BUILTIN_MODEL_PROVIDER_IDS, type UsageEntitlementSnapshot } from "@zcode/shared";

const startIds: readonly string[] = [
  BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
  BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
];
const personalIds: readonly string[] = [
  BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
  BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
];
const normalize = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

export function buildOwnedEntryPlanList({
  snapshots,
  teamProducts,
}: {
  snapshots: readonly (UsageEntitlementSnapshot | null | undefined)[];
  teamProducts: readonly { subscribed?: boolean | null; tier: string; productId: string }[];
}): string {
  const plans = snapshots.flatMap((snapshot) => {
    if (
      !snapshot?.authenticated ||
      snapshot.unavailableReason ||
      snapshot.context?.scope === "team"
    )
      return [];
    const providerId = snapshot.provider?.id ?? "";
    const isStart = startIds.includes(providerId);
    if (!isStart && !personalIds.includes(providerId)) return [];
    return (snapshot.subscription?.details ?? []).flatMap((detail) => {
      if (detail.expireTime && Date.parse(detail.expireTime) <= Date.now()) return [];
      const key = normalize(detail.productId || detail.productName);
      if (!key) return [];
      // 原实现把被点击卡片的套餐状态应用到整组数据；每个连接必须独立分类。
      if (isStart) return [`start_plan__${key}`];
      const label = normalize(`${detail.productId} ${detail.productName}`);
      const tier = /(?:^|_)(max|pro|lite)(?:_|$)/.exec(label)?.[1] ?? key;
      return [`coding_plan__personal_${tier}`];
    });
  });
  for (const product of teamProducts) {
    const key = normalize(product.tier || product.productId);
    if (product.subscribed === true && key) plans.push(`coding_plan__team_${key}`);
  }
  return [...new Set(plans)].sort().join(",");
}
