export const siteLocales = ["zh", "en"] as const;

export type SiteLocale = (typeof siteLocales)[number];

export type LocalizedValue<T> = Record<SiteLocale, T>;

export const defaultLocale: SiteLocale = "zh";

export function isSiteLocale(value: string | null | undefined): value is SiteLocale {
  return siteLocales.includes(value as SiteLocale);
}

export function getLocalizedValue<T>(
  value: LocalizedValue<T>,
  locale: SiteLocale,
) {
  return value[locale];
}
