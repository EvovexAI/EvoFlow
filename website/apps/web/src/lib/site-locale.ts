import { defaultLocale, isSiteLocale, type SiteLocale } from "@ai-site/content";

export const LOCALE_COOKIE_NAME = "ai-site-locale";

export function resolveSiteLocale(value: string | null | undefined): SiteLocale {
  return isSiteLocale(value) ? value : defaultLocale;
}

export function toHtmlLang(locale: SiteLocale) {
  return locale === "zh" ? "zh-CN" : "en";
}
