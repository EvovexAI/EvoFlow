import {
  artifactRegistry,
  createEvolutionRunSnapshot,
  evolutionActionSchema,
  evolutionRequestSchema,
  evolutionRunResponseSchema,
} from "@ai-site/ai";
import { runEvolution } from "@ai-site/ai/src/evolution/runner";
import {
  completeEvolutionRun,
  enqueueEvolutionRun,
  getEvolutionRun,
  hasActiveWorkers,
  listEvolutionRuns,
  markEvolutionRunObserved,
  failEvolutionRun,
  type StoredEvolutionRun,
} from "@ai-site/db";
import { NextResponse } from "next/server";
import { recordEvolutionRuntime } from "@/lib/observability/runtime-store";
import { checkRateLimit } from "@/lib/rate-limit";

function buildEvolutionLogLines(args: {
  action: string;
  locale: "zh" | "en";
  status: "completed" | "failed";
  summary?: string;
}) {
  const base =
    args.status === "completed"
      ? args.locale === "zh"
        ? [
            `[manual] ${args.action} queued`,
            `[inline] ${args.action} running without active worker`,
            `[done] ${args.summary ?? `${args.action} completed`}`,
          ]
        : [
            `[manual] ${args.action} queued`,
            `[inline] ${args.action} running without active worker`,
            `[done] ${args.summary ?? `${args.action} completed`}`,
          ]
      : args.locale === "zh"
        ? [
            `[manual] ${args.action} queued`,
            `[inline] ${args.action} failed without active worker`,
            `[error] ${args.summary ?? `${args.action} failed`}`,
          ]
        : [
            `[manual] ${args.action} queued`,
            `[inline] ${args.action} failed without active worker`,
            `[error] ${args.summary ?? `${args.action} failed`}`,
          ];

  return [...base, "_"];
}

function buildPendingSummary(record: StoredEvolutionRun) {
  if (record.status === "failed") {
    return record.locale === "zh"
      ? `演化控制 ${record.action} 执行失败：${record.error ?? "unknown_error"}`
      : `The ${record.action} evolution control failed: ${record.error ?? "unknown_error"}`;
  }

  if (record.status === "running") {
    return record.locale === "zh"
      ? `演化控制 ${record.action} 已被 worker 接管，正在后台执行。`
      : `The ${record.action} evolution control has been claimed by the worker and is running in the background.`;
  }

  return record.locale === "zh"
    ? `演化控制 ${record.action} 已进入队列，等待 worker 接管。`
    : `The ${record.action} evolution control is queued and waiting for a worker to claim it.`;
}

function buildPendingBullets(record: StoredEvolutionRun) {
  if (record.status === "failed") {
    return record.locale === "zh"
      ? [
          `执行 ${record.action} 时出现错误。`,
          record.error ?? "unknown_error",
          "可重新触发该 control，或检查 worker / runtime store 状态。",
        ]
      : [
          `An error occurred while executing ${record.action}.`,
          record.error ?? "unknown_error",
          "You can trigger the control again or inspect the worker and runtime state.",
        ];
  }

  if (record.status === "running") {
    return record.locale === "zh"
      ? [
          `控制面 ${record.action} 已切换为后台运行。`,
          "worker 已领取该运行并正在推进 shared evolution runtime。",
          "当前结果会在完成后自动刷新到本页。",
        ]
      : [
          `The ${record.action} control has switched to background execution.`,
          "A worker has claimed this run and is advancing the shared evolution runtime.",
          "The result will refresh on this page once it finishes.",
        ];
  }

  return record.locale === "zh"
    ? [
        `控制面 ${record.action} 已进入队列。`,
        "当前正在等待可用 worker 领取执行。",
        "如果本地没有 worker，下一次 POST 会走 inline fallback。",
      ]
    : [
        `The ${record.action} control has been queued.`,
        "It is waiting for an available worker to claim it.",
        "If no local worker is active, the next POST will use the inline fallback.",
      ];
}

