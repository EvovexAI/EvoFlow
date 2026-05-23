"use client";

import type { SiteLocale } from "@ai-site/content";
import { useSiteLocale } from "./locale-provider";

const localeLabels: Record<SiteLocale, string> = {
  zh: "中",
  en: "EN",
};

export function LocaleSwitcher() {
  const { locale, locales, setLocale } = useSiteLocale();

  return (
    <div className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] p-1 backdrop-blur-sm">
      {locales.map((value) => {
        const isActive = value === locale;

        return (
          <button
            key={value}
            aria-pressed={isActive}
            className={[
              "rounded-full px-3 py-1.5 text-xs font-label-ui transition-colors duration-300",
              isActive
                ? "bg-white/10 text-foreground"
                : "text-foreground-muted hover:text-foreground",
            ].join(" ")}
            onClick={() => setLocale(value)}
            type="button"
          >
            {localeLabels[value]}
          </button>
        );
      })}
    </div>
  );
}
