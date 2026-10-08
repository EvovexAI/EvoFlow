import { useMemo } from "react";
import {
  sortPluginStoreEntries,
  isPublicStoreMarketplaceId,
  type PluginStoreModeOrder,
  resolvePluginDisplayName,
  resolveLocalizedText,
  type ZCodePluginReferenceCatalogEntry,
} from "@zcode/shared";
import type { MentionCategoryResult, MentionItem } from "@/mentions/mentionTypes.js";
import { filterMentionItemsWithOptions } from "@/mentions/mentionSearch.js";
import { buildPluginMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { usePluginReferenceCatalog } from "@/hooks/usePluginReferenceCatalog.js";
import { usePluginStoreOrder } from "@/hooks/usePluginStoreOrder.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

interface PluginMentionLabels {
  conflictReason: string;
}

// - 只展示 catalog 中 enabled 的 Plugin；disabled 条目不可被引用，不进入候选。
// - 同名 manifest 冲突（conflictingPluginIds 非空）保持可见但禁选，展示冲突原因（V1 fail closed）。
// - markdown 载体固定 `[@Label](plugin://stable-id)`；label 仅展示，身份在 destination。
//   面板展示名 displayLabel 按当前 locale 走全 app 统一的 resolvePluginDisplayName；label 与
//   载体 label 固定 entry.name，chip/canonical text/reminder 不随 locale 变化（chip 节点复用
//   item.label，若本地化 label 会与按 markdown 重建的消息气泡文案分裂）。
// - keywords 并入 listing 的全部语言显示名（无论当前 locale）：英文界面下打中文
//   也能搜到官方插件（插件 @ 引用中文搜索）。
function mapPluginCatalogToMentionItemsForTest(
  entries: ZCodePluginReferenceCatalogEntry[],
  labels: PluginMentionLabels,
  locale: string,
  order?: PluginStoreModeOrder,
): MentionItem[] {
  const sorted =
    order && entries.some((entry) => entry.category !== undefined)
      ? [
          ...sortPluginStoreEntries(
            entries.filter((entry) => isPublicStoreMarketplaceId(entry.marketplace)),
            (entry) => ({
              id: entry.pluginId,
              category: entry.category,
              displayName: resolvePluginDisplayName(
                {
                  name: entry.name,
                  listing: {
                    displayName: entry.displayName,
                    displayNameI18n: entry.displayNameI18n,
                  },
                },
                locale,
              ),
            }),
            locale,
            order,
          ),
          ...entries.filter((entry) => !isPublicStoreMarketplaceId(entry.marketplace)),
        ]
      : entries;
  return sorted
    .filter((entry) => entry.enabled)
    .map((entry) => {
      const conflicted = entry.conflictingPluginIds.length > 0;
      return {
        id: `plugin:${entry.pluginId}`,
        category: "plugins" as const,
        label: entry.name,
        displayLabel: resolvePluginDisplayName(
          {
            name: entry.name,
            listing: {
              displayName: entry.displayName,
              displayNameI18n: entry.displayNameI18n,
            },
          },
          locale,
        ),
        description: resolveLocalizedText(locale, entry.description, entry.descriptionI18n) ?? "",
        value: entry.pluginId,
        markdown: buildPluginMentionMarkdown(entry.name, entry.pluginId),
        keywords: [
          entry.name,
          entry.pluginId,
          entry.marketplace,
          ...(entry.displayName ? [entry.displayName] : []),
          ...Object.values(entry.displayNameI18n ?? {}),
        ],
        data: {
          pluginId: entry.pluginId,
          ...(entry.icon ? { icon: entry.icon } : {}),
        },
        ...(conflicted
          ? {
              disabled: true,
              disabledReason: labels.conflictReason,
            }
          : {}),
      };
    });
}

export function usePluginsMentionProvider(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  sessionId: string | null,
  query: string,
  enabled: boolean,
  emptyText: string,
  title: string,
): MentionCategoryResult {
  const { intl, locale } = useZCodeIntl();
  const { order } = usePluginStoreOrder(enabled);
  const isOfficeMode = useIsOfficeMode();
  const modeOrder = isOfficeMode ? order?.work : order?.code;
  const catalog = usePluginReferenceCatalog(workspacePath, workspaceIdentity, sessionId, enabled);

  const allItems = useMemo(
    () =>
      mapPluginCatalogToMentionItemsForTest(
        catalog.entries,
        {
          conflictReason: intl.formatMessage({ id: "chat.mention.plugins.conflict" }),
        },
        locale,
        modeOrder,
      ),
    [catalog.entries, intl, locale, modeOrder],
  );

  const items = useMemo(
    () =>
      filterMentionItemsWithOptions(allItems, query, {
        requireQuery: false,
      }),
    [allItems, query],
  );

  return {
    items: enabled ? items : [],
    loading: catalog.loading,
    error: catalog.error ? new Error(catalog.error) : null,
    emptyText,
    title,
  };
}
