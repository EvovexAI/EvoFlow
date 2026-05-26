"use client";

import type { ResumePlanFlowDoc, ResumePlanFlowPhase, SiteLocale } from "@ai-site/content";

function phasePillClass(kind: ResumePlanFlowPhase["kind"]) {
  if (kind === "gate") {
    return "border-amber-600/40 bg-amber-100 text-amber-950 dark:border-amber-500/50 dark:bg-amber-950/50 dark:text-amber-50";
  }
  if (kind === "exec") {
    return "border-emerald-600/35 bg-emerald-100 text-emerald-950 dark:border-emerald-500/45 dark:bg-emerald-950/50 dark:text-emerald-50";
  }
  return "border-sky-600/35 bg-sky-100 text-sky-950 dark:border-sky-500/45 dark:bg-sky-950/50 dark:text-sky-50";
}

function legendPillClass(kind: "plan" | "gate" | "exec") {
  return phasePillClass(kind);
}

/** Plan 整体流程示意（简历向：架构 + 阶段，无底层实现名） */
export function PlanFlowDiagram({ plan, locale = "zh" }: { plan: ResumePlanFlowDoc; locale?: SiteLocale }) {
  const en = locale === "en";
  const copy = {
    stateMachine: en ? "Collaboration phases" : "协作阶段",
    architecture: en ? "Architecture" : "架构类型",
    dagTitle: en ? "After approval: subtasks run by dependency waves" : "确认后：子任务按依赖关系分波次推进",
    merge: en ? "Merge & verify" : "汇合验收",
    gateBadge: en ? "Human gate" : "需您确认",
    planningHint: en
      ? "Read, search, clarify — no writes or shell"
      : "阅读、检索、澄清 — 不改代码、不跑命令",
    execHint: en
      ? "Orchestrator advances DAG waves; multi-agent as needed"
      : "编排引擎按 DAG 推进；可多智能体协作",
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-outline-variant/35 bg-surface-low/80 p-5 md:p-7">
      <p className="font-label-ui text-[10px] uppercase tracking-[0.2em] text-foreground-muted">
        {copy.architecture}
      </p>
      <p className="mt-2 text-sm font-medium text-foreground">{plan.architecture}</p>

      <p className="mt-6 font-label-ui text-[10px] uppercase tracking-[0.2em] text-foreground-muted">
        {copy.stateMachine}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {plan.phases.map((p, i) => (
          <span key={p.label} className="inline-flex items-center gap-2">
            <span
              className={`rounded-lg border px-3 py-1.5 text-xs font-semibold tracking-tight ${phasePillClass(p.kind)}`}
            >
              {p.label}
            </span>
            {i < plan.phases.length - 1 ? (
              <span className="text-sm font-medium text-foreground/70" aria-hidden>
                →
              </span>
            ) : null}
          </span>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap gap-2 text-xs font-medium">
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${legendPillClass("plan")}`}>
          <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
          {plan.legendPlanning}
        </span>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${legendPillClass("gate")}`}>
          <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
          {plan.legendGate}
        </span>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${legendPillClass("exec")}`}>
          <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
          {plan.legendExec}
        </span>
      </div>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {plan.steps.map((step, i) => {
          const isGate = step.phase === "闸口" || step.phase === "Gate";
          const isExec = step.phase === "执行" || step.phase === "Run";
          const border = isGate
            ? "border-amber-600/35"
            : isExec
              ? "border-emerald-600/30"
              : "border-outline-variant/40";

          return (
            <article
              key={step.title}
              className={`rounded-xl border ${border} bg-background p-4 shadow-sm`}
            >
              {isGate ? (
                <span
                  className={`mb-2 inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${legendPillClass("gate")}`}
                >
                  {copy.gateBadge}
                </span>
              ) : null}
              <div className="flex gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-sm font-bold text-primary">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
                    {step.phase}
                  </p>
                  <h4 className="mt-0.5 text-sm font-semibold text-foreground">{step.title}</h4>
                  <p className="mt-2 text-sm leading-relaxed text-foreground-muted">{step.detail}</p>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      <div className="mt-8 grid gap-4 rounded-xl border border-outline-variant/30 bg-background p-4 md:grid-cols-2">
        <div>
          <p className="text-xs font-semibold text-foreground">{plan.legendPlanning}</p>
          <p className="mt-1 text-sm text-foreground-muted">{copy.planningHint}</p>
        </div>
        <div>
          <p className="text-xs font-semibold text-foreground">{plan.legendExec}</p>
          <p className="mt-1 text-sm text-foreground-muted">{copy.execHint}</p>
        </div>
      </div>

      <div className="mt-6 rounded-xl border border-outline-variant/30 bg-background p-5">
        <p className="text-xs font-semibold text-foreground">{copy.dagTitle}</p>
        <div className="mt-4 flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-center">
          <div className="rounded-lg border border-sky-600/30 bg-sky-100 px-4 py-2 text-center text-sm font-medium text-sky-950 dark:bg-sky-950/40 dark:text-sky-50">
            {en ? "Step 1" : "步骤 1"}
          </div>
          <span className="hidden text-center text-foreground/60 sm:inline" aria-hidden>
            →
          </span>
          <div className="flex gap-2">
            <div className="flex-1 rounded-lg border border-outline-variant/40 bg-surface-low px-3 py-2 text-center text-sm font-medium text-foreground sm:flex-none">
              {en ? "2a ∥ 2b" : "2a ∥ 2b"}
            </div>
          </div>
          <span className="hidden text-center text-foreground/60 sm:inline" aria-hidden>
            →
          </span>
          <div className="rounded-lg border border-emerald-600/35 bg-emerald-100 px-4 py-2 text-center text-sm font-medium text-emerald-950 dark:bg-emerald-950/40 dark:text-emerald-50">
            {copy.merge}
          </div>
        </div>
      </div>
    </div>
  );
}
