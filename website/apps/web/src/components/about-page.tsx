"use client";

import Link from "next/link";
import { type LocalizedValue, siteLinks } from "@ai-site/content";
import { GlassPanel, SignalBar, buttonClassName } from "@ai-site/ui";
import { useLocalizedValue } from "./locale-provider";
import { useInView } from "@/hooks/use-in-view";

const aboutContentByLocale: LocalizedValue<{
  eyebrow: string;
  title: string;
  subtitle: string;
  bio: string[];
  philosophyTitle: string;
  philosophyItems: Array<{ label: string; text: string }>;
  stackTitle: string;
  stack: Array<{ name: string; level: number; color: string }>;
  siteTitle: string;
  siteDescription: string;
  sites: Array<{ label: string; href: string; description: string }>;
  connectTitle: string;
  connectItems: Array<{ label: string; href: string }>;
}> = {
  zh: {
    eyebrow: "关于",
    title: "关于 EvoFlow",
    subtitle: "超级 Agent 驾驭框架 · 编排、记忆、沙箱、Skills/MCP 与 EvoFlow 桌面端一体化（可下载体验）",
    bio: [
      "EvoFlow 面向「认真落地」的多智能体场景：把子 Agent、DAG 式分支汇合、长期记忆、沙箱执行与可扩展技能放在同一条可观测链路上，使「谁做了什么决策、调用了哪条工具链、依据哪些上下文」可被复盘，而不是停留在单次对话演示。",
      "项目继承 DeerFlow 2.0 的工程基线，并持续扩展 EvoFlow 桌面端、技能与 MCP 生态、任务队列与失败重试、以及面向企业的护栏与审计挂钩点，方便团队把模型能力接入工单、运维、内部 Copilot 与企业 RAG 等真实工作流。",
      "本站点是 EvoFlow 的官网壳层：首页提供能力矩阵、典型场景、架构剖面与路线图脉冲；演进日志与 Lab 承载版本叙事与实验骨架。站内不提供面向访客的对话产品。需要 Issue、讨论区与发行说明时，请使用顶栏「GitHub」。",
    ],
    philosophyTitle: "设计原则",
    philosophyItems: [
      {
        label: "可编排",
        text: "显式任务边界、子 Agent 委派与汇合语义、以及可导出轨迹；优先回答「这一步为何发生」而非只给最终自然语言。",
      },
      {
        label: "可扩展",
        text: "Skills 与 MCP 作为一等集成面：版本、依赖与发现流程可团队化；编排核不绑定某一行业 API。",
      },
      {
        label: "可部署",
        text: "沙箱与护栏约束工具与脚本；队列、重试与指标对齐 SRE 习惯；记忆与引用字段可对接留存与脱敏策略。",
      },
      {
        label: "开放路线图",
        text: "以可观测交付与真实场景驱动优先级；社区通过 Issue、Discussions 与 Releases 对齐里程碑，避免暗箱排期。",
      },
    ],
    stackTitle: "实现面与工具链（示意占比）",
    stack: [
      { name: "Python / 后端编排", level: 92, color: "#3776ab" },
      { name: "TypeScript / 工具链", level: 85, color: "#3178c6" },
      { name: "Agent 运行时与任务", level: 90, color: "#d0bcff" },
      { name: "Docker / 部署", level: 78, color: "#2496ed" },
      { name: "EvoFlow 桌面端", level: 80, color: "#61dafb" },
      { name: "MCP / Skills", level: 86, color: "#38bdf8" },
    ],
    siteTitle: "入口矩阵",
    siteDescription: "从能力、场景、架构到路线与实验，再到 GitHub 与文档——按角色跳转时保持同一套术语。",
    sites: [
      { label: "项目官网", href: "/", description: "Hero、能力矩阵、典型场景、架构剖面与路线图脉冲的总览" },
      { label: "能力矩阵", href: "/#capabilities", description: "编排、沙箱、记忆、Skills、MCP 与 EvoFlow 桌面端职责对齐" },
      { label: "典型场景", href: "/#scenarios", description: "工单、运维、Copilot、企业 RAG 等落地叙事" },
      { label: "演进日志", href: "/evolution", description: "里程碑、版本节点与模块成熟度时间线" },
      { label: "实验 Lab", href: "/lab", description: "编排、MCP、Panel 与观测相关的实验骨架" },
    ],
    connectTitle: "链接",
    connectItems: [
      { label: "能力矩阵", href: "/#capabilities" },
      { label: "典型场景", href: "/#scenarios" },
      { label: "演进", href: "/evolution" },
      { label: "GitHub", href: siteLinks.github },
    ],
  },
  en: {
    eyebrow: "About",
    title: "About EvoFlow",
    subtitle: "Super-agent stack — orchestration, memory, sandbox, Skills/MCP, and EvoFlow desktop (downloadable builds)",
    bio: [
      "EvoFlow targets serious multi-agent workloads: sub-agents, DAG-style branching and merges, durable memory, sandboxed execution, and extensible skills on one observable pipeline so you can answer what decision was made, which tool chain ran, and under which context—not a one-off chat demo.",
      "The project builds on DeerFlow 2.0 and keeps evolving the EvoFlow desktop client, the skills and MCP ecosystem, queues and retries, and enterprise-ready guardrails and audit hooks so teams can wire models into tickets, ops, copilots, and enterprise RAG.",
      "This marketing site surfaces the capability matrix, concrete scenarios, architecture slices, and roadmap pulse; the evolution log and Lab carry release narrative and experiment scaffolds. There is no visitor chat product—use GitHub in the header for issues, discussions, and releases.",
    ],
    philosophyTitle: "Principles",
    philosophyItems: [
      {
        label: "Orchestrated",
        text: "Explicit task boundaries, delegate/merge semantics, and exportable traces—optimize for why a step happened, not only the final prose.",
      },
      {
        label: "Extensible",
        text: "Skills and MCP as first-class integration planes with versioning and discovery workflows; the orchestration core stays industry-agnostic.",
      },
      {
        label: "Deployable",
        text: "Sandboxes and policies around tools and scripts; queues, retries, and metrics aligned with SRE practice; memory and citation fields ready for retention and redaction policies.",
      },
      {
        label: "Open",
        text: "Roadmaps grounded in observable delivery and real scenarios; priorities align through issues, discussions, and releases instead of opaque planning.",
      },
    ],
    stackTitle: "Implementation surface (illustrative weighting)",
    stack: [
      { name: "Python / backend", level: 92, color: "#3776ab" },
      { name: "TypeScript / tooling", level: 85, color: "#3178c6" },
      { name: "Agent runtime & jobs", level: 90, color: "#d0bcff" },
      { name: "Docker / ops", level: 78, color: "#2496ed" },
      { name: "EvoFlow desktop", level: 80, color: "#61dafb" },
      { name: "MCP / skills", level: 86, color: "#38bdf8" },
    ],
    siteTitle: "Entry points",
    siteDescription: "Capabilities, scenarios, architecture, roadmap, experiments, then GitHub and docs—with consistent vocabulary per role.",
    sites: [
      { label: "Project site", href: "/", description: "Hero, capability matrix, scenarios, architecture slices, and roadmap pulse" },
      { label: "Capability matrix", href: "/#capabilities", description: "Orchestration, sandbox, memory, Skills, MCP, and EvoFlow alignment" },
      { label: "Scenarios", href: "/#scenarios", description: "Tickets, ops, copilots, enterprise RAG adoption narratives" },
      { label: "Evolution log", href: "/evolution", description: "Milestones, releases, and module maturity over time" },
      { label: "Lab", href: "/lab", description: "Experiment scaffolds for orchestration, MCP, EvoFlow, and telemetry" },
    ],
    connectTitle: "Links",
    connectItems: [
      { label: "Capabilities", href: "/#capabilities" },
      { label: "Scenarios", href: "/#scenarios" },
      { label: "Evolution", href: "/evolution" },
      { label: "GitHub", href: siteLinks.github },
    ],
  },
};

