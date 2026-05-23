"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { LocalizedValue, SiteLocale } from "@ai-site/content";
import { isSiteLocale, siteLocales } from "@ai-site/content";
import { LOCALE_COOKIE_NAME, toHtmlLang } from "@/lib/site-locale";

interface LocaleContextValue {
  locale: SiteLocale;
  locales: readonly SiteLocale[];
  setLocale: (locale: SiteLocale) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

function persistLocale(locale: SiteLocale) {
  document.cookie = `${LOCALE_COOKIE_NAME}=${locale}; path=/; max-age=31536000; samesite=lax`;
}

export function LocaleProvider({
  children,
  initialLocale,
}: {
  children: ReactNode;
  initialLocale: SiteLocale;
}) {
  const [locale, setLocaleState] = useState<SiteLocale>(initialLocale);

  useEffect(() => {
    const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE_NAME}=([^;]*)`));
    const raw = m?.[1] ? decodeURIComponent(m[1]) : "";
    if (isSiteLocale(raw)) {
      setLocaleState(raw);
    }
  }, []);

  const setLocale = useCallback((nextLocale: SiteLocale) => {
    setLocaleState(nextLocale);
    persistLocale(nextLocale);
  }, []);

  useEffect(() => {
    document.documentElement.lang = toHtmlLang(locale);
    document.documentElement.dataset.locale = locale;
    persistLocale(locale);
  }, [locale]);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      locales: siteLocales,
      setLocale,
    }),
    [locale, setLocale],
  );

  return (
    <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
  );
}

export function useSiteLocale() {
  const context = useContext(LocaleContext);

  if (!context) {
    throw new Error("useSiteLocale must be used within LocaleProvider");
  }

  return context;
}

export function useLocalizedValue<T>(value: LocalizedValue<T>) {
  const { locale } = useSiteLocale();

  return value[locale];
}
