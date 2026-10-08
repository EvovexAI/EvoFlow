import type {
  PluginStoreModeOrder,
  ZCodeAvailablePluginSummary,
  ZCodeInstalledPluginSummary,
  ZCodePluginInfo,
  ZCodePluginMarketplaceSummary,
  ZCodePluginStoreListing,
} from "@zcode/shared";
import {
  sortPluginStoreEntries,
  compareDocumentPluginPriority,
  resolvePluginStoreCategory as resolveStoreCategory,
  FALLBACK_PLUGIN_STORE_CATEGORY as FALLBACK_CATEGORY,
  isPublicStoreMarketplaceId,
  resolveLocalizedText,
  resolvePluginDisplayName,
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
} from "@zcode/shared";
import { pluginSearchMatches } from "@/settings/pluginSearch.js";

export {
  formatCanonicalPluginName,
  resolveLocalizedText,
  resolvePluginDisplayName,
} from "@zcode/shared";

export { isTrustedImageUrl } from "@/lib/trustedImageUrl.js";
export { isPublicStoreMarketplaceId };

/**
 * 仅在名称唯一时允许从目录条目回退解析 listing。
 * 能力协议的旧 payload 可能没有 pluginId；同名插件并存时继续按裸名称 join
 * 会把第三方条目的品牌和图标误挂到另一个 marketplace，安全降级为 slug 更可靠。
 */
export function resolveUniquePluginListingByName(
  plugins: readonly Pick<ZCodeAvailablePluginSummary, "name" | "listing">[],
  name: string,
): ZCodePluginStoreListing | undefined {
  const normalizedName = name.trim().toLocaleLowerCase();
  let match: ZCodePluginStoreListing | undefined;
  let count = 0;
  for (const plugin of plugins) {
    if (plugin.name.trim().toLocaleLowerCase() !== normalizedName) continue;
    count += 1;
    match = plugin.listing;
  }
  return count === 1 ? match : undefined;
}

/**
 * 商店条目：把 overview 的目录条目（listing/安装态）、运行时插件信息（启用态/组件）与
 * 已安装记录（更新徽标/安装时间）按 id join 成 UI 单一视图模型。
 */
export interface StorePluginItem {
  id: string;
  name: string;
  marketplace: string;
  installed: boolean;
  /** 已卸载的内置插件（可恢复）：安装按钮走 restoreBuiltin。 */
  restorable: boolean;
  /** 已安装但原 marketplace 已移除；仍可运行和管理，但不能更新。 */
  orphaned: boolean;
  listing?: ZCodePluginStoreListing;
  summary?: ZCodeAvailablePluginSummary;
  /** 运行时信息（仅已发现的已安装插件有）：启用态、组件、manifest 回退字段。 */
  info?: ZCodePluginInfo;
  installedMeta?: ZCodeInstalledPluginSummary;
}

export type PluginUpdateStatus = NonNullable<ZCodeInstalledPluginSummary["updateStatus"]>;

export function isPluginUpdatePending(
  updateStatus: PluginUpdateStatus | undefined,
): updateStatus is Exclude<PluginUpdateStatus, "none"> {
  return updateStatus === "update-available" || updateStatus === "version-changed";
}

/**
 * 孤立插件可能保留删除来源前的 updateStatus；若各入口只判断该缓存状态，
 * 详情页会在菜单已禁用更新时仍显示更新按钮。更新能力必须同时满足“来源存在”和“有更新”。
 */
export function canUpdatePluginItem(
  item: Pick<StorePluginItem, "installedMeta" | "orphaned"> | null | undefined,
): boolean {
  return Boolean(item && !item.orphaned && isPluginUpdatePending(item.installedMeta?.updateStatus));
}

export function resolveLocalizedList(
  locale: string,
  base: string[] | undefined,
  i18n: Record<string, string[]> | undefined,
): string[] | undefined {
  if (i18n) {
    const exact = i18n[locale];
    if (exact && exact.length > 0) return exact;
    const language = locale.split("-")[0];
    if (language) {
      const match = Object.entries(i18n).find(([key]) => key.split("-")[0] === language);
      if (match?.[1] && match[1].length > 0) return match[1];
    }
  }
  return base && base.length > 0 ? base : undefined;
}

