"use client";

import Link from "next/link";
import { homeContentByLocale } from "@ai-site/content";
import {
  SectionHeading,
  SignalLine,
  SurfaceCard,
  accentDotClassNames,
  accentGlowClassNames,
  accentTextClassNames,
} from "@ai-site/ui";
import { Fragment, useMemo, type CSSProperties } from "react";
import { useLocalizedValue } from "../locale-provider";
import { useHomeTour } from "../tour/home-tour";
import { ProductArchitectureDiagram } from "./product-architecture-diagram";
import { useInView } from "@/hooks/use-in-view";
import { StaggerGroup, StaggerItem } from "../motion-primitives";

type HomeContent = (typeof homeContentByLocale)["en"];

type HomeAccentCard = HomeContent["hero"]["featureCards"][number];

function accentFeatureCardSurface(accent: HomeAccentCard["accent"]) {
  switch (accent) {
    case "primary":
      return "border-primary/15 bg-primary/[0.04]";
    case "secondary":
      return "border-secondary/15 bg-secondary/[0.04]";
    case "tertiary":
      return "border-tertiary/15 bg-tertiary/[0.04]";
    default:
      return "border-white/[0.08] bg-white/[0.02]";
  }
}

function splitCapabilityBullet(line: string): { kicker: string; detail: string } {
  const zh = line.indexOf("：");
  if (zh > 0) {
    return { kicker: line.slice(0, zh).trim(), detail: line.slice(zh + 1).trim() };
  }
  const en = line.indexOf(": ");
  if (en > 0) {
    return { kicker: line.slice(0, en).trim(), detail: line.slice(en + 2).trim() };
  }
  return { kicker: "", detail: line };
}

function CapabilityFlowStrip({
  labels,
  variant,
}: {
  labels: readonly [string, string, string];
  variant: "primary" | "secondary";
}) {
  const pill =
    variant === "primary"
      ? "border-primary/30 bg-primary/[0.1] text-foreground shadow-[0_0_20px_-8px_rgba(208,188,255,0.35)]"
      : "border-secondary/30 bg-secondary/[0.09] text-foreground shadow-[0_0_20px_-8px_rgba(93,230,255,0.22)]";
  return (
    <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
      {labels.map((label, i) => (
        <Fragment key={`${label}-${i}`}>
          <span
            className={[
              "rounded-lg px-2.5 py-1.5 text-center font-mono text-[10px] font-semibold tracking-wide sm:text-[11px]",
              pill,
            ].join(" ")}
          >
            {label}
          </span>
          {i < 2 ? (
            <span className="select-none text-xs text-foreground-muted/35 sm:text-sm" aria-hidden>
              →
            </span>
          ) : null}
        </Fragment>
      ))}
    </div>
  );
}

