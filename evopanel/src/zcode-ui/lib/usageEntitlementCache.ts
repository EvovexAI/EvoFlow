import type { UsageEntitlementSnapshot } from "@zcode/shared";

// 旧缓存可能由 quota level 合成订阅；切换命名空间避免升级后恢复伪权益。
const USAGE_ENTITLEMENT_CACHE_PREFIX = "zcode:usage-entitlement:subscription-v2:";
export const USAGE_ENTITLEMENT_CACHE_TTL_MS = 10 * 60 * 1000;

interface CachedUsageEntitlementSnapshot {
  cachedAt: number;
  snapshot: UsageEntitlementSnapshot;
}

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.localStorage ?? null;
}

export function buildUsageEntitlementCacheKey(params: {
  providerId: string;
  providerFingerprint: string;
}): string {
  const providerId = params.providerId.trim();
  const providerFingerprint = params.providerFingerprint.trim();
  if (!providerId || !providerFingerprint) {
    return "";
  }

  return `${USAGE_ENTITLEMENT_CACHE_PREFIX}${providerId}:${providerFingerprint}`;
}

export function readCachedUsageEntitlementSnapshot(params: {
  cacheKey: string;
  now?: () => number;
  ttlMs?: number;
}): UsageEntitlementSnapshot | null {
  const cacheKey = params.cacheKey.trim();
  if (!cacheKey) {
    return null;
  }

  try {
    const storage = getLocalStorage();
    const raw = storage?.getItem(cacheKey);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<CachedUsageEntitlementSnapshot>;
    const cachedAt = typeof parsed.cachedAt === "number" ? parsed.cachedAt : 0;
    const snapshot = parsed.snapshot;
    const currentTime = params.now?.() ?? Date.now();
    if (!snapshot || currentTime - cachedAt > (params.ttlMs ?? USAGE_ENTITLEMENT_CACHE_TTL_MS)) {
      storage?.removeItem(cacheKey);
      return null;
    }

    return snapshot;
  } catch {
    return null;
  }
}

export function writeCachedUsageEntitlementSnapshot(params: {
  cacheKey: string;
  snapshot: UsageEntitlementSnapshot;
  now?: () => number;
}): void {
  const cacheKey = params.cacheKey.trim();
  if (!cacheKey) {
    return;
  }

  try {
    getLocalStorage()?.setItem(
      cacheKey,
      JSON.stringify({
        cachedAt: params.now?.() ?? Date.now(),
        snapshot: params.snapshot,
      } satisfies CachedUsageEntitlementSnapshot),
    );
  } catch {
    // localStorage 可能被禁用或配额已满；缓存失败不影响远端权益刷新。
  }
}