export function resolveItemDisplayName(item: StorePluginItem, locale: string): string {
  return resolvePluginDisplayName(item, locale);
}

export function resolveItemDescription(item: StorePluginItem, locale: string): string | undefined {
  const base =
    item.summary?.description ?? item.info?.description ?? item.installedMeta?.description;
  return resolveLocalizedText(locale, base, item.listing?.descriptionI18n);
}

/** 管理列表与商店复用完整 ID 关联的展示信息，避免英文 manifest 绕过本地化。 */
export function resolveManagedPluginDisplay(
  plugin: ZCodePluginInfo,
  item: StorePluginItem | undefined,
  locale: string,
): { name: string; description: string | undefined } {
  const matchingItem = item?.id === plugin.id ? item : undefined;
  return {
    name: resolvePluginDisplayName(matchingItem ?? plugin, locale),
    description: matchingItem ? resolveItemDescription(matchingItem, locale) : plugin.description,
  };
}

/** 已知分类的 i18n 映射；未知分类原样展示。无分类 → "other" 区块（排最后）。 */
export const KNOWN_CATEGORY_LABEL_IDS: Record<string, string> = {
  "developer-tools": "settings.plugins.store.category.developerTools",
  productivity: "settings.plugins.store.category.productivity",
  utilities: "settings.plugins.store.category.utilities",
  legal: "settings.plugins.store.category.legal",
  template: "settings.plugins.store.category.template",
  finance: "settings.plugins.store.category.finance",
  other: "settings.plugins.store.category.other",
};

export {
  FALLBACK_PLUGIN_STORE_CATEGORY as FALLBACK_CATEGORY,
  PLUGIN_STORE_CATEGORY_ORDER as KNOWN_CATEGORY_ORDER,
  resolvePluginStoreCategory as resolveStoreCategory,
} from "@zcode/shared";

interface StoreCategoryGroup {
  category: string;
  items: StorePluginItem[];
}

/** 个人分段的市场分组：marketplace 是排序键，title 是展示名。 */
export interface PersonalMarketplaceGroup {
  marketplace: string;
  title: string;
  items: StorePluginItem[];
}

const OFFICIAL_MARKETPLACE_ORDER: readonly string[] = [ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID];

/**
 * 市场源管理排序：官方源固定置顶；自定义源按最近刷新时间倒序，未刷新过的沉底。
 * 同一时间使用本地化名称稳定兜底，避免市场源顺序随持久化数组历史漂移。
 */
export function sortMarketplaceSources(
  marketplaces: readonly ZCodePluginMarketplaceSummary[],
  locale: string,
): ZCodePluginMarketplaceSummary[] {
  const officialRank = new Map(OFFICIAL_MARKETPLACE_ORDER.map((id, index) => [id, index]));
  return marketplaces.toSorted((left, right) => {
    const leftRank = officialRank.get(left.id);
    const rightRank = officialRank.get(right.id);
    if (leftRank !== undefined || rightRank !== undefined) {
      if (leftRank === undefined) return 1;
      if (rightRank === undefined) return -1;
      return leftRank - rightRank;
    }

    const leftAt = left.lastUpdated ?? "";
    const rightAt = right.lastUpdated ?? "";
    if (leftAt !== rightAt) return rightAt.localeCompare(leftAt);
    const byName = left.name.localeCompare(right.name, locale);
    return byName !== 0 ? byName : left.id.localeCompare(right.id, locale);
  });
}

/**
 * 个人分段市场分组排序：按 lastUpdated 倒序——最近刷新/添加的市场在最上，
 * 用户添加成功跳转过来第一眼就能看到；无 lastUpdated（官方 seed 未刷新过）的沉底，
 * 同刻或都缺失时按显示名字母序稳定兜底。ISO 时间串的字典序即时间序。
 */
