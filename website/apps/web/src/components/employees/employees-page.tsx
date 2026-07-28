"use client";

import Link from "next/link";
import { employeesPageByLocale, siteLinks } from "@ai-site/content";
import { motion, useScroll, useTransform } from "motion/react";
import { useRef } from "react";
import { useLocalizedValue } from "../locale-provider";
import { MagneticWrap, StaggerGroup, StaggerItem } from "../motion-primitives";

export function EmployeesPage() {
  const copy = useLocalizedValue(employeesPageByLocale);
  const heroRef = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({
    target: heroRef,
    offset: ["start start", "end start"],
  });
  const heroY = useTransform(scrollYProgress, [0, 1], [0, 80]);
  const heroOpacity = useTransform(scrollYProgress, [0, 0.85], [1, 0.25]);

  return (
    <main className="flex-1 overflow-x-hidden">
      <section
        ref={heroRef}
        className="relative isolate min-h-[88vh] overflow-hidden px-4 pb-16 pt-28 md:px-6 md:pt-36"
      >
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_20%_10%,rgba(93,230,255,0.12),transparent_45%),radial-gradient(ellipse_at_80%_0%,rgba(255,180,90,0.1),transparent_40%),linear-gradient(180deg,rgba(255,255,255,0.03),transparent_40%)]" />
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cpath d='M0 60h120M60 0v120' stroke='%23fff' stroke-width='0.5' fill='none'/%3E%3C/svg%3E\")",
          }}
        />

        <motion.div style={{ y: heroY, opacity: heroOpacity }} className="relative mx-auto w-full max-w-screen-xl">
          <motion.p
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
            className="font-label-ui text-[11px] uppercase tracking-[0.28em] text-foreground-muted"
          >
            {copy.hero.brand}
          </motion.p>
          <motion.h1
            initial={{ opacity: 0, y: 28 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
            className="font-display-ui mt-4 max-w-4xl text-[clamp(2.6rem,8vw,5.5rem)] font-semibold leading-[0.95] tracking-[-0.05em] text-foreground"
          >
            {copy.hero.title}
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.18 }}
            className="mt-8 max-w-2xl text-base leading-8 text-foreground-muted md:text-lg"
          >
            {copy.hero.lead}
          </motion.p>
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.28 }}
            className="mt-10 flex flex-wrap gap-3"
          >
            <MagneticWrap>
              <a
                className="inline-flex items-center justify-center rounded-lg bg-foreground px-5 py-3 text-sm font-medium text-background"
                href={copy.hero.primaryCta.href}
                rel="noreferrer"
                target="_blank"
              >
                {copy.hero.primaryCta.label}
              </a>
            </MagneticWrap>
            <Link
              className="inline-flex items-center justify-center rounded-lg border border-outline-variant/35 px-5 py-3 text-sm font-medium text-foreground transition-colors hover:bg-surface-high/50"
              href={copy.hero.secondaryCta.href}
            >
              {copy.hero.secondaryCta.label}
            </Link>
            <a
              className="inline-flex items-center justify-center px-3 py-3 text-sm text-foreground-muted hover:text-foreground"
              href={copy.animLinkHref}
            >
              {copy.animLinkLabel}
            </a>
          </motion.div>
        </motion.div>

        <motion.div
          aria-hidden
          className="pointer-events-none absolute bottom-8 left-1/2 h-16 w-px -translate-x-1/2 bg-gradient-to-b from-foreground/40 to-transparent"
          initial={{ scaleY: 0, originY: 0 }}
          animate={{ scaleY: 1 }}
          transition={{ delay: 0.6, duration: 0.8 }}
        />
      </section>

      <section className="border-t border-white/[0.06] px-4 py-20 md:px-6 md:py-28">
        <div className="mx-auto max-w-screen-xl">
          <StaggerGroup className="grid gap-10 md:grid-cols-3 md:gap-8">
            {copy.stages.map((stage) => (
              <StaggerItem key={stage.kicker}>
                <article className="group relative overflow-hidden rounded-[28px] border border-white/[0.08] bg-white/[0.02] p-6 md:p-8">
                  <div className="pointer-events-none absolute -right-8 -top-8 h-28 w-28 rounded-full bg-secondary/10 blur-2xl transition-opacity group-hover:opacity-100" />
                  <p className="font-mono text-xs tracking-[0.2em] text-secondary">{stage.kicker}</p>
                  <h2 className="font-display-ui mt-4 text-xl font-semibold tracking-[-0.03em] text-foreground md:text-2xl">
                    {stage.title}
                  </h2>
                  <p className="mt-4 text-sm leading-7 text-foreground-muted">{stage.body}</p>
                </article>
              </StaggerItem>
            ))}
          </StaggerGroup>
        </div>
      </section>

      <section className="relative overflow-hidden border-t border-white/[0.06] px-4 py-20 md:px-6 md:py-28">
        <div className="pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-tertiary/[0.07] to-transparent" />
        <div className="relative mx-auto max-w-screen-xl">
          <h2 className="font-display-ui text-2xl font-semibold tracking-[-0.04em] text-foreground md:text-3xl">
            {copy.rolesHeading}
          </h2>
          <p className="mt-3 max-w-xl text-sm text-foreground-muted">
            {copy.rolesLead}
          </p>
          <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {copy.roles.map((role, i) => (
              <motion.div
                key={role.name}
                initial={{ opacity: 0, x: i % 2 === 0 ? -16 : 16 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, amount: 0.4 }}
                transition={{ duration: 0.5, delay: i * 0.06 }}
                className="rounded-2xl border border-white/[0.08] bg-background/40 px-5 py-4 backdrop-blur-sm"
              >
                <p className="font-display-ui text-base font-semibold text-foreground">{role.name}</p>
                <p className="mt-2 text-sm leading-6 text-foreground-muted">{role.duty}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-white/[0.06] px-4 py-20 md:px-6 md:py-24">
        <div className="mx-auto flex max-w-screen-xl flex-col items-start gap-6 md:flex-row md:items-end md:justify-between">
          <div className="max-w-xl">
            <h2 className="font-display-ui text-2xl font-semibold tracking-[-0.04em] text-foreground md:text-3xl">
              {copy.closing.title}
            </h2>
            <p className="mt-4 text-sm leading-7 text-foreground-muted">{copy.closing.body}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              className="inline-flex rounded-lg bg-foreground px-5 py-3 text-sm font-medium text-background"
              href={copy.closing.ctaHref}
            >
              {copy.closing.ctaLabel}
            </Link>
            <a
              className="inline-flex rounded-lg border border-outline-variant/35 px-5 py-3 text-sm font-medium text-foreground"
              href={siteLinks.github}
              rel="noreferrer"
              target="_blank"
            >
              GitHub
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}
