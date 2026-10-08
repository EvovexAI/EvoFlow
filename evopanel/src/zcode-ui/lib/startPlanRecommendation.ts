import { USAGE_ENTITLEMENT_ACCESS_REFRESH_MS } from "@/lib/usageEntitlementRefreshPolicy.js";
import { validateModelSelectionOptions, type ModelSelectionView } from "@zcode/provider";
import {
  isBuiltinModelProviderId,
  isStartPlanModelProviderId,
  resolveModelProviderFamilySpecByProviderId,
  type ModelSelection,
  type UsageEntitlementSnapshot,
} from "@zcode/shared";
import {
  bucketMatchesModel,
  bucketRemainingRatio,
  getActiveModelBuckets,
} from "@/v4/startPlanQuotaBuckets.js";

/** 只消费目标 Registry 与已有额度事实；未知额度跳过，不为提交增加查询门禁。 */
export function resolveStartPlanRecommendation(
  selection: ModelSelection,
  view: ModelSelectionView | null | undefined,
  snapshot: UsageEntitlementSnapshot | null,
): ModelSelection | null {
  if (
    !isBuiltinModelProviderId(selection.providerId) ||
    isStartPlanModelProviderId(selection.providerId)
  )
    return null;
  const family = resolveModelProviderFamilySpecByProviderId(selection.providerId);
  const provider = view?.providers.find((item) => item.providerId === family?.startPlanProviderId);
  const model = provider?.models.find((item) => item.modelId === selection.modelId);
  if (!provider || !model || !snapshot || snapshot.provider?.id !== provider.providerId)
    return null;
  const age = Math.max(0, Date.now() - snapshot.generatedAt);
  if (!Number.isFinite(age) || age > USAGE_ENTITLEMENT_ACCESS_REFRESH_MS) return null;
  const candidate = { ...selection, providerId: provider.providerId };
  if (!validateModelSelectionOptions(model, candidate).ok) return null;
  const hasBalance = getActiveModelBuckets(
    snapshot,
    (snapshot.serverTime ?? snapshot.generatedAt) + age,
  ).some((bucket) => {
    if (!bucketMatchesModel(bucket, selection.modelId)) return false;
    return typeof bucket.remaining === "number" && Number.isFinite(bucket.remaining)
      ? bucket.remaining > 0
      : (bucketRemainingRatio(bucket) ?? 0) > 0;
  });
  return hasBalance ? candidate : null;
}

/** 只改思考档位、继承或其他字段不属于模型更换。 */
export function hasExplicitModelChanged(
  previous: ModelSelection | null | undefined,
  next: ModelSelection | null | undefined,
): next is ModelSelection {
  return Boolean(
    next && (previous?.providerId !== next.providerId || previous.modelId !== next.modelId),
  );
}
