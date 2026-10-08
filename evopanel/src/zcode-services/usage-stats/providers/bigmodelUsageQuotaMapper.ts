import { isActivePersonalCodingPlan } from "#src/bigmodel/codingPlanEntitlement.js";
import type { UsageQuotaLimit, UsageQuotaUsageDetail } from "@zcode/shared";

interface BigModelSubscriptionListItem {
  productId?: string;
  productName?: string;
  status?: string;
  inCurrentPeriod?: boolean;
  purchaseTime?: string;
  valid?: string;
  autoRenew?: number | boolean;
  currentRenewTime?: string;
  nextRenewTime?: string;
  billingCycle?: string;
}

export interface BigModelUsageQuotaEnvelope {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: BigModelUsageQuotaPayload | null;
}

export interface BigModelUsageQuotaPayload {
  level?: string;
  limits?: BigModelUsageQuotaLimitPayload[];
}

interface BigModelUsageQuotaLimitPayload {
  type?: string;
  unit?: number;
  number?: number;
  usage?: number;
  currentValue?: number;
  remaining?: number;
  percentage?: number;
  nextResetTime?: number;
  usageDetails?: Array<{
    modelCode?: string;
    displayName?: string;
    usage?: number;
  }>;
}

export function normalizeLimits(limits: BigModelUsageQuotaPayload["limits"]): UsageQuotaLimit[] {
  if (!Array.isArray(limits)) {
    return [];
  }

  return limits
    .filter((limit) => typeof limit.type === "string" && limit.type.length > 0)
    .map((limit) => ({
      type: limit.type ?? "",
      ...(typeof limit.unit === "number" ? { unit: limit.unit } : {}),
      ...(typeof limit.number === "number" ? { number: limit.number } : {}),
      ...(typeof limit.usage === "number" ? { usage: limit.usage } : {}),
      ...(typeof limit.currentValue === "number" ? { currentValue: limit.currentValue } : {}),
      ...(typeof limit.remaining === "number" ? { remaining: limit.remaining } : {}),
      ...(typeof limit.percentage === "number" ? { percentage: limit.percentage } : {}),
      ...(typeof limit.nextResetTime === "number" ? { nextResetTime: limit.nextResetTime } : {}),
      usageDetails: normalizeUsageDetails(limit.usageDetails),
    }));
}

export function pickPrimaryLimit(limits: UsageQuotaLimit[]): UsageQuotaLimit | null {
  return (
    limits.find((limit) => limit.type === "TIME_LIMIT") ??
    limits.find((limit) => typeof limit.remaining === "number") ??
    limits[0] ??
    null
  );
}

export function pickCurrentSubscriptionFromList(
  payload: BigModelSubscriptionListItem[] | null | undefined,
): {
  productId: string;
  productName: string;
  billingCycle: string | null;
  renewTime: string | null;
  expireTime: string | null;
} | null {
  if (!Array.isArray(payload) || payload.length === 0) {
    return null;
  }

  const currentSubscription = payload.find(isActivePersonalCodingPlan);
  if (!currentSubscription?.productId) {
    return null;
  }

  return {
    productId: currentSubscription.productId,
    productName: currentSubscription.productName ?? currentSubscription.productId,
    billingCycle: currentSubscription.billingCycle?.trim() || null,
    renewTime: pickCurrentSubscriptionRenewTime(currentSubscription),
    expireTime: pickCurrentSubscriptionExpireTime(currentSubscription),
  };
}

function pickCurrentSubscriptionRenewTime(
  subscription: BigModelSubscriptionListItem,
): string | null {
  const nextRenewTime = parseBigModelLocalDateTime(subscription.nextRenewTime);
  if (!nextRenewTime) {
    return null;
  }

  return subscription.autoRenew === true || subscription.autoRenew === 1 ? nextRenewTime : null;
}

function pickCurrentSubscriptionExpireTime(
  subscription: BigModelSubscriptionListItem,
): string | null {
  // 自动续费套餐的 nextRenewTime 表示下一次扣费，不是最终到期；
  // 非自动续费时它才是当前权益结束时间，避免 UI 同时显示续费和到期两个互斥含义。
  const nextRenewTime = parseBigModelLocalDateTime(subscription.nextRenewTime);
  if (nextRenewTime && subscription.autoRenew !== true && subscription.autoRenew !== 1) {
    return nextRenewTime;
  }

  const validPeriodEnd = parseValidPeriodEnd(subscription.valid);
  return validPeriodEnd;
}

function parseValidPeriodEnd(value: string | undefined): string | null {
  const matches = value?.match(/\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?/g);
  const end = matches?.at(-1);
  return parseBigModelLocalDateTime(end);
}

function parseBigModelLocalDateTime(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const normalized =
    trimmed.includes("T") || !trimmed.includes(" ") ? trimmed : trimmed.replace(" ", "T");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeUsageDetails(
  details: BigModelUsageQuotaLimitPayload["usageDetails"],
): UsageQuotaUsageDetail[] {
  if (!Array.isArray(details)) {
    return [];
  }

  return details
    .filter((detail) => typeof detail.modelCode === "string")
    .map((detail) => ({
      modelCode: detail.modelCode ?? "",
      ...(typeof detail.displayName === "string" && detail.displayName.trim().length > 0
        ? { displayName: detail.displayName.trim() }
        : {}),
      usage: typeof detail.usage === "number" ? detail.usage : 0,
    }));
}
