"use client";

import { siteCopyByLocale, type PlaceholderPageKey } from "@ai-site/content";
import { PageIntro } from "@ai-site/ui";
import { useLocalizedValue } from "./locale-provider";

interface PlaceholderPageProps {
  pageKey: PlaceholderPageKey;
}

export function PlaceholderPage({ pageKey }: PlaceholderPageProps) {
  const copy = useLocalizedValue(siteCopyByLocale);
  const page = copy.pages[pageKey];

  return (
    <main className="flex-1">
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute left-[10%] top-28 h-48 w-48 rounded-full bg-primary/10 blur-3xl" />
        <div className="pointer-events-none absolute right-[12%] top-44 h-56 w-56 rounded-full bg-secondary/10 blur-3xl" />
        <div className="pointer-events-none absolute bottom-0 left-1/3 h-44 w-44 rounded-full bg-tertiary/10 blur-3xl" />

        <div className="mx-auto flex min-h-[70vh] w-full max-w-5xl flex-col justify-center px-6 pb-24 pt-36 md:px-10 md:pt-40">
          <PageIntro
            description={page.description}
            eyebrow={page.eyebrow}
            title={page.title}
          />
        </div>
      </section>
    </main>
  );
}
