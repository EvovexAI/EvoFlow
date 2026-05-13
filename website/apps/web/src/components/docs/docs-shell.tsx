import Link from "next/link";
import { docsNavSections, siteLinks, staticPageHref, type SiteLocale } from "@ai-site/content";

function slugPath(slug: string[]): string {
  const raw = slug.length ? `/docs/${slug.join("/")}/` : "/docs/";
  return staticPageHref(raw);
}

function isActive(current: string[], target: string[]): boolean {
  if (current.length !== target.length) return false;
  return current.every((s, i) => s === target[i]);
}

export function DocsShell({
  locale,
  currentSlug,
  children,
}: {
  locale: SiteLocale;
  currentSlug: string[];
  children: React.ReactNode;
}) {
  return (
    <div
      className={[
        "mx-auto flex w-full max-w-screen-2xl flex-col gap-10 px-4 pb-16 pt-24 md:flex-row md:gap-12 md:px-6 md:pt-28 lg:pb-24",
        locale === "zh" ? "docs-typography-zh" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <aside className="shrink-0 md:sticky md:top-28 md:self-start md:w-52 lg:w-56">
        <p className="font-label-ui text-[10px] font-medium uppercase tracking-[0.22em] text-foreground-muted">
          {locale === "zh" ? "目录" : "Contents"}
        </p>
        <nav className="mt-4 space-y-6" aria-label={locale === "zh" ? "文档目录" : "Documentation contents"}>
          <Link
            href={staticPageHref("/docs/")}
            className={[
              "block rounded-md px-2 py-1.5 text-sm transition-colors",
              currentSlug.length === 0
                ? "bg-surface-high font-medium text-foreground"
                : "text-foreground-muted hover:bg-surface-high/50 hover:text-foreground",
            ].join(" ")}
          >
            {locale === "zh" ? "文档首页" : "Overview"}
          </Link>
          {docsNavSections.map((section) => (
            <div key={section.title[locale]}>
              <p className="px-2 font-label-ui text-[10px] uppercase tracking-[0.18em] text-foreground-muted/80">
                {section.title[locale]}
              </p>
              <ul className="mt-2 space-y-0.5">
                {section.items.map((item) => {
                  const active = isActive(currentSlug, item.slug);
                  return (
                    <li key={item.slug.join("/")}>
                      <Link
                        href={slugPath(item.slug)}
                        className={[
                          "block rounded-md px-2 py-1.5 text-sm transition-colors",
                          active
                            ? "bg-surface-high font-medium text-foreground"
                            : "text-foreground-muted hover:bg-surface-high/50 hover:text-foreground",
                        ].join(" ")}
                      >
                        {item.title[locale]}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
        <p className="mt-8 border-t border-outline-variant/15 pt-6 font-body-ui text-xs leading-relaxed text-foreground-muted">
          {locale === "zh" ? (
            <>
              补充说明见 GitHub 仓库{" "}
              <a className="text-primary underline underline-offset-2" href={siteLinks.readme} rel="noreferrer" target="_blank">
                README
              </a>
              。
            </>
          ) : (
            <>
              More detail in the GitHub{" "}
              <a className="text-primary underline underline-offset-2" href={siteLinks.readme} rel="noreferrer" target="_blank">
                README
              </a>
              .
            </>
          )}
        </p>
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