export function sortPersonalMarketplaceGroups(
  groups: PersonalMarketplaceGroup[],
  marketplaces: readonly ZCodePluginMarketplaceSummary[],
  locale: string,
): PersonalMarketplaceGroup[] {
  const lastUpdatedById = new Map(
    marketplaces.flatMap((marketplace) =>
      marketplace.lastUpdated ? ([[marketplace.id, marketplace.lastUpdated]] as const) : [],
    ),
  );
  return groups.toSorted((left, right) => {
    const leftAt = lastUpdatedById.get(left.marketplace) ?? "";
    const rightAt = lastUpdatedById.get(right.marketplace) ?? "";
    // 空串字典序小于任何时间串，倒序比较自然把缺失时间沉底。
    if (leftAt !== rightAt) return rightAt.localeCompare(leftAt);
    return left.title.localeCompare(right.title, locale);
  });
}

/**
 * 把 overview 数据 join 成商店条目集合。
 * 条目宇宙 = availablePlugins ∪ restorableBuiltins ∪ 实际发现的插件包（覆盖 inline/孤儿插件）。
 */
export function buildStoreItems(input: {
  marketplaces: ZCodePluginMarketplaceSummary[];
  marketplaceAvailabilityKnown: boolean;
  availablePlugins: ZCodeAvailablePluginSummary[];
  installedPlugins: ZCodeInstalledPluginSummary[];
  plugins: ZCodePluginInfo[];
  restorableBuiltins: ZCodeAvailablePluginSummary[];
}): StorePluginItem[] {
  const infoById = new Map(input.plugins.map((plugin) => [plugin.id, plugin]));
  const metaById = new Map(input.installedPlugins.map((item) => [item.id, item]));
  const marketplaceIds = new Set(input.marketplaces.map((item) => item.id));
  const items = new Map<string, StorePluginItem>();

  for (const summary of input.availablePlugins) {
    const info = infoById.get(summary.id);
    items.set(summary.id, {
      id: summary.id,
      name: summary.name,
      marketplace: summary.marketplace,
      installed:
        info?.packageStatus === "missing" ? false : summary.installed || info !== undefined,
      restorable: false,
      orphaned: false,
      ...(summary.listing ? { listing: summary.listing } : {}),
      summary,
      ...(info ? { info } : {}),
      ...(metaById.get(summary.id) ? { installedMeta: metaById.get(summary.id) } : {}),
    });
  }
  for (const summary of input.restorableBuiltins) {
    const existing = items.get(summary.id);
    if (existing) {
      // 内置卸载态同时存在于完整 Catalog 和 restorable 列表：只有没有实际
      // Marketplace ownership 时才覆盖为 restorable。若 installed/installedMeta/info
      // 已表明同名 CDN 插件归用户所有，必须保留 installed，避免详情页误显示 Restore。
      const hasMarketplaceOwnership =
        existing.installed || existing.installedMeta !== undefined || existing.info !== undefined;
      if (hasMarketplaceOwnership) continue;
      items.set(summary.id, {
        ...existing,
        installed: false,
        restorable: true,
        ...(existing.listing || summary.listing
          ? { listing: existing.listing ?? summary.listing }
          : {}),
        ...(existing.summary ? {} : { summary }),
      });
      continue;
    }
    items.set(summary.id, {
      id: summary.id,
      name: summary.name,
      marketplace: summary.marketplace,
      installed: false,
      restorable: true,
      orphaned: false,
      ...(summary.listing ? { listing: summary.listing } : {}),
      summary,
    });
  }
  // 运行时发现、但不在任何目录里的插件（inline、被移除市场的遗留安装）也要可见/可搜索。
  for (const info of input.plugins) {
    if (items.has(info.id)) continue;
    // 旧插件拆分/下架后，配置仍会生成缺包诊断；它不是可安装目录来源。
    // 保留原 plugins 给设置页诊断，但不凭此生成商店安装入口；有目录/恢复来源的条目已在上面保留。
    if (info.packageStatus === "missing") continue;
    items.set(info.id, {
      id: info.id,
      name: info.name,
      marketplace: info.marketplace,
      installed: true,
      restorable: false,
      // 目录条目缺失不等于 Marketplace Source 已删除，overview 失败时来源状态也未知。
      // official/inline 插件不能由目录缺失推导成孤立安装。
      orphaned:
        input.marketplaceAvailabilityKnown &&
        info.source === "cache" &&
        !marketplaceIds.has(info.marketplace),
      info,
      ...(metaById.get(info.id) ? { installedMeta: metaById.get(info.id) } : {}),
    });
  }
  return [...items.values()];
}

