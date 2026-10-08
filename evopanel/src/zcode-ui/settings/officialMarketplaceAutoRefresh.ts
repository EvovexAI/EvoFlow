// 商店页「目录自动刷新」（Catalog Auto-Refresh）的节流判据。
//
// 需求：每次进入商店页都默认刷新 ZCode 官方市场，让 CDN 新上架插件无需手动点刷新即可见；
// 但要节流（距上次成功刷新不足窗口则跳过）与防抖（刷新失败后、请求仍在飞时不重复触发）。
//
// 判据 = now - max(lastUpdated, lastAttemptAt) >= 窗口。
// - lastUpdated 来自 agent 持久化的 known_marketplaces.json，任何成功刷新（手动、会话推荐插件
//   路径）都会重写它，因此天然跨窗口、跨重启共享，手动刷新后自动窗口随之重置。
// - lastAttemptAt 是本模块内存中的「发起时间」。UI 侧 PluginMarketplaceSummary 拿不到失败时间戳，
//   纯靠 lastUpdated 会让离线用户每次进入都重试一次长超时请求；发起时立刻记录尝试时间，
//   同时挡住「刚失败过」与「上一次还在飞」两种重复。进程重启清零是可接受的（重启后允许再试一次）。
// - 商店页每次进入都是重新挂载（key 带 pluginStoreOpenVersion），组件内 ref 无法承载节流状态，
//   所以放在模块级。

const OFFICIAL_MARKETPLACE_AUTO_REFRESH_INTERVAL_MS = 10 * 60_000;

const lastAttemptAtByMarketplace = new Map<string, number>();

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function shouldAutoRefreshMarketplace(params: {
  lastUpdated?: string;
  lastAttemptAt?: number;
  now: number;
}): boolean {
  const lastUpdatedAt = parseTimestamp(params.lastUpdated);
  const lastKnownAt = Math.max(lastUpdatedAt ?? -Infinity, params.lastAttemptAt ?? -Infinity);
  return params.now - lastKnownAt >= OFFICIAL_MARKETPLACE_AUTO_REFRESH_INTERVAL_MS;
}

/**
 * 判定是否应自动刷新，通过则立刻占位（记录本次尝试时间）并返回 true。
 * 判定与占位一步完成，避免同一挂载期间 effect 重跑或快速进出商店页时重复发起。
 */
export function claimMarketplaceAutoRefresh(
  marketplaceId: string,
  lastUpdated: string | undefined,
  now: number = Date.now(),
): boolean {
  const shouldRefresh = shouldAutoRefreshMarketplace({
    lastUpdated,
    lastAttemptAt: lastAttemptAtByMarketplace.get(marketplaceId),
    now,
  });
  if (shouldRefresh) {
    lastAttemptAtByMarketplace.set(marketplaceId, now);
  }
  return shouldRefresh;
}
