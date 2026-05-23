import {
  artifactRegistry,
  createObservabilitySnapshot,
  getObservabilitySources,
  observabilitySnapshotRequestSchema,
} from "@ai-site/ai";
import { platformPagesByLocale } from "@ai-site/content";
import { NextResponse } from "next/server";
import {
  getRuntimeObservabilityState,
  recordObservabilityRefresh,
} from "@/lib/observability/runtime-store";
import { checkRateLimit } from "@/lib/rate-limit";
import { verifyAdminSession } from "@/lib/admin-auth";

export async function GET(request: Request) {
  const rateLimited = checkRateLimit(request, "observability-get", { windowMs: 60_000, maxRequests: 30 });
  if (rateLimited) return rateLimited;
  return NextResponse.json({
    artifacts: Object.keys(artifactRegistry),
    status: "ready",
    surfaces: [
      "chat",
      "palette",
      "workflow",
      "admin-evolution",
      "admin-jobs",
      "admin-observability",
    ],
  });
}

export async function POST(request: Request) {
  const rateLimited = checkRateLimit(request, "observability", { windowMs: 60_000, maxRequests: 10 });
  if (rateLimited) return rateLimited;

  const isAdmin = await verifyAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const parsed = observabilitySnapshotRequestSchema.safeParse(payload);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_request",
        issues: parsed.error.flatten(),
      },
      { status: 400 },
    );
  }

  const locale = parsed.data.locale;
  await recordObservabilityRefresh({
    route: "/admin/observability",
    summary:
      locale === "zh"
        ? "已请求新的 observability snapshot，用于汇总 chat、workflow、jobs 与 evolution 的最新运行信号。"
        : "Requested a fresh observability snapshot to aggregate the latest runtime signals across chat, workflow, jobs, and evolution.",
  });
  const baseContent = platformPagesByLocale[locale].adminObservability;
  const runtimeState = await getRuntimeObservabilityState(locale);

  return NextResponse.json(
    createObservabilitySnapshot({
      locale,
      metrics: baseContent.metrics.map((metric, index) => ({
        ...metric,
        value: `${Number.parseInt(metric.value, 10) + (index === 0
          ? runtimeState.counts.llmRuns
          : index === 1
            ? runtimeState.counts.toolCalls
            : runtimeState.counts.uiActions)}`,
      })),
      sessions:
        runtimeState.sessions.length > 0 ? runtimeState.sessions : baseContent.sessions,
      sources: getObservabilitySources(locale),
      summary: runtimeState.summary,
      toolCalls: runtimeState.toolCalls,
      traces: runtimeState.traces.length > 0 ? runtimeState.traces : baseContent.traces,
    }),
  );
}