/** 公开分段：Featured（CDN featured 名单按序）+ 分类聚合（无分类归 other，排最后）。 */
export function selectFeaturedItems(
  publicItems: StorePluginItem[],
  marketplaces: ZCodePluginMarketplaceSummary[],
): StorePluginItem[] {
  const byName = new Map<string, StorePluginItem>();
  for (const item of publicItems) {
    if (!byName.has(item.name)) byName.set(item.name, item);
  }
  const featured: StorePluginItem[] = [];
  const seen = new Set<string>();
  for (const marketplace of marketplaces) {
    if (!isPublicStoreMarketplaceId(marketplace.id)) continue;
    for (const name of marketplace.featured ?? []) {
      const item = byName.get(name);
      if (item && !seen.has(item.id)) {
        seen.add(item.id);
        featured.push(item);
      }
    }
  }
  return featured;
}

export function groupItemsByCategory(
  items: StorePluginItem[],
  locale: string,
  order?: PluginStoreModeOrder,
): StoreCategoryGroup[] {
  const groups = new Map<string, StorePluginItem[]>();
  const sorted = sortPluginStoreEntries(
    items,
    (item) => ({
      id: item.id,
      category: item.listing?.category,
      displayName: resolveItemDisplayName(item, locale),
    }),
    locale,
    order,
  );
  for (const item of sorted) {
    const category = resolveStoreCategory(item.listing?.category) ?? FALLBACK_CATEGORY;
    const group = groups.get(category) ?? [];
    group.push(item);
    groups.set(category, group);
  }
  return [...groups.entries()].map(([category, items]) => ({ category, items }));
}

export function storeItemMatches(item: StorePluginItem, keyword: string, locale: string): boolean {
  return pluginSearchMatches(
    keyword,
    [
      item.name,
      item.id,
      item.marketplace,
      resolveItemDisplayName(item, locale),
      resolveItemDescription(item, locale) ?? "",
      item.listing?.category ?? "",
      item.listing?.author ?? "",
    ],
    [item.name, item.listing?.displayName, ...Object.values(item.listing?.displayNameI18n ?? {})],
  );
}

/**
 * 已安装图标条排序：官方文档插件优先，其余内置/inline 按名称稳定排序；
 * 市场安装插件随后按安装时间倒序，同一时间再按名称排序。
 */
export function sortInstalledStripItems(
  items: StorePluginItem[],
  locale: string,
): StorePluginItem[] {
  return items.toSorted((left, right) => {
    const documentPriority = compareDocumentPluginPriority(left.id, right.id);
    if (documentPriority !== 0) return documentPriority;

    const leftIsBuiltin = Boolean(left.info && left.info.source !== "cache");
    const rightIsBuiltin = Boolean(right.info && right.info.source !== "cache");
    if (leftIsBuiltin !== rightIsBuiltin) return leftIsBuiltin ? -1 : 1;

    const compareByName = () =>
      resolveItemDisplayName(left, locale).localeCompare(
        resolveItemDisplayName(right, locale),
        locale,
      );
    if (leftIsBuiltin) return compareByName();

    const leftAt = left.installedMeta?.installedAt ?? "";
    const rightAt = right.installedMeta?.installedAt ?? "";
    if (leftAt !== rightAt) return rightAt.localeCompare(leftAt);
    return compareByName();
  });
}
