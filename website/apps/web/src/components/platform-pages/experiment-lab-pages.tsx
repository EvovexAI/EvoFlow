"use client";

import { type LocalizedValue, platformPagesByLocale, staticPageHref } from "@ai-site/content";
import { MetricTile, SignalPill, SurfaceCard, accentTextClassNames } from "@ai-site/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useLocalizedValue } from "../locale-provider";
import {
  AccentEyebrow,
  OutlineHeroWord,
  accentBorderClassNames,
  accentSurfaceClassNames,
} from "./shared";

const experimentLabCopyByLocale: LocalizedValue<{
  backToLabLabel: string;
  currentHypothesesLabel: string;
  experimentIndexLabel: string;
  returnToOverviewTitle: string;
  seeAllExperimentsLabel: string;
}> = {
  zh: {
    backToLabLabel: "返回 Lab",
    currentHypothesesLabel: "当前假设",
    experimentIndexLabel: "实验索引",
    returnToOverviewTitle: "返回实验总览",
    seeAllExperimentsLabel: "查看全部实验",
  },
  en: {
    backToLabLabel: "Back To Lab",
    currentHypothesesLabel: "Current Hypotheses",
    experimentIndexLabel: "Experiment Index",
    returnToOverviewTitle: "Return to Lab Overview",
    seeAllExperimentsLabel: "See all experiments",
  },
};

export function ExperimentLabPage() {
  const content = useLocalizedValue(platformPagesByLocale).lab;

  return (
    <main className="relative overflow-hidden px-6 pb-24 pt-16 md:px-10">
      <div className="pointer-events-none absolute left-[8%] top-4 h-72 w-72 rounded-full bg-primary/10 blur-[140px]" />
      <div className="pointer-events-none absolute right-[10%] top-28 h-80 w-80 rounded-full bg-secondary/10 blur-[160px]" />

      <section className="relative">
        <AccentEyebrow accent="tertiary">{content.hero.eyebrow}</AccentEyebrow>
        <div className="mt-6 flex flex-col gap-6">
          <OutlineHeroWord word="LAB" />
          <h1 className="font-display-ui max-w-4xl text-4xl font-semibold tracking-[-0.05em] md:text-6xl">
            {content.hero.title}
          </h1>
          <p className="max-w-2xl text-lg leading-8 text-foreground-muted">
            {content.hero.description}
          </p>
        </div>
      </section>

      <section className="mt-20 grid gap-6 lg:grid-cols-3">
        {content.experiments.map((experiment) => (
          <Link className="group block" href={staticPageHref(`/lab/${experiment.slug}/`)} key={experiment.slug}>
            <SurfaceCard
              className={[
                "h-full transition-all duration-300 group-hover:-translate-y-1",
                accentBorderClassNames[experiment.accent],
              ].join(" ")}
              padding="xl"
              radius="lg"
            >
              <div className="flex items-center justify-between gap-4">
                <div
                  className={[
                    "inline-flex rounded-full px-3 py-1 font-label-ui text-[10px] uppercase tracking-[0.22em]",
                    accentSurfaceClassNames[experiment.accent],
                    accentTextClassNames[experiment.accent],
                  ].join(" ")}
                >
                  {experiment.eyebrow}
                </div>
                <SignalPill accent={experiment.accent}>{experiment.status}</SignalPill>
              </div>

              <h2 className="font-display-ui mt-6 text-3xl font-semibold tracking-[-0.04em]">
                {experiment.title}
              </h2>
              <p className="mt-4 text-sm leading-7 text-foreground-muted">
                {experiment.description}
              </p>
              <p className="mt-6 font-label-ui text-[11px] uppercase tracking-[0.2em] text-foreground-muted">
                {experiment.track}
              </p>
            </SurfaceCard>
          </Link>
        ))}
      </section>
    </main>
  );
}

export function ExperimentLabDetailPage({ slug }: { slug: string }) {
  const content = useLocalizedValue(platformPagesByLocale).lab;
  const copy = useLocalizedValue(experimentLabCopyByLocale);
  const router = useRouter();
  const experiment = content.experiments.find((item) => item.slug === slug);

  useEffect(() => {
    if (!experiment) router.replace(staticPageHref("/lab/"));
  }, [experiment, router]);

  if (!experiment) return null;

  return (
    <main className="relative overflow-hidden px-6 pb-24 pt-16 md:px-10">
      <div className="pointer-events-none absolute left-[10%] top-10 h-72 w-72 rounded-full bg-primary/10 blur-[140px]" />
      <div className="pointer-events-none absolute right-[8%] top-24 h-80 w-80 rounded-full bg-secondary/10 blur-[160px]" />

      <section className="relative">
        <div className="flex flex-wrap items-center gap-3">
          <SignalPill accent={experiment.accent}>{experiment.track}</SignalPill>
          <SignalPill accent={experiment.accent}>{experiment.status}</SignalPill>
        </div>
        <h1 className="font-display-ui mt-6 max-w-4xl text-5xl font-semibold tracking-[-0.06em] md:text-7xl">
          {experiment.title}
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-foreground-muted">
          {experiment.description}
        </p>
      </section>

      <section className="mt-16 grid gap-6 md:grid-cols-3">
        {experiment.metrics.map((metric) => (
          <MetricTile
            accent={experiment.accent}
            key={metric.label}
            label={metric.label}
            value={metric.value}
          />
        ))}
      </section>

      <section className="mt-20 grid gap-10 xl:grid-cols-[minmax(0,0.9fr)_minmax(360px,1.1fr)]">
        <div>
          <AccentEyebrow accent={experiment.accent}>{copy.currentHypothesesLabel}</AccentEyebrow>
          <div className="mt-8 grid gap-5">
            {experiment.insights.map((insight) => (
              <SurfaceCard
                className={accentBorderClassNames[experiment.accent]}
                key={insight}
                padding="lg"
                radius="md"
              >
                <p className="text-sm leading-7 text-foreground-muted">{insight}</p>
              </SurfaceCard>
            ))}
          </div>
        </div>

        <aside>
          <AccentEyebrow accent="secondary">{copy.backToLabLabel}</AccentEyebrow>
          <div className="mt-8">
            <Link className="group block" href={staticPageHref("/lab/")}>
              <SurfaceCard padding="xl" radius="lg">
                <p className="font-label-ui text-[10px] uppercase tracking-[0.22em] text-foreground-muted">
                  {copy.experimentIndexLabel}
                </p>
                <h2 className="font-display-ui mt-4 text-3xl font-semibold tracking-[-0.04em]">
                  {copy.returnToOverviewTitle}
                </h2>
                <div
                  className={[
                    "mt-8 inline-flex items-center gap-2 text-sm uppercase tracking-[0.18em] transition-colors group-hover:text-secondary",
                    accentTextClassNames.secondary,
                  ].join(" ")}
                >
                  <span>{copy.seeAllExperimentsLabel}</span>
                  <span aria-hidden="true">→</span>
                </div>
              </SurfaceCard>
            </Link>
          </div>
        </aside>
      </section>
    </main>
  );
}
