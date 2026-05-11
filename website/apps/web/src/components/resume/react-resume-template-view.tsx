"use client";

/**
 * Layout patterns adapted from tbakerx/react-resume-template (MIT).
 * @see https://github.com/tbakerx/react-resume-template
 * @see ./NOTICE.txt
 */

import Link from "next/link";
import type { ResumeDoc } from "@ai-site/content";
import { ChevronDown } from "lucide-react";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { memo, useMemo } from "react";

function cx(...parts: Array<string | false | undefined>) {
  return parts.filter(Boolean).join(" ");
}

const SkillBar = memo(function SkillBar({
  name,
  level,
  max = 10,
}: {
  name: string;
  level: number;
  max?: number;
}) {
  const pct = useMemo(() => Math.round((level / max) * 100), [level, max]);
  return (
    <div className="flex flex-col gap-y-1.5">
      <span className="ml-0.5 text-sm font-medium text-foreground">{name}</span>
      <div className="h-2 w-full overflow-hidden rounded-full bg-surface-high">
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
});

function TimelineBlock({
  title,
  location,
  date,
  detail,
}: {
  title: string;
  location: string;
  date: string;
  detail: string;
}) {
  return (
    <div className="border-b border-outline-variant/15 py-8 last:border-b-0 md:text-left">
      <div className="flex flex-col gap-1 md:flex-row md:items-baseline md:justify-between md:gap-4">
        <h3 className="font-display-ui text-lg font-semibold tracking-[-0.03em] text-foreground">{title}</h3>
        <div className="flex shrink-0 flex-wrap items-center gap-x-2 text-xs text-foreground-muted md:justify-end">
          <span>{location}</span>
          <span aria-hidden className="text-outline-variant">
            ·
          </span>
          <span>{date}</span>
        </div>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-foreground-muted">{detail}</p>
    </div>
  );
}

export function ReactResumeTemplateView({
  doc,
  footerBackLabel,
}: {
  doc: ResumeDoc;
  footerBackLabel: string;
}) {
  const navLink =
    "whitespace-nowrap font-label-ui text-[10px] uppercase tracking-[0.18em] text-foreground-muted transition-colors hover:text-primary";

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Single top bar — replaces stacking SiteHeader + resume nav */}
      <header className="fixed top-0 z-50 w-full border-b border-outline-variant/25 bg-background/95 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 md:px-6">
          <div className="flex items-center justify-between gap-4 sm:justify-start">
            <Link
              className="font-display-ui text-lg font-semibold tracking-[-0.04em] text-primary hover:opacity-90"
              href="/"
            >
              EvoFlow
            </Link>
            <div className="flex items-center gap-1 sm:hidden">
              <ThemeToggle />
              <LocaleSwitcher />
            </div>
          </div>

          <nav
            aria-label="Resume sections"
            className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-1 sm:flex-1 sm:justify-center sm:overflow-visible sm:pb-0"
          >
            {doc.sectionNav.map((item) => (
              <a key={item.id} className={navLink} href={`#${item.id}`}>
                {item.label}
              </a>
            ))}
          </nav>

          <div className="hidden items-center gap-2 sm:flex">
            <ThemeToggle />
            <LocaleSwitcher />
          </div>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="relative flex min-h-[100dvh] items-center justify-center px-4 pb-16 pt-[calc(5.5rem+env(safe-area-inset-top))]">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-gradient-to-b from-primary/[0.07] via-background to-background"
          />

          <div className="relative w-full max-w-2xl">
            <div className="rounded-2xl border border-outline-variant/35 bg-surface-low/90 p-8 shadow-xl backdrop-blur-md md:p-10">
              <p className="text-center font-label-ui text-[10px] uppercase tracking-[0.26em] text-primary">
                {doc.heroEyebrow}
              </p>
              <h1 className="font-display-ui mt-4 text-center text-4xl font-semibold tracking-[-0.05em] text-foreground sm:text-5xl md:text-6xl">
                {doc.name}
              </h1>
              <p className="mt-4 text-center text-lg font-medium text-foreground-muted md:text-xl">{doc.role}</p>
              <p className="mx-auto mt-4 max-w-lg text-center text-sm leading-relaxed text-foreground-muted">
                {doc.tagline}
              </p>

              <div className="mt-8 flex flex-wrap justify-center gap-3">
                {doc.heroActions.map((a) => {
                  const internal = a.href.startsWith("/");
                  const className = cx(
                    "inline-flex items-center justify-center rounded-full border px-5 py-2.5 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                    a.primary
                      ? "border-primary bg-primary/12 text-foreground hover:bg-primary/20"
                      : "border-outline-variant/40 bg-transparent text-foreground hover:bg-surface-high/60",
                  );
                  if (internal) {
                    return (
                      <Link key={a.text} className={className} href={a.href}>
                        {a.text}
                      </Link>
                    );
                  }
                  return (
                    <a key={a.text} className={className} href={a.href} rel="noreferrer" target="_blank">
                      {a.text}
                    </a>
                  );
                })}
                {doc.pdfHref ? (
                  <a
                    className="inline-flex items-center justify-center rounded-full border border-secondary bg-secondary/10 px-5 py-2.5 text-sm font-semibold text-foreground hover:bg-secondary/20"
                    href={doc.pdfHref}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {doc.pdfLabel}
                  </a>
                ) : null}
              </div>
            </div>
          </div>

          <div className="absolute inset-x-0 bottom-8 flex justify-center">
            <a
              className="rounded-full border border-outline-variant/40 bg-surface-low/80 p-2 text-foreground-muted hover:border-primary/40 hover:text-primary"
              href="#about"
            >
              <ChevronDown aria-hidden className="h-6 w-6" strokeWidth={1.5} />
              <span className="sr-only">Scroll</span>
            </a>
          </div>
        </section>

        <div className="mx-auto max-w-3xl px-4 md:px-6">
          <section className="scroll-mt-28 py-16" id="about">
            <h2 className="font-display-ui text-2xl font-semibold tracking-[-0.04em] text-foreground md:text-3xl">
              {doc.aboutTitle}
            </h2>
            <p className="mt-5 text-base leading-relaxed text-foreground-muted">{doc.aboutLead}</p>
            {doc.aboutParagraphs.map((p, i) => (
              <p key={i} className="mt-4 text-base leading-relaxed text-foreground-muted">
                {p}
              </p>
            ))}
            <ul className="mt-10 grid gap-3 sm:grid-cols-2">
              {doc.aboutHighlights.map((h) => (
                <li
                  key={h.label}
                  className="rounded-xl border border-outline-variant/25 bg-surface-low/50 p-4"
                >
                  <span className="font-label-ui text-[10px] uppercase tracking-[0.2em] text-primary">{h.label}</span>
                  <p className="mt-2 break-words text-sm leading-relaxed text-foreground-muted">{h.text}</p>
                </li>
              ))}
            </ul>
          </section>

          <section className="scroll-mt-28 border-t border-outline-variant/15 py-16" id="resume">
            <h2 className="font-display-ui text-2xl font-semibold tracking-[-0.04em] text-foreground md:text-3xl">
              {doc.resumeBlockTitle}
            </h2>

            <div className="mt-10">
              <h3 className="font-label-ui text-[10px] uppercase tracking-[0.22em] text-foreground-muted">
                {doc.educationTitle}
              </h3>
              <div className="mt-2">
                {doc.educationRows.map((row) => (
                  <TimelineBlock key={row.title} {...row} />
                ))}
              </div>
            </div>

            <div className="mt-10">
              <h3 className="font-label-ui text-[10px] uppercase tracking-[0.22em] text-foreground-muted">{doc.workTitle}</h3>
              <div className="mt-2">
                {doc.workRows.map((row) => (
                  <TimelineBlock key={row.title} {...row} />
                ))}
              </div>
            </div>

            <div className="mt-12 border-t border-outline-variant/15 pt-12">
              <h3 className="font-display-ui text-xl font-semibold tracking-[-0.03em]">{doc.skillsBarsHeading}</h3>
              <p className="mt-2 text-sm text-foreground-muted">{doc.skillsBarsLead}</p>
              <div className="mt-8 grid gap-10 sm:grid-cols-2 lg:grid-cols-3">
                {doc.skillBarGroups.map((g) => (
                  <div key={g.name} className="flex flex-col gap-4">
                    <span className="font-display-ui text-base font-semibold tracking-[-0.02em] text-foreground">
                      {g.name}
                    </span>
                    <div className="flex flex-col gap-y-4">
                      {g.skills.map((s) => (
                        <SkillBar key={s.name} level={s.level} max={s.max} name={s.name} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>

        {/* Portfolio — slightly wider for cards */}
        <section className="scroll-mt-28 border-t border-outline-variant/15 bg-surface-low/40 py-16" id="portfolio">
          <div className="mx-auto max-w-6xl px-4 md:px-6">
            <h2 className="font-display-ui text-2xl font-semibold tracking-[-0.04em] text-foreground md:text-3xl">
              {doc.portfolioTitle}
            </h2>
            <p className="mt-3 max-w-2xl text-sm text-foreground-muted">{doc.portfolioLead}</p>
            <div className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
              {doc.projects.map((p) => (
                <article
                  key={p.title}
                  className="flex flex-col rounded-xl border border-outline-variant/25 bg-background/80 p-5"
                >
                  <div className="h-0.5 w-10 rounded-full bg-primary" />
                  <h3 className="font-display-ui mt-4 text-lg font-semibold tracking-[-0.03em]">{p.title}</h3>
                  {p.stack ? (
                    <p className="mt-2 font-label-ui text-[10px] uppercase tracking-[0.16em] text-foreground-muted">
                      {p.stack}
                    </p>
                  ) : null}
                  <p className="mt-3 text-sm leading-relaxed text-foreground-muted">{p.summary}</p>
                  <ul className="mt-4 list-disc space-y-1.5 pl-4 text-sm text-foreground-muted marker:text-primary/40">
                    {p.bullets.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </div>
        </section>

        <div className="mx-auto max-w-3xl px-4 md:px-6">
          <section className="scroll-mt-28 py-16" id="contact">
            <h2 className="font-display-ui text-2xl font-semibold tracking-[-0.04em] text-foreground md:text-3xl">
              {doc.contactTitle}
            </h2>
            <ul className="mt-8 space-y-6">
              {doc.contactItems.map((c) => (
                <li key={c.title} className="rounded-xl border border-outline-variant/20 bg-surface-low/30 p-5">
                  <h3 className="font-display-ui text-base font-semibold tracking-[-0.02em]">{c.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-foreground-muted">{c.body}</p>
                  {c.href ? (
                    c.href.startsWith("/") ? (
                      <Link
                        className="mt-3 inline-block text-sm font-medium text-primary hover:underline"
                        href={c.href}
                      >
                        {c.linkText ??
                          c.title.replace(/\s*（站内）\s*$/, "").replace(/\s*\(on-site\)\s*$/i, "").trim()}
                      </Link>
                    ) : (
                      <a
                        className="mt-3 inline-block break-all text-sm font-medium text-primary hover:underline"
                        href={c.href}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {c.linkText ?? c.href}
                      </a>
                    )
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        </div>

        <footer className="border-t border-outline-variant/20 px-4 py-10 md:px-6">
          <div className="mx-auto max-w-3xl text-center">
            {doc.templateCredit?.trim() ? (
              <p className="font-label-ui text-[10px] uppercase tracking-[0.16em] leading-relaxed text-foreground-muted/70">
                {doc.templateCredit}
              </p>
            ) : null}
            <p
              className={cx(
                "font-label-ui text-[10px] uppercase tracking-[0.18em] text-foreground-muted/60",
                doc.templateCredit?.trim() ? "mt-4" : "",
              )}
            >
              EvoFlow ·{" "}
              <Link className="text-primary hover:underline" href="/">
                {footerBackLabel}
              </Link>
            </p>
          </div>
        </footer>
      </main>
    </div>
  );
}
