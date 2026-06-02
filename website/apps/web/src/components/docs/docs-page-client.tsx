"use client";

import type { DocPage } from "@ai-site/content";
import { useSiteLocale } from "@/components/locale-provider";
import { DocsArticleView } from "./docs-article-view";
import { DocsHome } from "./docs-home";

export function DocsHomeWithLocale() {
  const { locale } = useSiteLocale();
  return <DocsHome locale={locale} />;
}

export function DocsArticleWithLocale({ page, slug }: { page: DocPage; slug: string[] }) {
  const { locale } = useSiteLocale();
  return <DocsArticleView locale={locale} page={page} slug={slug} />;
}