export function AboutPage() {
  const content = useLocalizedValue(aboutContentByLocale);
  const { ref: bioRef, inView: bioInView } = useInView(0.1);
  const { ref: philRef, inView: philInView } = useInView(0.1);
  const { ref: stackRef, inView: stackInView } = useInView(0.1);
  const { ref: siteRef, inView: siteInView } = useInView(0.1);

  return (
    <main className="flex-1">
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute left-[10%] top-28 h-56 w-56 rounded-full bg-primary/10 blur-3xl" />
        <div className="pointer-events-none absolute right-[12%] top-44 h-64 w-64 rounded-full bg-secondary/10 blur-3xl" />
        <div className="pointer-events-none absolute bottom-40 left-1/3 h-44 w-44 rounded-full bg-tertiary/10 blur-3xl" />

        <div className="relative mx-auto w-full max-w-screen-xl px-4 pb-24 pt-36 md:px-8 md:pt-44">
          {/* Header */}
          <div className="mb-20">
            <p className="font-label-ui text-xs uppercase tracking-[0.28em] text-foreground-muted">
              {content.eyebrow}
            </p>
            <h1 className="font-display-ui mt-4 text-5xl font-semibold tracking-[-0.06em] md:text-7xl">
              {content.title}
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-foreground-muted md:text-xl">
              {content.subtitle}
            </p>
          </div>

          {/* Bio */}
          <div
            ref={bioRef}
            className={["scroll-reveal max-w-3xl space-y-6 transition-all duration-700", bioInView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"].join(" ")}
          >
            {content.bio.map((paragraph, i) => (
              <p
                key={i}
                className="text-base leading-8 text-foreground-muted md:text-lg"
                style={{ transitionDelay: `${i * 100}ms` }}
              >
                {paragraph}
              </p>
            ))}
          </div>

          {/* Philosophy */}
          <div ref={philRef} className="scroll-reveal mt-24">
            <h2
              className={["font-display-ui text-3xl font-semibold tracking-[-0.04em] transition-all duration-700 md:text-4xl", philInView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"].join(" ")}
            >
              {content.philosophyTitle}
            </h2>
            <div className="mt-10 grid gap-4 sm:grid-cols-2">
              {content.philosophyItems.map((item, i) => (
                <GlassPanel
                  key={item.label}
                  className={["rounded-2xl p-6 transition-all duration-700", philInView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"].join(" ")}
                  style={{ transitionDelay: `${i * 80}ms` }}
                >
                  <p className="font-label-ui text-[11px] uppercase tracking-[0.22em] text-primary">
                    {item.label}
                  </p>
                  <p className="mt-3 text-sm leading-7 text-foreground-muted">
                    {item.text}
                  </p>
                </GlassPanel>
              ))}
            </div>
          </div>

          {/* Tech Stack */}
          <div ref={stackRef} className="scroll-reveal mt-24">
            <h2
              className={["font-display-ui text-3xl font-semibold tracking-[-0.04em] transition-all duration-700 md:text-4xl", stackInView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"].join(" ")}
            >
              {content.stackTitle}
            </h2>
            <div className="mt-10 grid gap-4 sm:grid-cols-2">
              {content.stack.map((tech, i) => (
                <div
                  key={tech.name}
                  className={["transition-all duration-700", stackInView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"].join(" ")}
                  style={{ transitionDelay: `${i * 60}ms` }}
                >
                  <SignalBar
                    accent={i < 2 ? "secondary" : i < 4 ? "primary" : "tertiary"}
                    animate={stackInView}
                    label={tech.name}
                    value={tech.level}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Site Matrix */}
          <div ref={siteRef} className="scroll-reveal mt-24">
            <h2
              className={["font-display-ui text-3xl font-semibold tracking-[-0.04em] transition-all duration-700 md:text-4xl", siteInView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"].join(" ")}
            >
              {content.siteTitle}
            </h2>
            <p className="mt-3 text-foreground-muted">{content.siteDescription}</p>
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {content.sites.map((site, i) => {
                const isExternal = site.href.startsWith("http");
                const Component = isExternal ? "a" : Link;
                const extraProps = isExternal ? { target: "_blank", rel: "noreferrer" } : {};
                return (
                  <Component
                    key={site.label}
                    href={site.href}
                    className={[
                      "group rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5 transition-all duration-500 hover:border-primary/20 hover:bg-primary/5",
                      siteInView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4",
                    ].join(" ")}
                    style={{ transitionDelay: `${i * 80}ms` }}
                    {...extraProps}
                  >
                    <p className="font-display-ui text-lg font-semibold tracking-[-0.02em] group-hover:text-primary transition-colors">
                      {site.label}
                    </p>
                    <p className="mt-2 text-sm leading-6 text-foreground-muted">
                      {site.description}
                    </p>
                  </Component>
                );
              })}
            </div>
          </div>

          {/* Connect */}
          <div className="mt-24 flex flex-col items-start gap-6 sm:flex-row sm:items-center sm:gap-4">
            <h2 className="font-display-ui text-2xl font-semibold tracking-[-0.04em]">
              {content.connectTitle}
            </h2>
            <div className="flex flex-wrap gap-3">
              {content.connectItems.map((item) => {
                const external = item.href.startsWith("http");
                const className = buttonClassName({ variant: "secondary", size: "md" });
                if (external) {
                  return (
                    <a
                      key={item.label}
                      className={className}
                      href={item.href}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {item.label}
                    </a>
                  );
                }
                return (
                  <Link key={item.label} className={className} href={item.href}>
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
