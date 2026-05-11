import Link from "next/link";
import { docsIndexCopy, docsNavSections, type SiteLocale } from "@ai-site/content";

export function DocsHome({ locale }: { locale: SiteLocale }) {
  const copy = docsIndexCopy(locale);

  return (
    <div
      className={[
        "mx-auto w-full max-w-screen-2xl px-4 pb-16 pt-24 md:px-6 md:pt-28 lg:pb-24",
        locale === "zh" ? "docs-home-typography-zh" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <header className="max-w-3xl">
        <h1 className="font-display-ui text-4xl font-semibold tracking-[-0.05em] text-foreground md:text-5xl">
          {copy.title}
        </h1>
        <p className="mt-3 text-base text-foreground-muted md:text-lg">{copy.description}</p>
        <p className="mt-6 text-sm leading-relaxed text-foreground-muted md:text-[15px]">{copy.intro}</p>
      </header>

      <div className="mt-12 grid gap-10 md:grid-cols-2 xl:grid-cols-4">
        {docsNavSections.map((section) => (
          <section key={section.title[locale]}>
            <h2 className="font-label-ui text-[10px] font-medium uppercase tracking-[0.22em] text-foreground-muted">
              {section.title[locale]}
            </h2>
            <ul className="mt-4 space-y-2">
              {section.items.map((item) => (
                <li key={item.slug.join("/")}>
                  <Link
                    href={`/docs/${item.slug.join("/")}`}
                    className="group block rounded-xl border border-outline-variant/20 bg-surface-low/30 px-4 py-3 transition-colors hover:border-outline-variant/40 hover:bg-surface-high/30"
                  >
                    <span className="font-display-ui text-base font-semibold text-foreground group-hover:text-primary">
                      {item.title[locale]}
                    </span>
                    <span className="mt-1 block text-xs text-foreground-muted">→</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
