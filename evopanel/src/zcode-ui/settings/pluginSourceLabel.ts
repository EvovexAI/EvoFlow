import type { ZCodePluginMarketplaceSummary } from "@zcode/shared";

/**
 * 把 marketplace id 解析为对用户友好的展示名：
 * 优先用 marketplaces 概览里的 name，缺失时回落到原始 id。
 * 纯函数，便于在目录标题栏与已安装来源标签间复用同一套命名。
 */
export function resolveMarketplaceDisplayName(
  marketplaceId: string,
  marketplaces: readonly ZCodePluginMarketplaceSummary[],
): string {
  const matched = marketplaces.find((marketplace) => marketplace.id === marketplaceId);
  return matched?.name ?? marketplaceId;
}