function buildEvolutionRunSnapshot(record: StoredEvolutionRun) {
  const parsedAction = evolutionActionSchema.safeParse(record.action);

  if (!parsedAction.success) {
    throw new Error(`Unsupported evolution action stored in queue: ${record.action}`);
  }

  const parsedResult = record.result
    ? evolutionRunResponseSchema.safeParse(record.result)
    : null;

  if (record.status === "completed" && parsedResult?.success) {
    return createEvolutionRunSnapshot({
      action: parsedAction.data,
      artifacts: parsedResult.data.artifacts,
      bullets: parsedResult.data.bullets,
      error: null,
      logLines:
        record.logLines.length > 0
          ? record.logLines
          : [`[completed] ${record.action}`, "_"],
      runId: record.id,
      sources: parsedResult.data.sources,
      status: "completed",
      summary: parsedResult.data.summary,
      toolCalls: parsedResult.data.toolCalls,
    });
  }

  return createEvolutionRunSnapshot({
    action: parsedAction.data,
    artifacts: [],
    bullets: buildPendingBullets(record),
    error: record.error,
    logLines:
      record.logLines.length > 0
        ? record.logLines
        : [`[${record.status}] ${record.action}`, "_"],
    runId: record.id,
    sources: [],
    status: record.status,
    summary: buildPendingSummary(record),
    toolCalls: [],
  });
}

async function recordCompletedEvolution(run: StoredEvolutionRun) {
  if (run.observabilityRecorded || !run.result) {
    return;
  }

  const parsedResult = evolutionRunResponseSchema.safeParse(run.result);

  if (!parsedResult.success) {
    return;
  }

  await recordEvolutionRuntime({
    action: run.action,
    route: "/admin/evolution",
    summary: parsedResult.data.summary,
    toolCalls: parsedResult.data.toolCalls,
  });
  await markEvolutionRunObserved(run.id);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const runId = searchParams.get("runId");

  if (!runId) {
    const recentRuns = await listEvolutionRuns(3);

    return NextResponse.json({
      artifacts: Object.keys(artifactRegistry),
      status: "ready",
      actions: ["rebuild_index", "run_sync", "generate_digest"],
      recentRuns: recentRuns.map((run) => ({
        action: run.action,
        createdAt: run.createdAt,
        id: run.id,
        status: run.status,
      })),
    });
  }

  const run = await getEvolutionRun(runId);

  if (!run) {
    return NextResponse.json(
      {
        error: "not_found",
        message: "Unknown evolution run.",
      },
      { status: 404 },
    );
  }

  if (run.status === "completed") {
    await recordCompletedEvolution(run);
  }

  return NextResponse.json(buildEvolutionRunSnapshot(run));
}

export async function POST(request: Request) {
  const rateLimited = checkRateLimit(request, "evolution", { windowMs: 60_000, maxRequests: 5 });
  if (rateLimited) return rateLimited;

  const payload = await request.json().catch(() => null);
  const parsed = evolutionRequestSchema.safeParse(payload);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_request",
        issues: parsed.error.flatten(),
      },
      { status: 400 },
    );
  }

  const queuedRun = await enqueueEvolutionRun({
    action: parsed.data.action,
    locale: parsed.data.locale,
  });

  if (await hasActiveWorkers()) {
    return NextResponse.json(buildEvolutionRunSnapshot(queuedRun), { status: 202 });
  }

  try {
    const evolutionResponse = await runEvolution(parsed.data);
    const completedRun = await completeEvolutionRun({
      result: {
        ...evolutionResponse,
        logLines: buildEvolutionLogLines({
          action: parsed.data.action,
          locale: parsed.data.locale,
          status: "completed",
          summary: evolutionResponse.summary,
        }),
      },
      runId: queuedRun.id,
    });

    if (!completedRun) {
      throw new Error("Failed to persist the completed evolution result.");
    }

    await recordEvolutionRuntime({
      action: parsed.data.action,
      route: "/admin/evolution",
      summary: evolutionResponse.summary,
      toolCalls: evolutionResponse.toolCalls,
    });
    await markEvolutionRunObserved(completedRun.id);

    return NextResponse.json(buildEvolutionRunSnapshot(completedRun));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Evolution execution failed.";
    const failedRun = await failEvolutionRun({
      error: message,
      logLines: buildEvolutionLogLines({
        action: parsed.data.action,
        locale: parsed.data.locale,
        status: "failed",
        summary: message,
      }),
      runId: queuedRun.id,
    });

    return NextResponse.json(
      failedRun
        ? buildEvolutionRunSnapshot(failedRun)
        : {
            error: "evolution_execution_failed",
            message,
          },
      { status: 500 },
    );
  }
}

