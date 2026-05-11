"use client";

import {
  type EvolutionRunSnapshot,
  type JobId,
  type JobRunResponse,
  type JobRunSnapshot,
  type ObservabilitySnapshotResponse,
} from "@ai-site/ai";
import { type LocalizedValue, platformPagesByLocale } from "@ai-site/content";
import {
  FeatureCard,
  MetricTile,
  SignalPill,
  SurfaceCard,
  TerminalPanel,
  accentTextClassNames,
} from "@ai-site/ui";
import Link from "next/link";
import { useCallback, useState } from "react";
import { ArtifactRenderer } from "../ai-ui/artifact-renderer";
import { useLocalizedValue, useSiteLocale } from "../locale-provider";
import {
  AccentEyebrow,
  accentBorderClassNames,
  accentSurfaceClassNames,
} from "./shared";

type AdminJobSchedule = (typeof platformPagesByLocale)["zh"]["adminJobs"]["schedules"][number];

function resolveJobId(scheduleName: string): JobId {
  const normalized = scheduleName.toLowerCase();

  if (normalized.includes("metric")) {
    return "aggregate-metrics";
  }

  if (normalized.includes("github")) {
    return "github-sync";
  }

  if (normalized.includes("blog")) {
    return "blog-sync";
  }

  if (normalized.includes("coding") || normalized.includes("dna")) {
    return "rebuild-coding-dna";
  }

  if (normalized.includes("knowledge") || normalized.includes("ingest")) {
    return "ingest-knowledge";
  }

  return "weekly-digest";
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

const adminPagesCopyByLocale: LocalizedValue<{
  analysisLabel: string;
  adminHeroTitle: string;
  artifactCountLabel: string;
  artifactsEmpty: string;
  artifactsTitle: string;
  completedLabel: string;
  controlSurfacesLabel: string;
  durationLabel: string;
  efficiencyLabel: string;
  evolutionControlsLabel: string;
  failedLabel: string;
  latencyLabel: string;
  lastOperationLabel: string;
  nextRunLabel: string;
  pendingLabel: string;
  radarLabels: string[];
  refreshSnapshotLabel: string;
  refreshingLabel: string;
  queuedLabel: string;
  readyLabel: string;
  recentRunsLabel: string;
  recentSignalsLabel: string;
  runNowLabel: string;
  runningLabel: string;
  sessionVisibilityLabel: string;
  sourceArtifactTitle: string;
  sourcesLabel: string;
  timelineLabel: string;
  traceStreamLabel: string;
  triggerActionLabel: string;
  toolArtifactTitle: string;
  toolCallsLabel: string;
  workerLogLabel: string;
  workerTimeoutLabel: string;
}> = {
  zh: {
    analysisLabel: "执行分析",
    adminHeroTitle: "Admin 应该像任务控制台，而不是通用后台面板",
    artifactCountLabel: "个结果卡片",
    artifactsEmpty: "触发一次运行后，这里会展示共享 artifact protocol 的结果。",
    artifactsTitle: "运行产物",
    completedLabel: "已完成",
    controlSurfacesLabel: "控制界面",
    durationLabel: "耗时",
    efficiencyLabel: "匹配度",
    evolutionControlsLabel: "演化控制",
    failedLabel: "失败",
    latencyLabel: "延迟",
    lastOperationLabel: "最近操作",
    nextRunLabel: "下次运行",
    pendingLabel: "处理中",
    radarLabels: ["上下文", "性能", "记忆", "匹配", "来源", "工具"],
    refreshSnapshotLabel: "刷新快照",
    refreshingLabel: "刷新中...",
    queuedLabel: "已排队",
    readyLabel: "就绪",
    recentRunsLabel: "最近运行",
    recentSignalsLabel: "最近信号",
    runNowLabel: "立即执行",
    runningLabel: "执行中...",
    sessionVisibilityLabel: "会话可见性",
    sourceArtifactTitle: "知识信号雷达",
    sourcesLabel: "来源",
    timelineLabel: "时间线",
    traceStreamLabel: "轨迹流",
    triggerActionLabel: "触发操作",
    toolArtifactTitle: "执行审阅",
    toolCallsLabel: "工具调用",
    workerLogLabel: "Worker 日志",
    workerTimeoutLabel: "Worker 未在预期时间内完成任务，请确认后台进程已启动。",
  },
  en: {
    analysisLabel: "Execution Analysis",
    adminHeroTitle: "Admin should feel like mission control, not a generic dashboard",
    artifactCountLabel: "artifacts",
    artifactsEmpty:
      "Trigger a run to render the shared artifact protocol here.",
    artifactsTitle: "Runtime Artifacts",
    completedLabel: "completed",
    controlSurfacesLabel: "Control Surfaces",
    durationLabel: "Duration",
    efficiencyLabel: "Efficiency",
    evolutionControlsLabel: "Evolution Controls",
    failedLabel: "failed",
    latencyLabel: "Latency",
    lastOperationLabel: "Last Operation",
    nextRunLabel: "Next run",
    pendingLabel: "pending",
    radarLabels: ["Context", "Performance", "Memory", "Fit", "Sources", "Tools"],
    refreshSnapshotLabel: "Refresh Snapshot",
    refreshingLabel: "Refreshing...",
    queuedLabel: "Queued",
    readyLabel: "Ready",
    recentRunsLabel: "Recent Runs",
    recentSignalsLabel: "Recent Signals",
    runNowLabel: "Run now",
    runningLabel: "Running...",
    sessionVisibilityLabel: "Session Visibility",
    sourceArtifactTitle: "Knowledge Signal Radar",
    sourcesLabel: "Sources",
    timelineLabel: "Timeline",
    traceStreamLabel: "Trace Stream",
    triggerActionLabel: "Trigger Action",
    toolArtifactTitle: "Execution Review",
    toolCallsLabel: "Tool Calls",
    workerLogLabel: "Worker Log",
    workerTimeoutLabel:
      "The worker did not finish the job in time. Make sure the background worker is running.",
  },
};

export function AdminConsolePage() {
  const content = useLocalizedValue(platformPagesByLocale).admin;
  const copy = useLocalizedValue(adminPagesCopyByLocale);

  return (
    <main className="relative overflow-hidden px-6 pb-24 pt-10 md:px-10">
      <div className="pointer-events-none absolute left-[8%] top-12 h-56 w-56 rounded-full bg-primary/10 blur-[120px]" />
      <div className="pointer-events-none absolute right-[12%] top-40 h-72 w-72 rounded-full bg-secondary/10 blur-[140px]" />

      <section className="grid gap-6 md:grid-cols-3">
        {content.metrics.map((metric) => (
          <MetricTile
            accent={metric.accent}
            key={metric.label}
            label={metric.label}
            value={metric.value}
          />
        ))}
      </section>

      <section className="mt-16">
        <div className="mb-10">
          <AccentEyebrow accent="primary">{copy.controlSurfacesLabel}</AccentEyebrow>
          <h1 className="font-display-ui mt-4 text-5xl font-semibold tracking-[-0.06em] md:text-6xl">
            {copy.adminHeroTitle}
          </h1>
        </div>

        <div className="grid gap-6 md:grid-cols-3">
          {content.cards.map((card) => (
            <Link className="group block" href={card.href} key={card.href}>
              <SurfaceCard
                className={[
                  "h-full transition-all duration-300 group-hover:-translate-y-1",
                  accentBorderClassNames[card.accent],
                ].join(" ")}
                padding="xl"
                radius="lg"
              >
                <div
                  className={[
                    "mb-5 inline-flex rounded-full px-3 py-1 font-label-ui text-[10px] uppercase tracking-[0.22em]",
                    accentSurfaceClassNames[card.accent],
                    accentTextClassNames[card.accent],
                  ].join(" ")}
                >
                  {card.eyebrow}
                </div>
                <h2 className="font-display-ui text-3xl font-semibold tracking-[-0.04em]">
                  {card.title}
                </h2>
                <p className="mt-4 text-sm leading-7 text-foreground-muted">
                  {card.description}
                </p>
                <div
                  className={[
                    "mt-8 inline-flex items-center gap-2 text-sm uppercase tracking-[0.18em]",
                    accentTextClassNames[card.accent],
                  ].join(" ")}
                >
                  <span>{card.cta}</span>
                  <span aria-hidden="true">→</span>
                </div>
              </SurfaceCard>
            </Link>
          ))}
        </div>
      </section>

      <section className="mt-20">
        <div className="mb-10">
          <AccentEyebrow accent="secondary">{copy.recentSignalsLabel}</AccentEyebrow>
        </div>
        <div className="grid gap-5">
          {content.timeline.map((item) => (
            <SurfaceCard
              className={accentBorderClassNames[item.accent]}
              key={`${item.date}-${item.title}`}
              padding="lg"
              radius="md"
            >
              <p
                className={[
                  "font-label-ui text-[10px] uppercase tracking-[0.22em]",
                  accentTextClassNames[item.accent],
                ].join(" ")}
              >
                {item.date}
              </p>
              <h3 className="font-display-ui mt-4 text-2xl font-semibold tracking-[-0.04em]">
                {item.title}
              </h3>
              <p className="mt-3 text-sm leading-7 text-foreground-muted">
                {item.description}
              </p>
            </SurfaceCard>
          ))}
        </div>
      </section>
    </main>
  );
}

export function AdminObservabilityPage() {
  const content = useLocalizedValue(platformPagesByLocale).adminObservability;
  const copy = useLocalizedValue(adminPagesCopyByLocale);
  const { locale } = useSiteLocale();
  const observabilityStateKey = JSON.stringify({
    locale,
    metrics: content.metrics,
    sessions: content.sessions,
    traces: content.traces,
  });
  const [observabilityState, setObservabilityState] = useState(() => ({
    activeRefresh: false,
    artifacts: [] as ObservabilitySnapshotResponse["artifacts"],
    key: observabilityStateKey,
    metrics: content.metrics,
    sessions: content.sessions,
    sources: [] as ObservabilitySnapshotResponse["sources"],
    summary: null as string | null,
    toolCalls: [] as ObservabilitySnapshotResponse["toolCalls"],
    traces: content.traces,
  }));
  const activeRefresh =
    observabilityState.key === observabilityStateKey
      ? observabilityState.activeRefresh
      : false;
  const observabilityArtifacts =
    observabilityState.key === observabilityStateKey
      ? observabilityState.artifacts
      : [];
  const observabilityMetrics =
    observabilityState.key === observabilityStateKey
      ? observabilityState.metrics
      : content.metrics;
  const observabilitySessions =
    observabilityState.key === observabilityStateKey
      ? observabilityState.sessions
      : content.sessions;
  const observabilitySources =
    observabilityState.key === observabilityStateKey
      ? observabilityState.sources
      : [];
  const observabilitySummary =
    observabilityState.key === observabilityStateKey
      ? observabilityState.summary
      : null;
  const observabilityToolCalls =
    observabilityState.key === observabilityStateKey
      ? observabilityState.toolCalls
      : [];
  const observabilityTraces =
    observabilityState.key === observabilityStateKey
      ? observabilityState.traces
      : content.traces;

  const handleRefreshSnapshot = useCallback(async () => {
    if (activeRefresh) {
      return;
    }

    setObservabilityState((current) => ({
      activeRefresh: true,
      artifacts: current.key === observabilityStateKey ? current.artifacts : [],
      key: observabilityStateKey,
      metrics: current.key === observabilityStateKey ? current.metrics : content.metrics,
      sessions: current.key === observabilityStateKey ? current.sessions : content.sessions,
      sources: current.key === observabilityStateKey ? current.sources : [],
      summary: current.key === observabilityStateKey ? current.summary : null,
      toolCalls: current.key === observabilityStateKey ? current.toolCalls : [],
      traces: current.key === observabilityStateKey ? current.traces : content.traces,
    }));

    try {
      const response = await fetch("/api/observability", {
        body: JSON.stringify({ locale }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });

      const payload = (await response.json().catch(() => null)) as
        | ObservabilitySnapshotResponse
        | { summary?: string }
        | null;

      if (!response.ok) {
        const errorMessage =
          payload &&
          "summary" in payload &&
          typeof payload.summary === "string"
            ? payload.summary
            : `Observability request failed with ${response.status}`;

        throw new Error(errorMessage);
      }

      const resultPayload = payload as ObservabilitySnapshotResponse | null;

      setObservabilityState({
        activeRefresh: false,
        artifacts: resultPayload?.artifacts ?? [],
        key: observabilityStateKey,
        metrics: resultPayload?.metrics ?? content.metrics,
        sessions: resultPayload?.sessions ?? content.sessions,
        sources: resultPayload?.sources ?? [],
        summary: resultPayload?.summary ?? null,
        toolCalls: resultPayload?.toolCalls ?? [],
        traces: resultPayload?.traces ?? content.traces,
      });
    } catch (error) {
      setObservabilityState((current) => ({
        activeRefresh: false,
        artifacts: current.key === observabilityStateKey ? current.artifacts : [],
        key: observabilityStateKey,
        metrics: current.key === observabilityStateKey ? current.metrics : content.metrics,
        sessions: current.key === observabilityStateKey ? current.sessions : content.sessions,
        sources: current.key === observabilityStateKey ? current.sources : [],
        summary: error instanceof Error ? error.message : null,
        toolCalls: current.key === observabilityStateKey ? current.toolCalls : [],
        traces: current.key === observabilityStateKey ? current.traces : content.traces,
      }));
    }
  }, [
    activeRefresh,
    content.metrics,
    content.sessions,
    content.traces,
    locale,
    observabilityStateKey,
  ]);

  return (
    <main className="px-6 pb-24 pt-10 md:px-10">
      <section className="grid gap-6 md:grid-cols-3">
        {observabilityMetrics.map((metric) => (
          <MetricTile
            accent={metric.accent}
            key={metric.label}
            label={metric.label}
            value={metric.value}
          />
        ))}
      </section>

      <div className="mt-16 grid gap-10 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section>
          <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
            <AccentEyebrow accent="primary">{copy.traceStreamLabel}</AccentEyebrow>
            <button
              className={[
                "rounded-full border border-white/[0.08] bg-white/[0.04] px-4 py-2 font-label-ui text-[10px] uppercase tracking-[0.18em] text-foreground-muted transition-colors hover:text-foreground",
                activeRefresh ? "cursor-not-allowed opacity-75" : "",
              ].join(" ")}
              disabled={activeRefresh}
              onClick={() => void handleRefreshSnapshot()}
              type="button"
            >
              {activeRefresh ? copy.refreshingLabel : copy.refreshSnapshotLabel}
            </button>
          </div>
          <div className="grid gap-5">
            {observabilityTraces.map((trace) => (
              <FeatureCard
                accent={trace.accent}
                description={trace.detail}
                eyebrow={trace.status}
                key={trace.title}
                title={trace.title}
              />
            ))}
          </div>
        </section>

        <aside>
          <div className="mb-8">
            <AccentEyebrow accent="secondary">{copy.sessionVisibilityLabel}</AccentEyebrow>
          </div>
          <div className="grid gap-5">
            {observabilitySessions.map((session) => (
              <SurfaceCard
                className={accentBorderClassNames[session.accent]}
                key={session.title}
                padding="lg"
                radius="md"
              >
                <SignalPill accent={session.accent}>{session.location}</SignalPill>
                <h3 className="font-display-ui mt-4 text-2xl font-semibold tracking-[-0.04em]">
                  {session.title}
                </h3>
                <p className="mt-2 text-sm uppercase tracking-[0.18em] text-foreground-muted">
                  {session.state}
                </p>
                <p className="mt-4 text-sm leading-7 text-foreground-muted">
                  {session.summary}
                </p>
              </SurfaceCard>
            ))}
          </div>
        </aside>
      </div>

      <div className="mt-16 grid gap-10 xl:grid-cols-[minmax(0,0.9fr)_minmax(360px,1.1fr)]">
        <section>
          <SurfaceCard padding="xl" radius="lg">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-display-ui text-3xl font-semibold tracking-[-0.04em]">
                {copy.lastOperationLabel}
              </h2>
              {observabilitySources.length || observabilityToolCalls.length ? (
                <div className="flex flex-wrap gap-2">
                  {observabilitySources.length ? (
                    <SignalPill accent="secondary">
                      {copy.sourcesLabel} {observabilitySources.length}
                    </SignalPill>
                  ) : null}
                  {observabilityToolCalls.length ? (
                    <SignalPill accent="primary">
                      {copy.toolCallsLabel} {observabilityToolCalls.length}
                    </SignalPill>
                  ) : null}
                </div>
              ) : null}
            </div>

            <p className="mt-4 text-sm leading-7 text-foreground-muted">
              {observabilitySummary ?? copy.artifactsEmpty}
            </p>

            {observabilitySources.length ? (
              <div className="mt-8">
                <p className="font-label-ui text-[10px] uppercase tracking-[0.22em] text-foreground-muted">
                  {copy.sourcesLabel}
                </p>
                <div className="mt-3 grid gap-3">
                  {observabilitySources.map((source) => (
                    <div
                      className="rounded-[18px] border border-white/[0.05] bg-white/[0.03] px-4 py-3"
                      key={`${source.path}-${source.title}`}
                    >
                      <p className="font-display-ui text-sm font-semibold tracking-[-0.03em]">
                        {source.title}
                      </p>
                      <p className="mt-2 font-label-ui text-[10px] uppercase tracking-[0.18em] text-foreground-muted">
                        {source.path}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </SurfaceCard>
        </section>

        <aside>
          <SurfaceCard padding="xl" radius="lg">
            <p className="font-label-ui text-[10px] uppercase tracking-[0.22em] text-foreground-muted">
              {copy.toolCallsLabel}
            </p>
            <div className="mt-4 grid gap-3">
              {observabilityToolCalls.length ? (
                observabilityToolCalls.map((toolCall) => (
                  <div
                    className="rounded-[18px] border border-white/[0.05] bg-white/[0.03] px-4 py-3"
                    key={toolCall.name}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-display-ui text-sm font-semibold tracking-[-0.03em]">
                        {toolCall.name}
                      </p>
                      <SignalPill accent="secondary">
                        {toolCall.status === "completed"
                          ? copy.completedLabel
                          : copy.pendingLabel}
                      </SignalPill>
                    </div>
                    <p className="mt-2 text-xs leading-6 text-foreground-muted">
                      {toolCall.detail}
                    </p>
                  </div>
                ))
              ) : (
                <p className="text-sm leading-7 text-foreground-muted">
                  {copy.artifactsEmpty}
                </p>
              )}
            </div>
          </SurfaceCard>
        </aside>
      </div>

      <section className="mt-20">
        <div className="mb-8">
          <AccentEyebrow accent="secondary">{copy.artifactsTitle}</AccentEyebrow>
        </div>
        <SurfaceCard padding="xl" radius="lg">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display-ui text-3xl font-semibold tracking-[-0.04em]">
              {copy.artifactsTitle}
            </h2>
            {observabilityArtifacts.length ? (
              <SignalPill accent="primary">
                {observabilityArtifacts.length} {copy.artifactCountLabel}
              </SignalPill>
            ) : null}
          </div>

          <div className="mt-6">
            {observabilityArtifacts.length ? (
              <ArtifactRenderer
                artifacts={observabilityArtifacts}
                copy={{
                  analysisLabel: copy.analysisLabel,
                  completedLabel: copy.completedLabel,
                  efficiencyLabel: copy.efficiencyLabel,
                  latencyLabel: copy.latencyLabel,
                  pendingLabel: copy.pendingLabel,
                  radarLabels: copy.radarLabels,
                  sourceArtifactTitle: copy.sourceArtifactTitle,
                  toolArtifactTitle: copy.toolArtifactTitle,
                }}
              />
            ) : (
              <p className="text-sm leading-7 text-foreground-muted">
                {copy.artifactsEmpty}
              </p>
            )}
          </div>
        </SurfaceCard>
      </section>
    </main>
  );
}

export function AdminJobsPage() {
  const content = useLocalizedValue(platformPagesByLocale).adminJobs;
  const copy = useLocalizedValue(adminPagesCopyByLocale);
  const { locale } = useSiteLocale();
  const baseJobLogs = content.logs;
  const baseRecentRuns = content.recentRuns;
  const jobStateKey = JSON.stringify({
    logs: baseJobLogs,
    locale,
    recentRuns: baseRecentRuns,
  });
  const [jobState, setJobState] = useState(() => ({
    activeJob: null as string | null,
    artifacts: [] as JobRunResponse["artifacts"],
    key: jobStateKey,
    logs: baseJobLogs,
    recentRuns: baseRecentRuns,
    sources: [] as JobRunResponse["sources"],
    summary: null as string | null,
    toolCalls: [] as JobRunResponse["toolCalls"],
  }));
  const activeJob = jobState.key === jobStateKey ? jobState.activeJob : null;
  const jobArtifacts = jobState.key === jobStateKey ? jobState.artifacts : [];
  const jobLogs = jobState.key === jobStateKey ? jobState.logs : baseJobLogs;
  const recentRuns =
    jobState.key === jobStateKey ? jobState.recentRuns : baseRecentRuns;
  const jobSources = jobState.key === jobStateKey ? jobState.sources : [];
  const jobSummary = jobState.key === jobStateKey ? jobState.summary : null;
  const jobToolCalls = jobState.key === jobStateKey ? jobState.toolCalls : [];

  const applyJobSnapshot = useCallback(
    (schedule: AdminJobSchedule, snapshot: JobRunSnapshot) => {
      setJobState(() => ({
        activeJob:
          snapshot.status === "queued" || snapshot.status === "running"
            ? schedule.name
            : null,
        artifacts: snapshot.status === "completed" ? snapshot.artifacts : [],
        key: jobStateKey,
        logs: snapshot.logLines.length ? snapshot.logLines : baseJobLogs,
        recentRuns: [
          {
            accent: schedule.accent,
            duration:
              snapshot.recentRun?.duration ??
              (snapshot.status === "failed"
                ? "0.0s"
                : snapshot.status === "running"
                  ? copy.runningLabel.toLowerCase()
                  : copy.queuedLabel.toLowerCase()),
            name: schedule.name,
            status:
              snapshot.status === "completed"
                ? snapshot.recentRun?.status ?? copy.completedLabel
                : snapshot.status === "failed"
                  ? copy.failedLabel
                  : snapshot.status === "running"
                    ? copy.runningLabel
                    : copy.queuedLabel,
          },
          ...baseRecentRuns.filter((run) => run.name !== schedule.name).slice(0, 2),
        ],
        sources: snapshot.status === "completed" ? snapshot.sources : [],
        summary: snapshot.summary ?? snapshot.error,
        toolCalls: snapshot.status === "completed" ? snapshot.toolCalls : [],
      }));
    },
    [
      baseJobLogs,
      baseRecentRuns,
      copy.completedLabel,
      copy.failedLabel,
      copy.queuedLabel,
      copy.runningLabel,
      jobStateKey,
    ],
  );

  const pollJobRun = useCallback(
    async (schedule: AdminJobSchedule, runId: string) => {
      for (let attempt = 0; attempt < 18; attempt += 1) {
        await wait(900);

        const response = await fetch(`/api/jobs/run?runId=${encodeURIComponent(runId)}`);
        const payload = (await response.json().catch(() => null)) as
          | JobRunSnapshot
          | { message?: string; summary?: string }
          | null;

        if (!response.ok) {
          const errorMessage =
            payload && "message" in payload && typeof payload.message === "string"
              ? payload.message
              : `Job status request failed with ${response.status}`;

          throw new Error(errorMessage);
        }

        const snapshot = payload as JobRunSnapshot | null;

        if (!snapshot) {
          throw new Error(copy.failedLabel);
        }

        applyJobSnapshot(schedule, snapshot);

        if (snapshot.status === "completed") {
          return snapshot;
        }

        if (snapshot.status === "failed") {
          throw new Error(snapshot.error ?? snapshot.summary ?? copy.failedLabel);
        }
      }

      throw new Error(copy.workerTimeoutLabel);
    },
    [applyJobSnapshot, copy.failedLabel, copy.workerTimeoutLabel],
  );

  const handleRunSchedule = useCallback(
    async (schedule: AdminJobSchedule) => {
      if (activeJob) {
        return;
      }

      setJobState((current) => {
        const recent =
          current.key === jobStateKey ? current.recentRuns : baseRecentRuns;

        return {
          activeJob: schedule.name,
          artifacts: [],
          key: jobStateKey,
          logs: current.key === jobStateKey ? current.logs : baseJobLogs,
          recentRuns: [
            {
              accent: schedule.accent,
              duration: copy.queuedLabel.toLowerCase(),
              name: schedule.name,
              status: copy.queuedLabel,
            },
            ...recent.filter((run) => run.name !== schedule.name).slice(0, 2),
          ],
          sources: [],
          summary: null,
          toolCalls: [],
        };
      });

      try {
        const response = await fetch("/api/jobs/run", {
          body: JSON.stringify({
            jobId: resolveJobId(schedule.name),
            locale,
          }),
          headers: {
            "Content-Type": "application/json",
          },
          method: "POST",
        });

        const payload = (await response.json().catch(() => null)) as
          | JobRunSnapshot
          | { message?: string; summary?: string }
          | null;

        if (!response.ok) {
          const errorMessage =
            payload &&
            "summary" in payload &&
            typeof payload.summary === "string"
              ? payload.summary
              : payload &&
                  "message" in payload &&
                  typeof payload.message === "string"
                ? payload.message
              : `Job request failed with ${response.status}`;

          throw new Error(errorMessage);
        }

        const snapshot = payload as JobRunSnapshot | null;

        if (!snapshot) {
          throw new Error(copy.failedLabel);
        }

        applyJobSnapshot(schedule, snapshot);

        if (snapshot.status === "completed") {
          return;
        }

        if (snapshot.status === "failed") {
          throw new Error(snapshot.error ?? snapshot.summary ?? copy.failedLabel);
        }

        await pollJobRun(schedule, snapshot.runId);
      } catch (error) {
        setJobState((current) => {
          const logs = current.key === jobStateKey ? current.logs : baseJobLogs;
          const errorMessage =
            error instanceof Error ? error.message : copy.failedLabel;

          return {
            activeJob: null,
            artifacts: current.key === jobStateKey ? current.artifacts : [],
            key: jobStateKey,
            logs: [...logs.filter((line) => line !== "_"), `[error] ${schedule.name} ${errorMessage}`, "_"].slice(-12),
            recentRuns: [
              {
                accent: schedule.accent,
                duration: "0.0s",
                name: schedule.name,
                status: copy.failedLabel,
              },
              ...baseRecentRuns.filter((run) => run.name !== schedule.name).slice(0, 2),
            ],
            sources: current.key === jobStateKey ? current.sources : [],
            summary: errorMessage,
            toolCalls: current.key === jobStateKey ? current.toolCalls : [],
          };
        });
      }
    },
    [
      activeJob,
      applyJobSnapshot,
      baseJobLogs,
      baseRecentRuns,
      copy.failedLabel,
      copy.queuedLabel,
      jobStateKey,
      locale,
      pollJobRun,
    ],
  );

  return (
    <main className="px-6 pb-24 pt-10 md:px-10">
      <section className="grid gap-6 md:grid-cols-3">
        {content.schedules.map((schedule) => (
          <SurfaceCard
            className={accentBorderClassNames[schedule.accent]}
            key={schedule.name}
            padding="lg"
            radius="md"
          >
            <SignalPill accent={schedule.accent}>{schedule.cron}</SignalPill>
            <h2 className="font-display-ui mt-4 text-2xl font-semibold tracking-[-0.04em]">
              {schedule.name}
            </h2>
            <p className="mt-3 text-sm leading-7 text-foreground-muted">
              {copy.nextRunLabel}: {schedule.nextRun}
            </p>
            <button
              className={[
                "mt-6 rounded-full border border-white/[0.08] bg-white/[0.04] px-4 py-2 font-label-ui text-[10px] uppercase tracking-[0.18em] text-foreground-muted transition-colors hover:text-foreground",
                activeJob ? "cursor-not-allowed opacity-75" : "",
              ].join(" ")}
              disabled={Boolean(activeJob)}
              onClick={() => void handleRunSchedule(schedule)}
              type="button"
            >
              {activeJob === schedule.name ? copy.runningLabel : copy.runNowLabel}
            </button>
          </SurfaceCard>
        ))}
      </section>

      <div className="mt-16 grid gap-10 xl:grid-cols-[minmax(0,0.9fr)_minmax(380px,1.1fr)]">
        <section>
          <div className="mb-8">
            <AccentEyebrow accent="secondary">{copy.workerLogLabel}</AccentEyebrow>
          </div>
          <TerminalPanel lines={jobLogs} />
        </section>

        <section>
          <div className="mb-8">
            <AccentEyebrow accent="primary">{copy.recentRunsLabel}</AccentEyebrow>
          </div>
          <div className="grid gap-5">
            {recentRuns.map((run) => (
              <SurfaceCard
                className={accentBorderClassNames[run.accent]}
                key={`${run.name}-${run.status}-${run.duration}`}
                padding="lg"
                radius="md"
              >
                <div className="flex items-center justify-between gap-4">
                  <h3 className="font-display-ui text-2xl font-semibold tracking-[-0.04em]">
                    {run.name}
                  </h3>
                  <SignalPill accent={run.accent}>{run.status}</SignalPill>
                </div>
                <p className="mt-4 text-sm leading-7 text-foreground-muted">
                  {copy.durationLabel}: {run.duration}
                </p>
              </SurfaceCard>
            ))}
          </div>
        </section>
      </div>

      <div className="mt-16 grid gap-10 xl:grid-cols-[minmax(0,0.9fr)_minmax(360px,1.1fr)]">
        <section>
          <SurfaceCard padding="xl" radius="lg">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-display-ui text-3xl font-semibold tracking-[-0.04em]">
                {copy.lastOperationLabel}
              </h2>
              {jobSources.length || jobToolCalls.length ? (
                <div className="flex flex-wrap gap-2">
                  {jobSources.length ? (
                    <SignalPill accent="secondary">
                      {copy.sourcesLabel} {jobSources.length}
                    </SignalPill>
                  ) : null}
                  {jobToolCalls.length ? (
                    <SignalPill accent="primary">
                      {copy.toolCallsLabel} {jobToolCalls.length}
                    </SignalPill>
                  ) : null}
                </div>
              ) : null}
            </div>

            <p className="mt-4 text-sm leading-7 text-foreground-muted">
              {jobSummary ?? copy.artifactsEmpty}
            </p>

            {jobToolCalls.length ? (
              <div className="mt-8">
                <p className="font-label-ui text-[10px] uppercase tracking-[0.22em] text-foreground-muted">
                  {copy.toolCallsLabel}
                </p>
                <div className="mt-3 grid gap-3">
                  {jobToolCalls.map((toolCall) => (
                    <div
                      className="rounded-[18px] border border-white/[0.05] bg-white/[0.03] px-4 py-3"
                      key={toolCall.name}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-display-ui text-sm font-semibold tracking-[-0.03em]">
                          {toolCall.name}
                        </p>
                        <SignalPill accent="secondary">
                          {toolCall.status === "completed"
                            ? copy.completedLabel
                            : copy.pendingLabel}
                        </SignalPill>
                      </div>
                      <p className="mt-2 text-xs leading-6 text-foreground-muted">
                        {toolCall.detail}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </SurfaceCard>
        </section>

        <aside>
          <SurfaceCard padding="xl" radius="lg">
            <p className="font-label-ui text-[10px] uppercase tracking-[0.22em] text-foreground-muted">
              {copy.sourcesLabel}
            </p>
            <div className="mt-4 grid gap-3">
              {jobSources.length ? (
                jobSources.map((source) => (
                  <div
                    className="rounded-[18px] border border-white/[0.05] bg-white/[0.03] px-4 py-3"
                    key={`${source.path}-${source.title}`}
                  >
                    <p className="font-display-ui text-sm font-semibold tracking-[-0.03em]">
                      {source.title}
                    </p>
                    <p className="mt-2 font-label-ui text-[10px] uppercase tracking-[0.18em] text-foreground-muted">
                      {source.path}
                    </p>
                  </div>
                ))
              ) : (
                <p className="text-sm leading-7 text-foreground-muted">
                  {copy.artifactsEmpty}
                </p>
              )}
            </div>
          </SurfaceCard>
        </aside>
      </div>

      <section className="mt-20">
        <div className="mb-8">
          <AccentEyebrow accent="secondary">{copy.artifactsTitle}</AccentEyebrow>
        </div>
        <SurfaceCard padding="xl" radius="lg">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display-ui text-3xl font-semibold tracking-[-0.04em]">
              {copy.artifactsTitle}
            </h2>
            {jobArtifacts.length ? (
              <SignalPill accent="primary">
                {jobArtifacts.length} {copy.artifactCountLabel}
              </SignalPill>
            ) : null}
          </div>

          <div className="mt-6">
            {jobArtifacts.length ? (
              <ArtifactRenderer
                artifacts={jobArtifacts}
                copy={{
                  analysisLabel: copy.analysisLabel,
                  completedLabel: copy.completedLabel,
                  efficiencyLabel: copy.efficiencyLabel,
                  latencyLabel: copy.latencyLabel,
                  pendingLabel: copy.pendingLabel,
                  radarLabels: copy.radarLabels,
                  sourceArtifactTitle: copy.sourceArtifactTitle,
                  toolArtifactTitle: copy.toolArtifactTitle,
                }}
              />
            ) : (
              <p className="text-sm leading-7 text-foreground-muted">
                {copy.artifactsEmpty}
              </p>
            )}
          </div>
        </SurfaceCard>
      </section>
    </main>
  );
}

export function AdminEvolutionPage() {
  const content = useLocalizedValue(platformPagesByLocale).adminEvolution;
  const copy = useLocalizedValue(adminPagesCopyByLocale);
  const { locale } = useSiteLocale();
  const evolutionStateKey = JSON.stringify({
    bullets: content.digest.bullets,
    locale,
  });
  const [evolutionState, setEvolutionState] = useState(() => ({
    activeControl: null as string | null,
    activeStatus: null as EvolutionRunSnapshot["status"] | null,
    artifacts: [] as EvolutionRunSnapshot["artifacts"],
    bullets: content.digest.bullets,
    key: evolutionStateKey,
    sources: [] as EvolutionRunSnapshot["sources"],
    summary: null as string | null,
    toolCalls: [] as EvolutionRunSnapshot["toolCalls"],
  }));
  const activeControl =
    evolutionState.key === evolutionStateKey ? evolutionState.activeControl : null;
  const activeStatus =
    evolutionState.key === evolutionStateKey ? evolutionState.activeStatus : null;
  const evolutionArtifacts =
    evolutionState.key === evolutionStateKey ? evolutionState.artifacts : [];
  const digestBullets =
    evolutionState.key === evolutionStateKey
      ? evolutionState.bullets
      : content.digest.bullets;
  const digestSummary =
    evolutionState.key === evolutionStateKey ? evolutionState.summary : null;
  const evolutionSources =
    evolutionState.key === evolutionStateKey ? evolutionState.sources : [];
  const evolutionToolCalls =
    evolutionState.key === evolutionStateKey ? evolutionState.toolCalls : [];

  const applyEvolutionSnapshot = useCallback(
    (controlLabel: string, snapshot: EvolutionRunSnapshot) => {
      setEvolutionState(() => ({
        activeControl:
          snapshot.status === "queued" || snapshot.status === "running"
            ? controlLabel
            : null,
        activeStatus:
          snapshot.status === "queued" || snapshot.status === "running"
            ? snapshot.status
            : null,
        artifacts: snapshot.status === "completed" ? snapshot.artifacts : [],
        bullets: snapshot.bullets.length ? snapshot.bullets : content.digest.bullets,
        key: evolutionStateKey,
        sources: snapshot.status === "completed" ? snapshot.sources : [],
        summary: snapshot.summary ?? snapshot.error,
        toolCalls: snapshot.status === "completed" ? snapshot.toolCalls : [],
      }));
    },
    [content.digest.bullets, evolutionStateKey],
  );

  const pollEvolutionRun = useCallback(
    async (controlLabel: string, runId: string) => {
      for (let attempt = 0; attempt < 18; attempt += 1) {
        await wait(900);

        const response = await fetch(`/api/evolution?runId=${encodeURIComponent(runId)}`);
        const payload = (await response.json().catch(() => null)) as
          | EvolutionRunSnapshot
          | { message?: string; summary?: string }
          | null;

        if (!response.ok) {
          const errorMessage =
            payload && "message" in payload && typeof payload.message === "string"
              ? payload.message
              : `Evolution status request failed with ${response.status}`;

          throw new Error(errorMessage);
        }

        const snapshot = payload as EvolutionRunSnapshot | null;

        if (!snapshot) {
          throw new Error(copy.failedLabel);
        }

        applyEvolutionSnapshot(controlLabel, snapshot);

        if (snapshot.status === "completed") {
          return snapshot;
        }

        if (snapshot.status === "failed") {
          throw new Error(snapshot.error ?? snapshot.summary ?? copy.failedLabel);
        }
      }

      throw new Error(copy.workerTimeoutLabel);
    },
    [applyEvolutionSnapshot, copy.failedLabel, copy.workerTimeoutLabel],
  );

  const handleTriggerControl = useCallback(
    async (controlLabel: string, action: "rebuild_index" | "run_sync" | "generate_digest") => {
      if (activeControl) {
        return;
      }

      setEvolutionState((current) => ({
        activeControl: controlLabel,
        activeStatus: "queued",
        artifacts: [],
        bullets: current.key === evolutionStateKey ? current.bullets : content.digest.bullets,
        key: evolutionStateKey,
        sources: [],
        summary: current.key === evolutionStateKey ? current.summary : null,
        toolCalls: [],
      }));

      try {
        const response = await fetch("/api/evolution", {
          body: JSON.stringify({
            action,
            locale,
          }),
          headers: {
            "Content-Type": "application/json",
          },
          method: "POST",
        });

        const payload = (await response.json().catch(() => null)) as
          | EvolutionRunSnapshot
          | { message?: string; summary?: string }
          | null;

        if (!response.ok) {
          const errorMessage =
            payload &&
            "summary" in payload &&
            typeof payload.summary === "string"
              ? payload.summary
              : `Evolution request failed with ${response.status}`;

          throw new Error(errorMessage);
        }

        const snapshot = payload as EvolutionRunSnapshot | null;

        if (!snapshot) {
          throw new Error(copy.failedLabel);
        }

        applyEvolutionSnapshot(controlLabel, snapshot);

        if (snapshot.status === "completed") {
          return;
        }

        if (snapshot.status === "failed") {
          throw new Error(snapshot.error ?? snapshot.summary ?? copy.failedLabel);
        }

        await pollEvolutionRun(controlLabel, snapshot.runId);
      } catch (error) {
        setEvolutionState((current) => ({
          activeControl: null,
          activeStatus: null,
          artifacts: current.key === evolutionStateKey ? current.artifacts : [],
          bullets: current.key === evolutionStateKey ? current.bullets : content.digest.bullets,
          key: evolutionStateKey,
          sources: current.key === evolutionStateKey ? current.sources : [],
          summary: error instanceof Error ? error.message : null,
          toolCalls: current.key === evolutionStateKey ? current.toolCalls : [],
        }));
      }
    },
    [
      activeControl,
      applyEvolutionSnapshot,
      content.digest.bullets,
      copy.failedLabel,
      evolutionStateKey,
      locale,
      pollEvolutionRun,
    ],
  );

  return (
    <main className="px-6 pb-24 pt-10 md:px-10">
      <section className="grid gap-6 md:grid-cols-3">
        {content.metrics.map((metric) => (
          <MetricTile
            accent={metric.accent}
            key={metric.label}
            label={metric.label}
            value={metric.value}
          />
        ))}
      </section>

      <div className="mt-16 grid gap-10 xl:grid-cols-[minmax(0,0.9fr)_minmax(360px,1.1fr)]">
        <section>
          <div className="mb-8">
            <AccentEyebrow accent="tertiary">{copy.evolutionControlsLabel}</AccentEyebrow>
          </div>
          <div className="grid gap-5">
            {content.controls.map((control, index) => (
              <SurfaceCard
                className={accentBorderClassNames[control.accent]}
                key={control.label}
                padding="lg"
                radius="md"
              >
                <div className="flex items-center justify-between gap-4">
                  <h3 className="font-display-ui text-2xl font-semibold tracking-[-0.04em]">
                    {control.label}
                  </h3>
                  <SignalPill accent={control.accent}>
                    {activeControl === control.label
                      ? activeStatus === "queued"
                        ? copy.queuedLabel
                        : copy.runningLabel
                      : copy.readyLabel}
                  </SignalPill>
                </div>
                <p className="mt-4 text-sm leading-7 text-foreground-muted">
                  {control.description}
                </p>
                <button
                  className={[
                    "mt-6 rounded-full border border-white/[0.08] bg-white/[0.04] px-4 py-2 font-label-ui text-[10px] uppercase tracking-[0.18em] text-foreground-muted transition-colors hover:text-foreground",
                    activeControl ? "cursor-not-allowed opacity-75" : "",
                  ].join(" ")}
                  disabled={Boolean(activeControl)}
                  onClick={() =>
                    void handleTriggerControl(
                      control.label,
                      index === 0
                        ? "rebuild_index"
                        : index === 1
                          ? "run_sync"
                          : "generate_digest",
                    )
                  }
                  type="button"
                >
                  {activeControl === control.label
                    ? activeStatus === "queued"
                      ? copy.queuedLabel
                      : copy.runningLabel
                    : copy.triggerActionLabel}
                </button>
              </SurfaceCard>
            ))}
          </div>
        </section>

        <aside>
          <div className="mb-8">
            <AccentEyebrow accent="primary">{content.digest.title}</AccentEyebrow>
          </div>
          <SurfaceCard padding="xl" radius="lg">
            {digestSummary ? (
              <div className="mb-6 rounded-[20px] border border-white/[0.06] bg-white/[0.03] px-4 py-4">
                <p className="font-label-ui text-[10px] uppercase tracking-[0.22em] text-foreground-muted">
                  {copy.lastOperationLabel}
                </p>
                <p className="mt-3 text-sm leading-7 text-foreground-muted">{digestSummary}</p>
              </div>
            ) : null}
            {evolutionSources.length || evolutionToolCalls.length ? (
              <div className="mb-6 flex flex-wrap gap-2">
                {evolutionSources.length ? (
                  <SignalPill accent="secondary">
                    {copy.sourcesLabel} {evolutionSources.length}
                  </SignalPill>
                ) : null}
                {evolutionToolCalls.length ? (
                  <SignalPill accent="primary">
                    {copy.toolCallsLabel} {evolutionToolCalls.length}
                  </SignalPill>
                ) : null}
              </div>
            ) : null}
            <ul className="grid gap-4 text-sm leading-7 text-foreground-muted">
              {digestBullets.map((bullet) => (
                <li key={bullet}>{bullet}</li>
              ))}
            </ul>

            {evolutionToolCalls.length ? (
              <div className="mt-8">
                <p className="font-label-ui text-[10px] uppercase tracking-[0.22em] text-foreground-muted">
                  {copy.toolCallsLabel}
                </p>
                <div className="mt-3 grid gap-3">
                  {evolutionToolCalls.map((toolCall) => (
                    <div
                      className="rounded-[18px] border border-white/[0.05] bg-white/[0.03] px-4 py-3"
                      key={toolCall.name}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-display-ui text-sm font-semibold tracking-[-0.03em]">
                          {toolCall.name}
                        </p>
                        <SignalPill accent="secondary">
                          {toolCall.status === "completed"
                            ? copy.completedLabel
                            : copy.pendingLabel}
                        </SignalPill>
                      </div>
                      <p className="mt-2 text-xs leading-6 text-foreground-muted">
                        {toolCall.detail}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {evolutionSources.length ? (
              <div className="mt-8">
                <p className="font-label-ui text-[10px] uppercase tracking-[0.22em] text-foreground-muted">
                  {copy.sourcesLabel}
                </p>
                <div className="mt-3 grid gap-3">
                  {evolutionSources.map((source) => (
                    <div
                      className="rounded-[18px] border border-white/[0.05] bg-white/[0.03] px-4 py-3"
                      key={`${source.path}-${source.title}`}
                    >
                      <p className="font-display-ui text-sm font-semibold tracking-[-0.03em]">
                        {source.title}
                      </p>
                      <p className="mt-2 font-label-ui text-[10px] uppercase tracking-[0.18em] text-foreground-muted">
                        {source.path}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </SurfaceCard>
        </aside>
      </div>

      <section className="mt-20">
        <div className="mb-8">
          <AccentEyebrow accent="secondary">{copy.artifactsTitle}</AccentEyebrow>
        </div>
        <SurfaceCard padding="xl" radius="lg">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display-ui text-3xl font-semibold tracking-[-0.04em]">
              {copy.artifactsTitle}
            </h2>
            {evolutionArtifacts.length ? (
              <SignalPill accent="primary">
                {evolutionArtifacts.length} {copy.artifactCountLabel}
              </SignalPill>
            ) : null}
          </div>

          <div className="mt-6">
            {evolutionArtifacts.length ? (
              <ArtifactRenderer
                artifacts={evolutionArtifacts}
                copy={{
                  analysisLabel: copy.analysisLabel,
                  completedLabel: copy.completedLabel,
                  efficiencyLabel: copy.efficiencyLabel,
                  latencyLabel: copy.latencyLabel,
                  pendingLabel: copy.pendingLabel,
                  radarLabels: copy.radarLabels,
                  sourceArtifactTitle: copy.sourceArtifactTitle,
                  toolArtifactTitle: copy.toolArtifactTitle,
                }}
              />
            ) : (
              <p className="text-sm leading-7 text-foreground-muted">
                {copy.artifactsEmpty}
              </p>
            )}
          </div>
        </SurfaceCard>
      </section>

      <section className="mt-20">
        <div className="mb-8">
          <AccentEyebrow accent="secondary">{copy.timelineLabel}</AccentEyebrow>
        </div>
        <div className="grid gap-5">
          {content.timeline.map((item) => (
            <SurfaceCard
              className={accentBorderClassNames[item.accent]}
              key={`${item.date}-${item.title}`}
              padding="lg"
              radius="md"
            >
              <p
                className={[
                  "font-label-ui text-[10px] uppercase tracking-[0.22em]",
                  accentTextClassNames[item.accent],
                ].join(" ")}
              >
                {item.date}
              </p>
              <h3 className="font-display-ui mt-4 text-2xl font-semibold tracking-[-0.04em]">
                {item.title}
              </h3>
              <p className="mt-3 text-sm leading-7 text-foreground-muted">
                {item.description}
              </p>
            </SurfaceCard>
          ))}
        </div>
      </section>
    </main>
  );
}
