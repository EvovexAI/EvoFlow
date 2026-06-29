"use client";

import { type LocalizedValue, platformPagesByLocale } from "@ai-site/content";
import { SignalPill, SurfaceCard, accentTextClassNames } from "@ai-site/ui";
import { useEffect, useState } from "react";
import { useLocalizedValue } from "../locale-provider";
import { useInView } from "@/hooks/use-in-view";
import { ChevronDown } from "lucide-react";
import {
  AccentEyebrow,
  OutlineHeroWord,
  accentBorderClassNames,
  accentSurfaceClassNames,
} from "./shared";

type CapabilityTrack = {
  category: string;
  color: string;
  level: number;
  name: string;
};

const evolutionLogCopyByLocale: LocalizedValue<{
  timelineLabel: string;
  skillsLabel: string;
  filterAll: string;
  expandHint: string;
  categoryLabels: Record<string, string>;
  tracks: CapabilityTrack[];
}> = {
  zh: {
    timelineLabel: "能力演进时间线",
    skillsLabel: "核心功能覆盖（产品能力，非技术栈）",
    filterAll: "全部",
    expandHint: "点击展开",
    categoryLabels: {
      All: "全部",
      LongRunning: "长任务与编排",
      Observability: "监控与人机协同",
      Integration: "集成与自动化",
    },
    tracks: [
      { name: "超级总控智能体（Supervisor）长任务模式（规划—执行—复盘闭环）", category: "LongRunning", level: 96, color: "#d0bcff" },
      { name: "核心 Plan 与用户意图澄清（多轮询问对齐目标）", category: "LongRunning", level: 94, color: "#c4b5fd" },
      { name: "上下游任务依赖（DAG / 前置完成后解锁下游）", category: "LongRunning", level: 95, color: "#a78bfa" },
      { name: "步骤间信息传递（上下文、工件、结构化输出）", category: "LongRunning", level: 93, color: "#8b5cf6" },
      { name: "异步等待与同步汇合（并行子任务与汇合点）", category: "LongRunning", level: 92, color: "#7c3aed" },
      { name: "任务监控与进度可视（全局与子任务状态）", category: "Observability", level: 95, color: "#5de6ff" },
      { name: "子任务并发与队列调度", category: "LongRunning", level: 90, color: "#22d3ee" },
      { name: "持续任务 / 长周期运行（可暂停、续跑）", category: "LongRunning", level: 91, color: "#06b6d4" },
      { name: "超级总控智能体（Supervisor）看进度、纠错、重试与重新编排", category: "Observability", level: 94, color: "#94e2d5" },
      { name: "与 Claude Code 等编码工具链协同（研发类长任务）", category: "Integration", level: 88, color: "#fbbf24" },
      { name: "智能体控制的自动化（巡检 / 报表触发）", category: "Integration", level: 89, color: "#f59e0b" },
      { name: "自动化结果汇总与飞书（Lark）汇报", category: "Integration", level: 87, color: "#ea580c" },
    ],
  },
  en: {
    timelineLabel: "Capability timeline",
    skillsLabel: "Product capability coverage (not a tech stack)",
    filterAll: "All",
    expandHint: "Click to expand",
    categoryLabels: {
      All: "All",
      LongRunning: "Long-running orchestration",
      Observability: "Monitoring & human-in-the-loop",
      Integration: "Integrations & automation",
    },
    tracks: [
      { name: "Supervisor long-running mode (plan–execute–review)", category: "LongRunning", level: 96, color: "#d0bcff" },
      { name: "Core plan & intent clarification (multi-turn alignment)", category: "LongRunning", level: 94, color: "#c4b5fd" },
      { name: "Upstream/downstream dependencies (DAG / gated steps)", category: "LongRunning", level: 95, color: "#a78bfa" },
      { name: "Information handoff between steps (context & artifacts)", category: "LongRunning", level: 93, color: "#8b5cf6" },
      { name: "Async wait & sync merge (parallel branches, join points)", category: "LongRunning", level: 92, color: "#7c3aed" },
      { name: "Task monitoring & progress (global and sub-task views)", category: "Observability", level: 95, color: "#5de6ff" },
      { name: "Sub-task concurrency & scheduling", category: "LongRunning", level: 90, color: "#22d3ee" },
      { name: "Continuous / durable runs (pause, resume)", category: "LongRunning", level: 91, color: "#06b6d4" },
      { name: "Lead supervisor: progress, correction, retry, re-orchestration", category: "Observability", level: 94, color: "#94e2d5" },
      { name: "Claude Code–style coding workflows (engineering tasks)", category: "Integration", level: 88, color: "#fbbf24" },
      { name: "Agent-driven scheduled jobs (cron-like triggers)", category: "Integration", level: 89, color: "#f59e0b" },
      { name: "Scheduled summaries pushed to Feishu / Lark", category: "Integration", level: 87, color: "#ea580c" },
    ],
  },
};