function CapabilityTimelineBullets({
  bullets,
  accent,
  deemphasizeLast,
}: {
  bullets: string[];
  accent: "primary" | "secondary";
  deemphasizeLast?: boolean;
}) {
  const dot = accent === "primary" ? accentDotClassNames.primary : accentDotClassNames.secondary;
  const spine =
    accent === "primary"
      ? "from-primary/35 via-white/12 to-transparent"
      : "from-secondary/35 via-white/12 to-transparent";

  return (
    <ul className="mt-8 space-y-0">
      {bullets.map((bullet, i) => {
        const { kicker, detail } = splitCapabilityBullet(bullet);
        const isLast = i === bullets.length - 1;
        const soft = Boolean(deemphasizeLast && isLast);
        return (
          <li
            key={bullet}
            className={[
              "flex gap-4",
              soft ? "rounded-xl border border-dashed border-secondary/25 bg-secondary/[0.04] px-3 py-3" : "pb-1",
            ].join(" ")}
          >
            <div className="flex w-4 shrink-0 flex-col items-center pt-1">
              <span className={["h-2 w-2 shrink-0 rounded-full", dot].join(" ")} />
              {!isLast ? <span className={["mt-2 h-10 w-px shrink-0 bg-gradient-to-b", spine].join(" ")} /> : null}
            </div>
            <div className="min-w-0 flex-1 pb-5">
              {kicker ? (
                <p className="font-display-ui text-sm font-semibold tracking-[-0.02em] text-foreground">{kicker}</p>
              ) : null}
              <p
                className={[
                  "mt-1 text-sm leading-relaxed",
                  soft ? "text-foreground-muted/80" : "text-foreground-muted",
                ].join(" ")}
              >
                {kicker ? detail : bullet}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function HomeAccentCardGrid({
  cards,
  gridClassName,
}: {
  cards: HomeAccentCard[];
  /** 默认用于 Hero 区八大支柱等；架构模块等可传入自定义列数 */
  gridClassName?: string;
}) {
  return (
    <div
      className={
        gridClassName ?? "mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-4"
      }
    >
      {cards.map((card) => (
        <div
          key={card.title}
          className={[
            "rounded-2xl border p-4 transition-colors",
            accentFeatureCardSurface(card.accent),
            "hover:border-white/12",
          ].join(" ")}
        >
          <div className="flex items-start gap-2">
            <span className={["mt-1.5 h-2 w-2 shrink-0 rounded-full", accentDotClassNames[card.accent]].join(" ")} />
            <div>
              <p className="font-display-ui text-sm font-semibold tracking-[-0.02em] text-foreground">{card.title}</p>
              <p className="mt-2 text-xs leading-6 text-foreground-muted md:text-[13px]">{card.description}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function tourSectionClassName(baseClassName: string, isActive: boolean) {
  return [
    baseClassName,
    "scroll-mt-28 transition-all duration-500",
    isActive
      ? "relative z-20 rounded-[36px] ring-1 ring-white/10 shadow-[0_0_0_1px_rgba(208,188,255,0.18),0_0_90px_-28px_rgba(208,188,255,0.34)]"
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function parseOffsetPercent(offset: string): number {
  const n = Number.parseFloat(String(offset).replace(/%/g, "").trim());
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
}

/** 与 `evolutionPulse.events[].offset` 同步的轨道光点 + 节点脉冲时间轴（避免 globals 里写死百分比错位） */
function useEvolutionRailMotion(events: HomeContent["evolutionPulse"]["events"]) {
  return useMemo(() => {
    const positions = events.map((e) => parseOffsetPercent(e.offset));
    const n = positions.length;
    if (n === 0) {
      return {
        keyframesBlock: "",
        railName: "rail-travel" as const,
        durationSec: 5,
        nodeArrivalFrac: [] as number[],
      };
    }

    const dwellFrac = Math.min(0.1, 0.82 / n);
    const travelFracEach = n > 1 ? Math.max(0.02, (1 - n * dwellFrac) / (n - 1)) : 0;
    const d = dwellFrac;
    const r = travelFracEach;

    const steps: string[] = [];
    const nodeArrivalFrac: number[] = [];

    let t = 0;
    const key = (frac: number, left: number) =>
      `${(frac * 100).toFixed(3)}% { left: ${left}%; transform: translate(-50%, -50%); }`;

    for (let i = 0; i < n; i++) {
      nodeArrivalFrac.push(Math.min(1, Math.max(0, t + d * 0.5)));
      steps.push(key(t, positions[i]));
      t += d;
      steps.push(key(t, positions[i]));
      if (i < n - 1) {
        t += r;
        steps.push(key(t, positions[i + 1]));
      }
    }
    if (t < 1) {
      steps.push(key(1, positions[n - 1]));
    }

    const railName = "evolution-rail-sync";
    const durationSec = Math.min(14, Math.max(7.5, 0.9 * n + 5.5));
    const keyframesBlock = `@keyframes ${railName} {\n  ${steps.join("\n  ")}\n}`;

    return { keyframesBlock, railName, durationSec, nodeArrivalFrac };
  }, [events]);
}

export function HomePage() {
  const homeContent = useLocalizedValue(homeContentByLocale);
  const { activeTargetId, tourUi } = useHomeTour();

  return (
    <main className="flex-1">
      {tourUi}
      <HeroSection
        hero={homeContent.hero}
        isActive={activeTargetId === "hero"}
      />
      <CapabilitiesSection
        capabilities={homeContent.capabilities}
        isActive={activeTargetId === "capabilities"}
      />
      <ScenariosSection
        isActive={activeTargetId === "scenarios"}
        scenariosSection={homeContent.scenariosSection}
      />
      <EvolutionPulseSection
        evolutionPulse={homeContent.evolutionPulse}
        isActive={activeTargetId === "evolution-pulse"}
      />
      <ClosingSection
        closingNote={homeContent.closingNote}
        isActive={activeTargetId === "portals"}
      />
    </main>
  );
}

function HeroSection({
  hero,
  isActive,
}: {
  hero: HomeContent["hero"];
  isActive: boolean;
}) {
  return (
    <section
      className={tourSectionClassName(
        "relative overflow-hidden px-4 pb-20 pt-32 md:px-6 md:pb-28 md:pt-40",
        isActive,
      )}
      id="hero"
    >
      <div className="pointer-events-none absolute left-[8%] top-24 h-56 w-56 rounded-full bg-primary/10 blur-3xl" />
      <div className="pointer-events-none absolute right-[10%] top-40 h-72 w-72 rounded-full bg-secondary/10 blur-3xl" />
      <div className="pointer-events-none absolute bottom-10 left-1/3 h-48 w-48 rounded-full bg-tertiary/10 blur-3xl" />

      <div className="relative mx-auto w-full max-w-screen-2xl">
        {/* 第一块：产品描述 */}
        <div className="max-w-3xl">
          <h1
            className="font-display-ui animate-fade-up text-2xl font-semibold leading-tight tracking-[-0.04em] text-foreground md:text-4xl"
            style={{ animationDelay: "0ms" }}
          >
            {hero.title}
          </h1>
          <p
            className="animate-fade-up mt-6 max-w-2xl text-base leading-8 text-foreground-muted md:text-lg"
            style={{ animationDelay: "100ms" }}
          >
            {hero.description}
          </p>
        </div>

        {/* 第二块：功能汇总 — 每项一张小卡片 */}
        <div
          className="animate-scale-in relative mt-14 overflow-hidden rounded-[28px] border border-white/[0.06] bg-white/[0.02] p-6 md:mt-20 md:p-8 md:p-10"
          style={{ animationDelay: "200ms" } as CSSProperties}
        >
          <div className="pointer-events-none absolute inset-x-8 top-0 h-px bg-linear-to-r from-transparent via-white/25 to-transparent" />
          <div className="pointer-events-none absolute -right-16 top-12 h-40 w-40 rounded-full bg-primary/[0.16] blur-3xl" />
          <div className="pointer-events-none absolute -left-12 bottom-2 h-32 w-32 rounded-full bg-secondary/10 blur-3xl" />

          <div className="relative">
            <p className="font-label-ui text-[10px] uppercase tracking-[0.22em] text-foreground-muted">{hero.featureSummary.eyebrow}</p>
            <h2 className="font-display-ui mt-2 text-2xl font-semibold tracking-[-0.04em] text-foreground md:text-3xl">
              {hero.featureSummary.title}
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-foreground-muted">{hero.featureSummary.description}</p>

            <HomeAccentCardGrid cards={hero.featureCards} />

            <div className="mt-10 border-t border-white/[0.06] pt-10 md:mt-12 md:pt-12">
              {hero.productArchitecture.eyebrow ? (
                <p className="font-label-ui text-[10px] uppercase tracking-[0.22em] text-foreground-muted">
                  {hero.productArchitecture.eyebrow}
                </p>
              ) : null}
              {hero.productArchitecture.title ? (
                <h3
                  className={[
                    "font-display-ui text-xl font-semibold tracking-[-0.04em] text-foreground md:text-2xl",
                    hero.productArchitecture.eyebrow ? "mt-2" : "",
                  ].join(" ")}
                >
                  {hero.productArchitecture.title}
                </h3>
              ) : null}
              {hero.productArchitecture.description ? (
                <p className="mt-3 max-w-2xl text-sm leading-7 text-foreground-muted">
                  {hero.productArchitecture.description}
                </p>
              ) : null}
              <ProductArchitectureDiagram
                layers={hero.productArchitecture.layers}
                className={
                  hero.productArchitecture.title || hero.productArchitecture.description || hero.productArchitecture.eyebrow
                    ? "mt-6"
                    : ""
                }
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

const scenarioPanelBorderLeft: Record<HomeAccentCard["accent"], string> = {
  primary: "border-l-primary",
  secondary: "border-l-secondary",
  tertiary: "border-l-tertiary",
};

const scenarioCardGlow: Record<HomeAccentCard["accent"], string> = {
  primary: "bg-primary/[0.07]",
  secondary: "bg-secondary/[0.07]",
  tertiary: "bg-tertiary/[0.06]",
};

function CapabilitiesScenarioFloor({
  floor,
  inView,
}: {
  floor: HomeContent["capabilities"]["scenarioFloor"];
  inView: boolean;
}) {
  const hasEyebrow = Boolean(floor.eyebrow?.trim());
  const hasDescription = Boolean(floor.description?.trim());
  const hasIntro = Boolean(floor.intro?.trim());
  const hasHeaderCopy = hasEyebrow || hasDescription || hasIntro;

  return (
    <div
      id="capabilities-detail"
      className={[
        "scroll-reveal-slow scroll-mt-28 mt-16 transition-all duration-700 md:mt-20",
        inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4",
      ].join(" ")}
    >
      {hasEyebrow ? (
        <p className="font-label-ui text-[10px] uppercase tracking-[0.22em] text-foreground-muted">{floor.eyebrow}</p>
      ) : null}
      <h3
        className={[
          "font-display-ui text-2xl font-semibold tracking-[-0.04em] text-foreground md:text-3xl",
          hasEyebrow ? "mt-3" : "",
        ].join(" ")}
      >
        {floor.title}
      </h3>
      {hasDescription ? (
        <p className="mt-4 max-w-3xl text-sm leading-relaxed text-foreground-muted md:text-[15px]">{floor.description}</p>
      ) : null}
      {hasIntro ? (
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-foreground-muted md:text-[15px]">{floor.intro}</p>
      ) : null}

      <div
        className={[
          "flex flex-col gap-10 md:gap-12",
          hasHeaderCopy ? "mt-10 md:mt-12" : "mt-6 md:mt-8",
        ].join(" ")}
      >
        {floor.panels.map((panel, idx) => (
          <div
            key={panel.anchorId}
            className={[
              "scroll-reveal-slow scroll-mt-28 transition-all duration-700",
              inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4",
            ].join(" ")}
            id={panel.anchorId}
            style={{ transitionDelay: inView ? `${60 + idx * 30}ms` : "0ms" }}
          >
            <div
              className={[
                "overflow-hidden rounded-[24px] border border-white/[0.08] border-l-[3px] bg-linear-to-br from-white/[0.05] to-transparent p-6 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] md:p-8",
                scenarioPanelBorderLeft[panel.accent],
              ].join(" ")}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className={["h-2 w-2 shrink-0 rounded-full", accentDotClassNames[panel.accent]].join(" ")} />
                  <h4 className="font-display-ui text-lg font-semibold tracking-[-0.03em] text-foreground md:text-xl">{panel.title}</h4>
                </div>
                {panel.tags && panel.tags.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {panel.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-foreground-muted"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>

              <p className="mt-5 max-w-3xl text-sm leading-relaxed text-foreground/85 md:text-[15px] md:leading-7">{panel.lead}</p>

              <div className="mt-6 grid gap-2.5 sm:grid-cols-2 sm:gap-3">
                {panel.highlights.map((line, i) => (
                  <div
                    key={line}
                    className="flex gap-3 rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-3 md:px-4 md:py-3.5"
                  >
                    <span
                      className={[
                        "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border font-mono text-[10px] font-semibold tabular-nums",
                        panel.accent === "primary"
                          ? "border-primary/30 bg-primary/[0.12] text-primary"
                          : panel.accent === "secondary"
                            ? "border-secondary/30 bg-secondary/[0.12] text-secondary"
                            : "border-tertiary/30 bg-tertiary/[0.12] text-tertiary",
                      ].join(" ")}
                    >
                      {i + 1}
                    </span>
                    <p className="min-w-0 text-sm leading-relaxed text-foreground-muted md:text-[14px]">{line}</p>
                  </div>
                ))}
              </div>

              {panel.links && panel.links.length > 0 ? (
                <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 border-t border-white/[0.06] pt-5">
                  {panel.links.map((item) =>
                    item.href.startsWith("http") ? (
                      <a
                        key={item.href}
                        className="inline-flex items-center gap-1 text-sm font-medium text-primary transition-colors hover:text-primary/90 hover:underline"
                        href={item.href}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        {item.label}
                        <span aria-hidden>→</span>
                      </a>
                    ) : (
                      <Link
                        key={item.href}
                        className="inline-flex items-center gap-1 text-sm font-medium text-primary transition-colors hover:text-primary/90 hover:underline"
                        href={item.href}
                      >
                        {item.label}
                        <span aria-hidden>→</span>
                      </Link>
                    ),
                  )}
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CapabilitiesSupervisorPlanFocus({
  focus,
  inView,
}: {
  focus: HomeContent["capabilities"]["focusBand"];
  inView: boolean;
}) {
  return (
    <div
      className={[
        "scroll-reveal-slow mt-10 transition-all duration-700 md:mt-12",
        inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4",
      ].join(" ")}
    >
      <div className="grid gap-4 lg:grid-cols-2 lg:gap-6 lg:items-stretch">
        <div className="relative overflow-hidden rounded-[24px] border border-primary/25 bg-linear-to-br from-primary/[0.12] via-primary/[0.05] to-transparent p-6 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)] md:p-8">
          <div className="pointer-events-none absolute -right-12 top-0 h-40 w-40 rounded-full bg-primary/20 blur-3xl" />
          <p className="font-label-ui text-[10px] uppercase tracking-[0.22em] text-primary/90">{focus.supervisorCaption}</p>
          <h3 className="font-display-ui relative mt-3 text-xl font-semibold tracking-[-0.03em] text-foreground md:text-2xl">
            {focus.supervisorTitle}
          </h3>
          <p className="relative mt-3 text-sm leading-7 text-foreground-muted md:text-[15px]">{focus.supervisorHook}</p>
          <ul className="relative mt-6 space-y-3 border-t border-white/[0.08] pt-5">
            {focus.supervisorRoles.map((role) => (
              <li key={role.label} className="flex gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/[0.12] font-mono text-xs font-semibold text-primary">
                  {role.label}
                </span>
                <p className="min-w-0 pt-0.5 text-sm leading-6 text-foreground-muted">{role.text}</p>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative flex flex-col overflow-hidden rounded-[24px] border border-white/[0.08] border-l-[3px] border-l-primary bg-white/[0.02] p-6 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] md:p-8">
          <div className="pointer-events-none absolute bottom-0 right-0 h-32 w-32 rounded-full bg-tertiary/10 blur-3xl" />
          <span className="relative inline-flex w-fit items-center rounded-full border border-primary/30 bg-primary/[0.12] px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">
            {focus.planBadge}
          </span>
          <h3 className="font-display-ui relative mt-4 text-lg font-semibold tracking-[-0.03em] text-foreground md:text-xl">
            {focus.planTitle}
          </h3>
          <ul className="relative mt-4 flex-1 space-y-3 text-sm leading-7 text-foreground-muted">
            {focus.planPoints.map((line) => (
              <li key={line} className="flex gap-2.5">
                <span className={["mt-2 h-1.5 w-1.5 shrink-0 rounded-full", accentDotClassNames["primary"]].join(" ")} />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-6 flex flex-col items-center gap-2">
        <div className="h-10 w-px bg-gradient-to-b from-white/25 via-white/12 to-transparent" aria-hidden />
        <p className="max-w-md text-center text-xs leading-relaxed text-foreground-muted md:text-[13px]">{focus.arrowLabel}</p>
      </div>
    </div>
  );
}

function CapabilitiesClosedLoopFlow({
  flow,
  inView,
}: {
  flow: HomeContent["capabilities"]["closedLoopFlow"];
  inView: boolean;
}) {
  return (
    <div
      className={[
        "scroll-reveal-slow mt-6 rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-6 transition-all duration-700 md:mt-8 md:p-8",
        inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4",
      ].join(" ")}
    >
      <p className="font-label-ui text-[10px] uppercase tracking-[0.22em] text-foreground-muted">{flow.label}</p>
      <div className="mt-5 flex flex-col gap-1 md:mt-6 md:flex-row md:items-stretch md:gap-0">
        {flow.steps.map((step, i) => (
          <Fragment key={step.title}>
            <div
              className={[
                "relative flex-1 rounded-2xl border p-4 md:min-h-[120px]",
                i === 0
                  ? "border-primary/35 bg-primary/[0.07] shadow-[0_0_0_1px_rgba(208,188,255,0.12)]"
                  : "border-white/[0.06] bg-white/[0.03]",
              ].join(" ")}
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span
                  className={[
                    "font-mono text-[10px] font-medium tabular-nums tracking-wide",
                    i === 0 ? "text-primary" : "text-foreground-muted",
                  ].join(" ")}
                >
                  {flow.stepPrefix} {i + 1}
                </span>
                <span className={["h-2 w-2 shrink-0 rounded-full", accentDotClassNames[step.accent]].join(" ")} />
              </div>
              {i === 0 ? (
                <p className="mb-1 inline-block rounded bg-primary/15 px-2 py-0.5 font-mono text-[9px] font-semibold tracking-wider text-primary">
                  {flow.planStepTag}
                </p>
              ) : null}
              <p className="font-display-ui text-sm font-semibold tracking-[-0.02em] text-foreground">{step.title}</p>
              <p className="mt-2 text-xs leading-6 text-foreground-muted md:text-[13px]">{step.summary}</p>
            </div>
            {i < flow.steps.length - 1 ? (
              <div className="flex justify-center py-0.5 md:w-9 md:shrink-0 md:items-center md:justify-center md:py-0">
                <span className="text-sm text-foreground-muted/45 select-none md:text-base" aria-hidden>
                  <span className="md:hidden">↓</span>
                  <span className="hidden md:inline">→</span>
                </span>
              </div>
            ) : null}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function CapabilitiesSection({
  capabilities,
  isActive,
}: {
  capabilities: HomeContent["capabilities"];
  isActive: boolean;
}) {
  const { ref, inView } = useInView();

  return (
    <section
      ref={ref}
      className={tourSectionClassName(
        "mx-auto w-full max-w-screen-2xl px-4 py-24 md:px-6",
        isActive,
      )}
      id="capabilities"
    >
      <div className={["scroll-reveal transition-all duration-700", inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-5"].join(" ")}>
        <SectionHeading
          description={capabilities.description}
          eyebrow={capabilities.eyebrow}
          title={capabilities.title}
        />
      </div>

      <CapabilitiesSupervisorPlanFocus focus={capabilities.focusBand} inView={inView} />

      <CapabilitiesClosedLoopFlow flow={capabilities.closedLoopFlow} inView={inView} />

      <div className="scroll-reveal-slow mt-14 grid gap-6 md:grid-cols-12">
        <SurfaceCard className="md:col-span-7" padding="xl" radius="lg">
          <div className="pointer-events-none absolute right-0 top-0 h-60 w-60 rounded-full bg-primary/10 blur-3xl" />
          <div className="pointer-events-none absolute bottom-0 left-0 h-48 w-48 rounded-full bg-secondary/10 blur-3xl" />

          <div className="relative">
            <p className="text-xs uppercase tracking-[0.24em] text-primary">{capabilities.primaryCard.eyebrow}</p>
            <h3 className="font-display-ui mt-4 max-w-xl text-3xl font-semibold tracking-[-0.04em] md:text-4xl lg:text-5xl">
              {capabilities.primaryCard.title}
            </h3>
            <p className="mt-5 max-w-xl text-base leading-8 text-foreground-muted">
              {capabilities.primaryCard.description}
            </p>
            <SignalLine accent="primary" className="mt-6 max-w-md" />
            <div className="mt-5">
              <CapabilityFlowStrip labels={capabilities.primaryCard.flowStrip} variant="primary" />
            </div>
            <CapabilityTimelineBullets accent="primary" bullets={capabilities.primaryCard.bullets} />
          </div>
        </SurfaceCard>

        <SurfaceCard className="md:col-span-5" padding="lg" radius="lg">
          <p className="text-xs uppercase tracking-[0.24em] text-secondary">{capabilities.secondaryCard.eyebrow}</p>
          <h3 className="font-display-ui mt-4 text-2xl font-semibold tracking-[-0.04em] md:text-3xl">
            {capabilities.secondaryCard.title}
          </h3>
          <p className="mt-4 text-base leading-7 text-foreground-muted">{capabilities.secondaryCard.description}</p>
          <SignalLine accent="secondary" className="mt-5" />
          <div className="mt-5">
            <CapabilityFlowStrip labels={capabilities.secondaryCard.flowStrip} variant="secondary" />
          </div>
          <CapabilityTimelineBullets
            accent="secondary"
            bullets={capabilities.secondaryCard.bullets}
            deemphasizeLast
          />
        </SurfaceCard>
      </div>

      <CapabilitiesScenarioFloor floor={capabilities.scenarioFloor} inView={inView} />
    </section>
  );
}

function ScenariosSection({
  scenariosSection,
  isActive,
}: {
  scenariosSection: HomeContent["scenariosSection"];
  isActive: boolean;
}) {
  const { ref, inView } = useInView(0.08);
  const h = scenariosSection.cardHeadings;

  return (
    <section
      ref={ref}
      className={tourSectionClassName("border-y border-outline-variant/15 bg-surface-lowest/80 py-24 md:py-28", isActive)}
      id="scenarios"
    >
      <div
        className={["mx-auto w-full max-w-screen-2xl px-4 transition-all duration-700 md:px-6", inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-5"].join(" ")}
      >
        <SectionHeading
          description={scenariosSection.description}
          eyebrow={scenariosSection.eyebrow}
          title={scenariosSection.title}
        />

        <StaggerGroup className="mt-12 grid list-none grid-cols-1 gap-6 md:mt-16 md:grid-cols-2 md:gap-7">
          {scenariosSection.scenarios.map((s, index) => (
            <StaggerItem key={s.title} className="h-full">
              <SurfaceCard className="flex h-full flex-col" padding="lg" radius="lg" variant="soft">
                <div
                  className={["pointer-events-none absolute -right-4 top-0 h-36 w-36 rounded-full blur-3xl", scenarioCardGlow[s.accent]].join(
                    " ",
                  )}
                />
                <div className="relative flex flex-1 flex-col">
                  <div className="flex items-start gap-3">
                    <span
                      className={["mt-1.5 h-2 w-2 shrink-0 rounded-full", accentDotClassNames[s.accent]].join(" ")}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-[11px] tabular-nums tracking-wider text-foreground-muted/80">
                        {String(index + 1).padStart(2, "0")}
                      </p>
                      <h3 className="font-display-ui mt-1 text-lg font-semibold leading-snug tracking-[-0.03em] text-foreground md:text-xl">
                        {s.title}
                      </h3>
                    </div>
                  </div>

                  <dl className="mt-6 flex flex-1 flex-col gap-5 border-t border-outline-variant/15 pt-6">
                    <div>
                      <dt className="text-[11px] font-medium leading-none tracking-wide text-foreground-muted">{h.context}</dt>
                      <dd className="mt-2 text-sm leading-relaxed text-foreground/90 md:text-[15px] md:leading-7">{s.context}</dd>
                    </div>
                    <div>
                      <dt className="text-[11px] font-medium leading-none tracking-wide text-foreground-muted">{h.flow}</dt>
                      <dd className="mt-2 text-sm leading-relaxed text-foreground-muted md:text-[15px] md:leading-7">{s.flow}</dd>
                    </div>
                    <div className="mt-auto">
                      <dt className="text-[11px] font-medium leading-none tracking-wide text-foreground-muted">{h.outcomes}</dt>
                      <dd className="mt-2">
                        <ul className="space-y-2.5 text-sm leading-relaxed text-foreground/85 md:text-[15px] md:leading-7">
                          {s.outcomes.map((line) => (
                            <li key={line} className="flex gap-2.5 pl-0.5">
                              <span className="mt-2.5 h-1 w-1 shrink-0 rounded-full bg-foreground-muted/35" aria-hidden />
                              <span>{line}</span>
                            </li>
                          ))}
                        </ul>
                      </dd>
                    </div>
                  </dl>
                </div>
              </SurfaceCard>
            </StaggerItem>
          ))}
        </StaggerGroup>
      </div>
    </section>
  );
}

function EvolutionPulseSection({
  evolutionPulse,
  isActive,
}: {
  evolutionPulse: HomeContent["evolutionPulse"];
  isActive: boolean;
}) {
  const { ref, inView } = useInView(0.2);
  const { keyframesBlock, railName, durationSec, nodeArrivalFrac } = useEvolutionRailMotion(evolutionPulse.events);

  return (
    <section
      className={tourSectionClassName(
        "mx-auto w-full max-w-screen-2xl px-4 py-24 md:px-6",
        isActive,
      )}
      id="evolution-pulse"
    >
      <div
        className={["scroll-reveal transition-all duration-700", inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"].join(" ")}
        ref={ref}
      >
        <SectionHeading
          eyebrow={evolutionPulse.eyebrow}
          title={evolutionPulse.title}
        />
      </div>

      {/* ── Desktop: horizontal timeline */}
      <div className="relative isolate mt-12 hidden min-h-[min(360px,56vh)] overflow-hidden rounded-[32px] border border-white/[0.05] bg-surface-low px-4 py-28 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] md:mt-14 md:block md:min-h-[400px] md:px-8 md:py-32 lg:px-12">
        {keyframesBlock ? <style dangerouslySetInnerHTML={{ __html: keyframesBlock }} /> : null}
        <div className="pointer-events-none absolute inset-0 z-0 rounded-[32px] bg-[radial-gradient(ellipse_at_50%_50%,rgba(208,188,255,0.04),transparent_70%)]" />

        <SignalLine accent="primary" className="absolute left-[max(1.25rem,6%)] right-[max(1.25rem,6%)] top-1/2 z-[1] -translate-y-1/2" />

        {inView && (
          <div
            className="pointer-events-none absolute top-1/2 z-[3] h-2 w-2 rounded-full bg-primary shadow-[0_0_10px_rgba(208,188,255,0.9)]"
            style={{
              animation: `${keyframesBlock ? railName : "rail-travel"} ${durationSec}s ease-in-out infinite`,
            }}
          />
        )}

        {evolutionPulse.events.map((event, i) => {
          const total = evolutionPulse.events.length;
          const isAbove = i % 2 === 1;
          const anchorPct = parseFloat(String(event.offset).replace(/%/g, "").trim()) || 0;
          /** 首尾锚点外扩；右侧「上轨」卡片略左移，减轻与邻卡重叠 */
          const cardTranslate =
            i === 0 ? "-translate-x-[8%]"
            : i === total - 1 ? "-translate-x-[94%]"
            : isAbove && anchorPct >= 66 ? "-translate-x-[58%]"
            : "-translate-x-1/2";

          const arrivalFrac = nodeArrivalFrac[i] ?? 0;
          const activateDelay = -durationSec * arrivalFrac;

          return (
            <div
              key={`${event.date}-${event.title}`}
              className={[
                "group absolute top-1/2 z-[5] transition-all duration-500",
                inView ? "opacity-100" : "opacity-0",
              ].join(" ")}
              style={{ left: event.offset, transitionDelay: `${i * 80}ms` }}
            >
              <div className="relative z-[6] h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2">
                <div
                  className={[
                    "h-3.5 w-3.5 rounded-full group-hover:scale-125",
                    accentDotClassNames[event.accent],
                  ].join(" ")}
                  style={inView ? {
                    animation: `node-activate ${durationSec}s ease-in-out infinite`,
                    animationDelay: `${activateDelay}s`,
                  } : undefined}
                />
              </div>

              <div
                className={[
                  "absolute left-1/2 z-[4] w-px -translate-x-1/2",
                  isAbove ? "bottom-full mb-0 h-5" : "top-full mt-0 h-5",
                  `bg-gradient-to-b ${accentGlowClassNames[event.accent]}`,
                  "opacity-35 group-hover:opacity-65 transition-opacity duration-300",
                ].join(" ")}
                style={isAbove ? { bottom: "7px" } : { top: "7px" }}
              />

              <div
                className={[
                  "absolute z-[8] w-[min(100%,13rem)] transition-all duration-300 sm:w-[12.5rem] lg:w-52",
                  cardTranslate,
                  isAbove ? "bottom-[3.35rem]" : "top-[3.35rem]",
                  "md:opacity-60 md:group-hover:opacity-100",
                  isAbove ? "md:group-hover:translate-y-0.5" : "md:group-hover:-translate-y-0.5",
                ].join(" ")}
              >
                <div className="relative overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.03] p-4 shadow-[0_8px_30px_rgba(0,0,0,0.3)] backdrop-blur-xl transition-[border-color,box-shadow,background-color] duration-300 group-hover:border-white/[0.11] group-hover:bg-white/[0.045] group-hover:shadow-[0_12px_40px_rgba(0,0,0,0.5)]">
                  <div
                    className={[
                      "pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent to-transparent",
                      event.accent === "primary" ? "via-primary/30"
                        : event.accent === "secondary" ? "via-secondary/30"
                        : "via-tertiary/30",
                    ].join(" ")}
                  />
                  <div className="flex items-center gap-2">
                    <div className={["h-1 w-1 rounded-full shrink-0", accentDotClassNames[event.accent]].join(" ")} />
                    <p
                      className={[
                        "font-label-ui text-[10px] uppercase tracking-[0.22em]",
                        accentTextClassNames[event.accent],
                      ].join(" ")}
                    >
                      {event.date}
                    </p>
                  </div>
                  <p className="font-display-ui mt-2.5 text-[13px] font-semibold leading-5 tracking-[-0.02em]">
                    {event.title}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Mobile: vertical timeline ── */}
      <div className="relative mt-10 rounded-[24px] bg-surface-low px-5 py-8 md:hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_50%,rgba(208,188,255,0.04),transparent_70%)]" />

        <div className="absolute bottom-8 left-7 top-8 w-px bg-gradient-to-b from-primary/30 via-secondary/20 to-transparent" />

        <div className="flex flex-col gap-6">
          {evolutionPulse.events.map((event, i) => (
            <div
              key={`m-${event.date}-${event.title}`}
              className={[
                "relative pl-10 transition-all duration-500",
                inView ? "opacity-100 translate-x-0" : "opacity-0 -translate-x-3",
              ].join(" ")}
              style={{ transitionDelay: `${i * 100}ms` }}
            >
              <div className={["absolute left-[22px] top-2 h-3 w-3 rounded-full ring-2 ring-surface-low", accentDotClassNames[event.accent]].join(" ")} />
              <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 backdrop-blur-xl">
                <div className="flex items-center gap-2">
                  <div className={["h-1 w-1 shrink-0 rounded-full", accentDotClassNames[event.accent]].join(" ")} />
                  <p className={["font-label-ui text-[10px] uppercase tracking-[0.22em]", accentTextClassNames[event.accent]].join(" ")}>
                    {event.date}
                  </p>
                </div>
                <p className="font-display-ui mt-2 text-[13px] font-semibold leading-5 tracking-[-0.02em]">
                  {event.title}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ClosingSection({
  isActive,
  closingNote,
}: {
  isActive: boolean;
  closingNote: string;
}) {
  return (
    <section
      className={tourSectionClassName(
        "mx-auto w-full max-w-screen-2xl px-4 py-20 md:px-6 md:py-24",
        isActive,
      )}
      id="portals"
    >
      <p className="scroll-reveal mx-auto max-w-4xl text-center font-display-ui text-4xl font-semibold leading-tight tracking-[-0.05em] text-foreground md:text-6xl">
        {closingNote}
      </p>
    </section>
  );
}
