import type { UsageEntitlementSnapshot, UsageQuotaLimit } from "@zcode/shared";

function normalizeQuotaModel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^model:/u, "")
    .replace(/_/gu, "-");
}

export function bucketMatchesModel(bucket: UsageQuotaLimit, modelId: string): boolean {
  return bucket.usageDetails.some(
    (detail) => normalizeQuotaModel(detail.modelCode) === normalizeQuotaModel(modelId),
  );
}

export function getActiveModelBuckets(
  snapshot: UsageEntitlementSnapshot,
  now = snapshot.serverTime ?? snapshot.generatedAt,
): UsageQuotaLimit[] {
  return (snapshot.quota?.limits ?? []).filter(
    (bucket) =>
      (!bucket.meter || bucket.meter === "model_usage") &&
      (bucket.nextResetTime === undefined || bucket.nextResetTime > now) &&
      (bucket.periodStart === undefined || bucket.periodStart <= now) &&
      (bucket.periodEnd === undefined || bucket.periodEnd > now),
  );
}

function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function bucketRemainingRatio(bucket: UsageQuotaLimit): number | null {
  // 使用同桶的真实剩余额度；不能把 available（扣除预占）当 remaining。
  if (finite(bucket.remaining) && finite(bucket.number) && bucket.number > 0) {
    return bucket.remaining / bucket.number;
  }
  return finite(bucket.percentage) ? bucket.percentage : null;
}

export function allBucketsExhausted(buckets: UsageQuotaLimit[]): boolean {
  // 只看第一个桶会把“活动桶耗尽、日桶仍有额度”误报成模型耗尽；未知值不能当 0。
  return (
    buckets.length > 0 &&
    buckets.every((bucket) =>
      finite(bucket.remaining) ? bucket.remaining <= 0 : bucketRemainingRatio(bucket) === 0,
    )
  );
}

export function bucketReminderKey(bucket: UsageQuotaLimit): string | null {
  if (
    !bucket.bucketId?.trim() ||
    !finite(bucket.periodStart) ||
    !finite(bucket.periodEnd) ||
    bucket.periodStart < 0 ||
    bucket.periodEnd <= bucket.periodStart
  )
    return null;
  // 桶标识隔离账号/套餐；同桶服务多个模型时也只提醒一次，不把任务和余额写进 key。
  return JSON.stringify([bucket.bucketId.trim(), bucket.periodStart, bucket.periodEnd]);
}
