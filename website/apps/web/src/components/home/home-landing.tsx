"use client";

import Link from "next/link";
import { homeLandingByLocale } from "@ai-site/content";
import { useEffect, useMemo, useState } from "react";
import { useLocalizedValue, useSiteLocale } from "../locale-provider";
import styles from "./home-landing.module.css";

const FLOAT_ICONS = [
  { label: "role", color: "#ffb4a2", glyph: "R" },
  { label: "doc", color: "#ff9f43", glyph: "D" },
  { label: "ai", color: "#8b7cf6", glyph: "AI" },
  { label: "media", color: "#ff7aa2", glyph: "M" },
] as const;

const VISUAL_LINES_ZH: Record<"employees" | "plan", string[]> = {
  employees: ["岗位模板一键预填", "自动上班 / 现在开始工作", "工作汇报 + 诊断条"],
  plan: ["Plan → 确认 → 执行", "子智能体并行", "全程可追溯"],
};

const VISUAL_LINES_EN: Record<"employees" | "plan", string[]> = {
  employees: ["Role templates", "Auto-work / start now", "Reports + diagnosis"],
  plan: ["Plan → confirm → run", "Parallel sub-agents", "Full audit trail"],
};

function ForceLightTheme() {
  useEffect(() => {
    const root = document.documentElement;
    const had = root.classList.contains("light");
    root.classList.add("light");
    return () => {
      if (!had) root.classList.remove("light");
    };
  }, []);
  return null;
}

export function HomeLanding() {
  const copy = useLocalizedValue(homeLandingByLocale);
  const { locale } = useSiteLocale();
  const visualLines = locale === "en" ? VISUAL_LINES_EN : VISUAL_LINES_ZH;
  const [audienceIdx, setAudienceIdx] = useState(0);
  const [openFaq, setOpenFaq] = useState<Set<number>>(() => new Set([0]));

  const audience = copy.audience.tabs[audienceIdx] ?? copy.audience.tabs[0];

  const faqToggle = (i: number) => {
    setOpenFaq((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const titleNode = useMemo(
    () => (
      <>
        {copy.hero.titleBefore}
        <span className={styles.accent}>{copy.hero.titleAccent}</span>
        {copy.hero.titleAfter}
      </>
    ),
    [copy.hero.titleAfter, copy.hero.titleAccent, copy.hero.titleBefore],
  );

  return (
    <div className={styles.page}>
      <ForceLightTheme />
      <div className={styles.bgWrap} aria-hidden>
        <div className={styles.bgGrid} />
        <div className={`${styles.bgBlob} ${styles.bgBlob1}`} />
        <div className={`${styles.bgBlob} ${styles.bgBlob2}`} />
        <div className={`${styles.bgBlob} ${styles.bgBlob3}`} />
      </div>

      <main className={styles.main}>
        <section className={styles.hero}>
          <div className={styles.floatRow} aria-hidden>
            {FLOAT_ICONS.map((icon) => (
              <div
                key={icon.label}
                className={styles.floatIcon}
                style={{ background: `linear-gradient(145deg, ${icon.color}, #fff)` }}
              >
                <span className={styles.floatGlyph}>{icon.glyph}</span>
              </div>
            ))}
          </div>
          <h1 className={styles.title}>{titleNode}</h1>
          <p className={styles.subtitle}>{copy.hero.subtitle}</p>
          <div className={styles.heroCtas}>
            <a
              className={styles.ctaBtn}
              href={copy.hero.primaryCta.href}
              rel="noreferrer"
              target="_blank"
            >
              {copy.hero.primaryCta.label}
            </a>
            <Link className={styles.heroSecondary} href={copy.hero.secondaryCta.href}>
              {copy.hero.secondaryCta.label}
            </Link>
          </div>
        </section>

        <section className={styles.showcase}>
          <div className={styles.showcaseInner}>
            <h2 className={styles.showcaseTitle}>{copy.showcase.title}</h2>
            <div className={styles.showcaseGrid}>
              {copy.showcase.items.map((item) => (
                <article key={item.title} className={styles.showcaseCard}>
                  <strong>{item.title}</strong>
                  <span>{item.blurb}</span>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.products} id="products">
          <h2 className={styles.sectionTitle}>{copy.products.heading}</h2>
          {copy.products.items.map((item, i) => (
            <div
              key={item.title}
              className={`${styles.productRow} ${i % 2 === 1 ? styles.productRowReverse : ""}`}
            >
              <div className={styles.productVisual}>
                <div className={styles.visualCard}>
                  <div>
                    <div className={styles.visualKicker}>{item.visual}</div>
                    <p className={styles.visualTitle}>{item.title}</p>
                  </div>
                  <ul className={styles.visualLines}>
                    {visualLines[item.visual].map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              </div>
              <div className={styles.productCopy}>
                <h3 className={styles.productTitle}>{item.title}</h3>
                <p className={styles.productDesc}>{item.desc}</p>
                <p className={styles.productDetail}>{item.detail}</p>
                <Link className={styles.btnDark} href={item.ctaHref}>
                  {item.ctaLabel} →
                </Link>
              </div>
            </div>
          ))}
        </section>

        <section className={styles.audience}>
          <h2 className={styles.sectionTitle}>{copy.audience.heading}</h2>
          <div className={styles.tabs} role="tablist">
            {copy.audience.tabs.map((tab, i) => (
              <button
                key={tab.name}
                type="button"
                role="tab"
                aria-selected={i === audienceIdx}
                className={`${styles.tab} ${i === audienceIdx ? styles.tabActive : ""}`}
                onClick={() => setAudienceIdx(i)}
              >
                {tab.name}
              </button>
            ))}
          </div>
          <div className={styles.audiencePanel}>
            <div className={styles.audienceInner}>
              <h3>{audience.title}</h3>
              <p>{audience.subtitle}</p>
              <a className={styles.btnDark} href={audience.ctaHref} rel="noreferrer" target={audience.ctaHref.startsWith("http") ? "_blank" : undefined}>
                {audience.ctaLabel} →
              </a>
            </div>
          </div>
        </section>

        <section className={styles.testimonials}>
          <h2 className={styles.sectionTitle}>{copy.testimonials.heading}</h2>
          <div className={styles.testimonialTrack}>
            {copy.testimonials.items.map((item) => (
              <article key={item.name} className={styles.testimonialCard}>
                <p className={styles.quote}>{item.quote}</p>
                <div className={styles.person}>
                  <div className={styles.avatar}>{item.name.slice(0, 1)}</div>
                  <div>
                    <div className={styles.personName}>{item.name}</div>
                    <div className={styles.personRole}>{item.role}</div>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.faq}>
          <h2 className={styles.sectionTitle}>{copy.faq.heading}</h2>
          <div className={styles.faqList}>
            {copy.faq.items.map((item, i) => {
              const open = openFaq.has(i);
              return (
                <article key={item.q} className={styles.faqItem}>
                  <button type="button" className={styles.faqQ} aria-expanded={open} onClick={() => faqToggle(i)}>
                    <span>{item.q}</span>
                    <span aria-hidden>{open ? "▴" : "▾"}</span>
                  </button>
                  {open ? <div className={styles.faqA}>{item.a}</div> : null}
                </article>
              );
            })}
          </div>
        </section>

        <section className={styles.cta}>
          <h2 className={styles.ctaTitle}>{copy.cta.title}</h2>
          <a className={styles.ctaBtn} href={copy.cta.buttonHref} rel="noreferrer" target="_blank">
            {copy.cta.buttonLabel}
          </a>
        </section>
      </main>
    </div>
  );
}
