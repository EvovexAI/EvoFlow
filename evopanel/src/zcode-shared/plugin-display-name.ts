import type { ZCodePluginStoreListing } from "./zcode-protocol/index.js";

const CANONICAL_PLUGIN_NAME_ACRONYMS: Readonly<Record<string, string>> = {
  aws: "AWS",
  mcp: "MCP",
  zcode: "ZCode",
};

/** listing 的多语言字段先精确匹配，再按语言前缀兜底。 */
export function resolveLocalizedText(
  locale: string,
  base: string | undefined,
  i18n: Record<string, string> | undefined,
): string | undefined {
  if (i18n) {
    const exact = i18n[locale];
    if (exact) return exact;
    const language = locale.split("-")[0];
    if (language) {
      const match = Object.entries(i18n).find(([key]) => key.split("-")[0] === language);
      if (match?.[1]) return match[1];
    }
  }
  return base;
}

export function formatCanonicalPluginName(name: string, locale: string): string {
  return name
    .trim()
    .split(/[-_]+/u)
    .filter(Boolean)
    .map(
      (part) =>
        CANONICAL_PLUGIN_NAME_ACRONYMS[part.toLowerCase()] ??
        `${part.charAt(0).toLocaleUpperCase(locale)}${part.slice(1)}`,
    )
    .join(" ");
}

/**
 * 用户可见插件名称只信任与完整 Plugin ID 关联的 listing；缺失时才回退到 canonical slug。
 * 不按裸 manifest name 猜测官方产品名，避免同名 marketplace 插件互相覆盖。
 */
export function resolvePluginDisplayName(
  plugin: { name: string; listing?: ZCodePluginStoreListing },
  locale: string,
): string {
  return (
    resolveLocalizedText(locale, plugin.listing?.displayName, plugin.listing?.displayNameI18n) ??
    formatCanonicalPluginName(plugin.name, locale)
  );
}
