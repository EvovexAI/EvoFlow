"use client";

import type { AiArtifact } from "@ai-site/ai";

interface ArtifactRendererCopy {
  analysisLabel: string;
  completedLabel: string;
  efficiencyLabel: string;
  latencyLabel: string;
  pendingLabel: string;
  radarLabels: string[];
  sourceArtifactTitle: string;
  toolArtifactTitle: string;
}

function buildRadarPolygon(values: readonly number[]) {
  const centerX = 100;
  const centerY = 100;

  return values
    .map((value, index) => {
      const angle = ((Math.PI * 2) / values.length) * index - Math.PI / 2;
      const radius = 26 + value * 0.52;
      const x = centerX + Math.cos(angle) * radius;
      const y = centerY + Math.sin(angle) * radius;

      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function ExecutionReviewArtifactView({
  copy,
  artifact,
}: {
  copy: ArtifactRendererCopy;
  artifact: Extract<AiArtifact, { kind: "executionReview" }>;
}) {
  return (
    <div className="overflow-hidden rounded-[24px] border border-white/[0.05] bg-[linear-gradient(135deg,#131313_0%,#0e0e0e_100%)] shadow-[0_20px_50px_rgba(0,0,0,0.35)]">
      <div className="flex items-center justify-between bg-white/[0.04] px-5 py-3">
        <div className="flex gap-1.5">
          <div className="h-2.5 w-2.5 rounded-full bg-[#ff5f56]" />
          <div className="h-2.5 w-2.5 rounded-full bg-[#ffbd2e]" />
          <div className="h-2.5 w-2.5 rounded-full bg-[#27c93f]" />
        </div>
        <span className="font-label-ui text-[10px] uppercase tracking-[0.22em] text-foreground-muted">
          {copy.toolArtifactTitle}
        </span>
      </div>
      <div className="space-y-3 p-6 font-mono text-sm leading-relaxed">
        {artifact.payload.steps.map((step) => (
          <div className="space-y-2" key={`${step.name}-${step.lineNumber}`}>
            <div className="flex items-center gap-4 rounded-xl bg-white/[0.02] px-4 py-3">
              <span className="w-4 text-right text-white/25">{step.lineNumber}</span>
              <code className="flex-1 text-foreground">{step.name}()</code>
              <span
                className={[
                  "rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.18em]",
                  step.status === "completed"
                    ? "border-primary/30 bg-primary/10 text-primary"
                    : "border-tertiary/30 bg-tertiary/10 text-tertiary",
                ].join(" ")}
              >
                {step.status === "completed" ? copy.completedLabel : copy.pendingLabel}
              </span>
            </div>
            <div className="pl-10 text-xs leading-6 text-foreground-muted">
              {step.detail}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function KnowledgeSignalRadarArtifactView({
  copy,
  artifact,
}: {
  copy: ArtifactRendererCopy;
  artifact: Extract<AiArtifact, { kind: "knowledgeSignalRadar" }>;
}) {
  return (
    <div className="relative mx-auto max-w-md overflow-hidden rounded-[28px] border border-white/[0.05] bg-[#121212] p-8 shadow-[0_20px_50px_rgba(0,0,0,0.35)]">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-tr from-primary/5 to-transparent" />
      <div className="relative flex flex-col items-center">
        <span className="font-label-ui text-[10px] uppercase tracking-[0.2em] text-primary/60">
          {copy.analysisLabel}
        </span>
        <h3 className="font-display-ui mt-3 text-center text-2xl font-semibold tracking-[-0.04em] text-primary">
          {copy.sourceArtifactTitle}
        </h3>
        <svg className="mt-6 h-64 w-64 overflow-visible" viewBox="0 0 200 200">
          <polygon
            className="fill-none stroke-white/10"
            points="100,20 176,60 176,140 100,180 24,140 24,60"
            strokeWidth="1.2"
          />
          <polygon
            className="fill-none stroke-white/10"
            points="100,60 138,80 138,120 100,140 62,120 62,80"
            strokeWidth="1.2"
          />
          <polygon
            className="fill-primary/15 stroke-primary"
            points={buildRadarPolygon(artifact.payload.scores)}
            strokeWidth="2"
          />
          {copy.radarLabels.map((label, index) => {
            const positions = [
              { x: 100, y: 10, anchor: "middle" },
              { x: 184, y: 62, anchor: "start" },
              { x: 184, y: 146, anchor: "start" },
              { x: 100, y: 194, anchor: "middle" },
              { x: 16, y: 146, anchor: "end" },
              { x: 16, y: 62, anchor: "end" },
            ] as const;

            return (
              <text
                className="fill-foreground-muted/80 font-label-ui text-[9px] uppercase"
                key={`${label}-${index}`}
                textAnchor={positions[index]?.anchor ?? "middle"}
                x={positions[index]?.x ?? 100}
                y={positions[index]?.y ?? 100}
              >
                {label}
              </text>
            );
          })}
        </svg>
        <div className="mt-8 grid w-full grid-cols-2 gap-4">
          <div className="text-center">
            <div className="font-label-ui text-[10px] uppercase tracking-[0.18em] text-foreground-muted">
              {copy.efficiencyLabel}
            </div>
            <div className="font-display-ui mt-2 text-xl font-semibold text-primary">
              {artifact.payload.efficiencyScore}%
            </div>
          </div>
          <div className="border-l border-white/[0.05] text-center">
            <div className="font-label-ui text-[10px] uppercase tracking-[0.18em] text-foreground-muted">
              {copy.latencyLabel}
            </div>
            <div className="font-display-ui mt-2 text-xl font-semibold text-secondary">
              {artifact.payload.latencyMs.toFixed(1)}ms
            </div>
          </div>
        </div>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {artifact.payload.sources.slice(0, 3).map((source) => (
            <span
              className="rounded-full border border-white/[0.06] bg-white/[0.04] px-3 py-1.5 font-label-ui text-[10px] uppercase tracking-[0.18em] text-foreground-muted"
              key={`${source.path}-${source.title}`}
            >
              {source.title}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function TechRadarArtifactView({
  artifact,
}: {
  artifact: Extract<AiArtifact, { kind: "techRadar" }>;
}) {
  return (
    <div className="rounded-[24px] border border-white/[0.05] bg-white/[0.03] p-6 shadow-[0_20px_50px_rgba(0,0,0,0.24)]">
      <h3 className="font-display-ui text-2xl font-semibold tracking-[-0.04em] text-foreground">
        {artifact.payload.title}
      </h3>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {artifact.payload.metrics.map((metric) => (
          <div key={metric.label}>
            <p className="font-label-ui text-[10px] uppercase tracking-[0.22em] text-foreground-muted">
              {metric.label}
            </p>
            <div className="mt-2 h-2 rounded-full bg-white/[0.06]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-primary to-secondary"
                style={{ width: `${Math.max(8, Math.min(metric.value, 100))}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ArtifactRenderer({
  artifacts,
  copy,
}: {
  artifacts: AiArtifact[];
  copy: ArtifactRendererCopy;
}) {
  if (artifacts.length === 0) {
    return null;
  }

  return (
    <div className="space-y-8">
      {artifacts.map((artifact, index) => {
        if (artifact.kind === "executionReview") {
          return (
            <ExecutionReviewArtifactView
              artifact={artifact}
              copy={copy}
              key={`${artifact.kind}-${index}`}
            />
          );
        }

        if (artifact.kind === "knowledgeSignalRadar") {
          return (
            <KnowledgeSignalRadarArtifactView
              artifact={artifact}
              copy={copy}
              key={`${artifact.kind}-${index}`}
            />
          );
        }

        if (artifact.kind === "techRadar") {
          return (
            <TechRadarArtifactView
              artifact={artifact}
              key={`${artifact.kind}-${index}`}
            />
          );
        }

        return null;
      })}
    </div>
  );
}
