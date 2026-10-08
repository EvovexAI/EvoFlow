import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID } from "./plugin-marketplaces.js";
import type { PluginStoreModeOrder } from "./pluginStoreOrder.js";

export const FALLBACK_PLUGIN_STORE_CATEGORY = "other";
export const PLUGIN_STORE_CATEGORY_ORDER: readonly string[] = [
  "productivity",
  "developer-tools",
  "utilities",
  "finance",
  "legal",
  "template",
];

// 完整 ID 避免个人市场的同名插件被误置顶；所有展示入口复用同一默认顺序。
const DOCUMENT_PLUGIN_RANKS = new Map(
  ["pdf", "presentations", "spreadsheets", "documents"].map((name, index) => [
    `${name}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID}`,
    index,
  ]),
);

export function compareDocumentPluginPriority(leftId: string, rightId: string): number {
  return compareRanks(DOCUMENT_PLUGIN_RANKS, leftId, rightId);
}

/** 分类归并只影响展示，市场与引用 Picker 必须使用同一个排序键。 */
export function resolvePluginStoreCategory(category: string | undefined): string | undefined {
  const normalized = category?.trim();
  return normalized === "guides" ? "utilities" : normalized || undefined;
}

interface PluginStoreSortEntry {
  id: string;
  category?: string;
  displayName: string;
}

/** 纯展示排序：配置优先，剩余分类按产品默认顺序，类内文档插件优先，再按本地化名称稳定兜底。 */
export function sortPluginStoreEntries<T>(
  items: readonly T[],
  project: (item: T) => PluginStoreSortEntry,
  locale: string,
  order?: PluginStoreModeOrder,
): T[] {
  const categoryRanks = ranks(order?.categoryOrder);
  const pluginRanks = new Map(
    Object.entries(order?.pluginOrder ?? {}).map(([category, ids]) => [category, ranks(ids)]),
  );
  return items
    .map((item, index) => {
      const entry = project(item);
      return {
        item,
        index,
        ...entry,
        category: resolvePluginStoreCategory(entry.category) ?? FALLBACK_PLUGIN_STORE_CATEGORY,
      };
    })
    .sort(
      (left, right) =>
        compareRanks(categoryRanks, left.category, right.category) ||
        compareCategories(left.category, right.category) ||
        compareRanks(pluginRanks.get(left.category), left.id, right.id) ||
        compareDocumentPluginPriority(left.id, right.id) ||
        left.displayName.localeCompare(right.displayName, locale) ||
        left.index - right.index,
    )
    .map(({ item }) => item);
}

function ranks(order: readonly string[] = []): Map<string, number> {
  const result = new Map<string, number>();
  for (const key of order) if (!result.has(key)) result.set(key, result.size);
  return result;
}
function compareRanks(order: Map<string, number> | undefined, left: string, right: string): number {
  if (!order) return 0;
  return (order.get(left) ?? order.size) - (order.get(right) ?? order.size);
}
function compareCategories(left: string, right: string): number {
  if (left === right) return 0;
  if (left === FALLBACK_PLUGIN_STORE_CATEGORY) return 1;
  if (right === FALLBACK_PLUGIN_STORE_CATEGORY) return -1;
  const a = PLUGIN_STORE_CATEGORY_ORDER.indexOf(left);
  const b = PLUGIN_STORE_CATEGORY_ORDER.indexOf(right);
  if (a !== -1 && b !== -1) return a - b;
  if (a !== -1) return -1;
  if (b !== -1) return 1;
  return left < right ? -1 : 1;
}