const SKILL_CATEGORIES = ["All", "LongRunning", "Observability", "Integration"] as const;
const CATEGORY_COLORS: Record<string, string> = {
  LongRunning: "#a78bfa",
  Observability: "#5de6ff",
  Integration: "#f59e0b",
};


function SkillsPanel({
  copy,
}: {
  copy: {
    categoryLabels: Record<string, string>;
    filterAll: string;
    tracks: CapabilityTrack[];
  };
}) {
  const { ref, inView } = useInView(0.1);
  const [selectedCat, setSelectedCat] = useState("All");

  const filtered = copy.tracks.filter(
    (s) => selectedCat === "All" || s.category === selectedCat,
  );

  return (
    <div ref={ref}>
      {/* Category filter */}
      <div className="mb-6 flex flex-wrap gap-2">
        {SKILL_CATEGORIES.map((cat) => (
          <button
            key={cat}
            onClick={() => setSelectedCat(cat)}
            className={[
              "rounded-full px-4 py-1.5 font-label-ui text-[11px] uppercase tracking-[0.2em] transition-all duration-200",
              selectedCat === cat
                ? "bg-primary/15 text-primary border border-primary/20"
                : "border border-white/[0.06] bg-white/[0.03] text-foreground-muted hover:border-white/10 hover:text-foreground",
            ].join(" ")}
            type="button"
          >
            {copy.categoryLabels[cat] ?? cat}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {filtered.map((skill, i) => (
          <div
            key={skill.name}
            className={[
              "rounded-[16px] border border-white/[0.06] bg-surface-low p-4 transition-all duration-700",
              inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4",
            ].join(" ")}
            style={{ transitionDelay: `${i * 50}ms` }}
          >
            <div className="mb-2.5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: skill.color }}
                />
                <span className="font-label-ui text-[12px] font-medium tracking-[-0.01em]">
                  {skill.name}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className="font-label-ui text-[10px] uppercase tracking-[0.16em]"
                  style={{ color: CATEGORY_COLORS[skill.category] ?? "#888" }}
                >
                  {copy.categoryLabels[skill.category] ?? skill.category}
                </span>
                <span className="font-label-ui text-[11px] text-foreground-muted">
                  {skill.level}%
                </span>
              </div>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
              <div
                className="h-full rounded-full transition-all duration-1000 ease-out"
                style={{
                  width: inView ? `${skill.level}%` : "0%",
                  background: skill.color,
                  transitionDelay: `${i * 50 + 200}ms`,
                  boxShadow: `0 0 8px ${skill.color}60`,
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TimelineItem({
  item,
  index,
  isLast,
  expandHint,
}: {
  item: { accent: "primary" | "secondary" | "tertiary"; date: string; description: string; title: string };
  index: number;
  isLast: boolean;
  expandHint: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const { ref, inView } = useInView(0.1);

  const accentColor = item.accent === "primary" ? "#d0bcff" : item.accent === "secondary" ? "#94e2d5" : "#cba6f7";

  return (
    <div
      ref={ref}
      className={[
        "grid gap-4 md:grid-cols-[140px_minmax(0,1fr)] transition-all duration-700",
        inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-5",
      ].join(" ")}
      style={{ transitionDelay: `${index * 80}ms` }}
    >
      <div className="pt-4">
        <SignalPill accent={item.accent}>{item.date}</SignalPill>
      </div>
      <div className="relative">
        {!isLast ? (
          <div
            className="absolute left-[11px] top-10 h-[calc(100%+1.5rem)] w-px"
            style={{
              background: `linear-gradient(to bottom, ${accentColor}40, transparent)`,
            }}
          />
        ) : null}

        {/* Node */}
        <div className="absolute left-0 top-3 h-[22px] w-[22px] rounded-full border border-white/[0.08] bg-surface" />
        <div
          className="absolute left-[5px] top-[17px] h-3 w-3 rounded-full transition-all duration-300"
          style={{
            background: accentColor,
            boxShadow: expanded ? `0 0 12px ${accentColor}80` : "none",
          }}
        />

        {/* Card */}
        <SurfaceCard
          className={[
            "ml-10 cursor-pointer transition-all duration-300",
            expanded ? "border-opacity-30" : "",
            item.accent === "primary"
              ? "hover:border-primary/20"
              : item.accent === "secondary"
                ? "hover:border-secondary/20"
                : "hover:border-tertiary/20",
          ].join(" ")}
          padding="lg"
          radius="md"
          onClick={() => setExpanded((v) => !v)}
        >
          <div className="flex items-start justify-between gap-4">
            <h3 className="font-display-ui text-xl font-semibold tracking-[-0.04em] md:text-2xl">
              {item.title}
            </h3>
            <button
              className={[
                "mt-1 shrink-0 rounded-full p-1 transition-all duration-200",
                expanded ? "rotate-180 text-foreground" : "text-foreground-muted",
              ].join(" ")}
              type="button"
            >
              <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.5} />
            </button>
          </div>
          <div
            className={[
              "overflow-hidden transition-all duration-400",
              expanded ? "max-h-40 mt-3" : "max-h-0",
            ].join(" ")}
          >
            <p className="text-sm leading-7 text-foreground-muted">
              {item.description}
            </p>
          </div>
          {!expanded && (
            <p className="mt-2 text-[11px] text-foreground-muted/50 font-label-ui uppercase tracking-[0.16em]">
              {expandHint} ↓
            </p>
          )}
        </SurfaceCard>
      </div>
    </div>
  );
}

export function EvolutionLogPage() {
  const content = useLocalizedValue(platformPagesByLocale).evolution;
  const copy = useLocalizedValue(evolutionLogCopyByLocale);

  return (
    <main className="relative overflow-hidden px-6 pb-24 pt-16 md:px-10">
      <div className="pointer-events-none absolute left-[4%] top-0 h-72 w-72 rounded-full bg-primary/10 blur-[140px]" />
      <div className="pointer-events-none absolute right-[8%] top-32 h-80 w-80 rounded-full bg-secondary/10 blur-[160px]" />
      <div className="pointer-events-none absolute bottom-32 left-1/3 h-64 w-64 rounded-full bg-tertiary/8 blur-[120px]" />

      {/* Hero */}
      <section className="relative">
        <AccentEyebrow accent="primary">{content.hero.eyebrow}</AccentEyebrow>
        <div className="mt-6 flex flex-col gap-6">
          <OutlineHeroWord word="EVOLUTION" />
          <h1 className="font-display-ui max-w-4xl text-4xl font-semibold tracking-[-0.05em] md:text-6xl">
            {content.hero.title}
          </h1>
          <p className="max-w-2xl text-lg leading-8 text-foreground-muted">
            {content.hero.description}
          </p>
        </div>
      </section>

      {/* Pillars */}
      <section className="mt-20 grid gap-6 md:grid-cols-3">
        {content.pillars.map((pillar, i) => (
          <SurfaceCard
            className={[accentBorderClassNames[pillar.accent], "transition-all duration-700"].join(" ")}
            key={pillar.title}
            padding="lg"
            radius="md"
            style={{ animationDelay: `${i * 100}ms` }}
          >
            <div
              className={[
                "inline-flex rounded-full px-3 py-1 font-label-ui text-[10px] uppercase tracking-[0.22em]",
                accentSurfaceClassNames[pillar.accent],
                accentTextClassNames[pillar.accent],
              ].join(" ")}
            >
              {pillar.eyebrow}
            </div>
            <h2 className="font-display-ui mt-4 text-2xl font-semibold tracking-[-0.04em]">
              {pillar.title}
            </h2>
            <p className="mt-4 text-sm leading-7 text-foreground-muted">
              {pillar.description}
            </p>
          </SurfaceCard>
        ))}
      </section>

      {/* Product capability coverage (replaces legacy tech-stack chart) */}
      <section className="mt-24">
        <div className="mb-10 flex items-center gap-4">
          <AccentEyebrow accent="tertiary">{copy.skillsLabel}</AccentEyebrow>
          <div className="h-px flex-1 bg-gradient-to-r from-tertiary/30 to-transparent" />
        </div>
        <SkillsPanel copy={copy} />
      </section>

      {/* Timeline */}
      <section className="mt-24">
        <div className="mb-10 flex items-center gap-4">
          <AccentEyebrow accent="secondary">{copy.timelineLabel}</AccentEyebrow>
          <div className="h-px flex-1 bg-gradient-to-r from-secondary/30 to-transparent" />
        </div>

        <div className="grid gap-6">
          {content.timeline.map((item, index) => (
            <TimelineItem
              key={`${item.date}-${item.title}`}
              expandHint={copy.expandHint}
              index={index}
              isLast={index === content.timeline.length - 1}
              item={item}
            />
          ))}
        </div>
      </section>
    </main>
  );
}
