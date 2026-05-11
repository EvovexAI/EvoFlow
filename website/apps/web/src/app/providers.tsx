"use client";

import type { SiteLocale } from "@ai-site/content";
import { ThemeProvider } from "next-themes";
import { CommandPaletteProvider } from "@/components/command-palette-provider";
import { EasterEggs } from "@/components/easter-eggs";
import { LocaleProvider } from "@/components/locale-provider";

export function Providers({
  children,
  initialLocale,
}: {
  children: React.ReactNode;
  initialLocale: SiteLocale;
}) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      disableTransitionOnChange
      enableSystem={false}
      storageKey="evoflow-theme"
    >
      <LocaleProvider initialLocale={initialLocale}>
        <CommandPaletteProvider>
            <EasterEggs />
            {children}
          </CommandPaletteProvider>
      </LocaleProvider>
    </ThemeProvider>
  );
}
