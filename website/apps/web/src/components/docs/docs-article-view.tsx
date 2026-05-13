import type { DocPage, SiteLocale } from "@ai-site/content";
import { DocMarkdown } from "./doc-markdown";
import { DocsShell } from "./docs-shell";

export function DocsArticleView({
  locale,
  slug,
  page,
}: {
  locale: SiteLocale;
  slug: string[];
  page: DocPage;
}) {
  return (
    <DocsShell currentSlug={slug} locale={locale}>
      <header className="mb-8 border-b border-outline-variant/15 pb-6">
        <h1 className="font-display-ui text-3xl font-semibold tracking-[-0.04em] text-foreground md:text-4xl">
          {page.title[locale]}
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-foreground-muted md:text-base">
          {page.description[locale]}
        </p>
      </header>
      <DocMarkdown markdown={page.body[locale]} />
    </DocsShell>
  );
}
