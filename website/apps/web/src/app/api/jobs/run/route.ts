import {
  artifactRegistry,
  createJobRunSnapshot,
  jobRegistry,
  jobRunRequestSchema,
  jobRunResponseSchema,
  jobIdSchema,
} from "@ai-site/ai";
import {
  completeJobRun,
  enqueueJobRun,
  failJobRun,
  getJobRun,
  hasActiveWorkers,
  listJobRuns,
  markJobRunObserved,
  type StoredJobRun,
} from "@ai-site/db";
import { NextResponse } from "next/server";
import { runJob } from "@ai-site/ai/src/jobs/runner";
import { recordJobRuntime } from "@/lib/observability/runtime-store";
import { checkRateLimit } from "@/lib/rate-limit";

function parseDurationMs(duration: string) {
  return Math.round(Number.parseFloat(duration.replace("s", "")) * 1000);
}

function buildPendingSummary(record: StoredJobRun) {
  if (record.status === "failed") {
    return record.locale === "zh"
      ? `任务 ${record.jobId} 执行失败：${record.error ?? "unknown_error"}`
      : `The ${record.jobId} job failed: ${record.error ?? "unknown_error"}`;
  }

  if (record.status === "running") {
    return record.locale === "zh"
      ? `任务 ${record.jobId} 已被 worker 接管，正在后台执行。`
      : `The ${record.jobId} job has been claimed by the worker and is running in the background.`;
  }

  return record.locale === "zh"
    ? `任务 ${record.jobId} 已进入队列，等待 worker 接管。`
    : `The ${record.jobId} job is queued and waiting for a worker to claim it.`;
}

function buildJobRunSnapshot(record: StoredJobRun) {
  const parsedJobId = jobIdSchema.safeParse(record.jobId);

  if (!parsedJobId.success) {
    throw new Error(`Unsupported job id stored in queue: ${record.jobId}`);
  }

  const parsedResult = record.result
    ? jobRunResponseSchema.safeParse(record.result)
    : null;

  if (record.status === "completed" && parsedResult?.success) {
    return createJobRunSnapshot({
      artifacts: parsedResult.data.artifacts,
      error: null,
      jobId: parsedJobId.data,
      logLines: record.logLines.length ? record.logLines : parsedResult.data.logLines,
      recentRun: parsedResult.data.recentRun,
      runId: record.id,
      sources: parsedResult.data.sources,
      status: "completed",
      summary: parsedResult.data.summary,
      toolCalls: parsedResult.data.toolCalls,
    });
  }

  return createJobRunSnapshot({
    artifacts: [],
    error: record.error,
    jobId: parsedJobId.data,
    logLines:
      record.logLines.length > 0
        ? record.logLines
        : [`[${record.status}] ${record.jobId}`, "_"],
    recentRun: null,
    runId: record.id,
    sources: [],
    status: record.status,
    summary: buildPendingSummary(record),
    toolCalls: [],
  });
}

async function recordCompletedJob(run: StoredJobRun) {
  if (run.observabilityRecorded || !run.result) {
    return;
  }

  const parsedResult = jobRunResponseSchema.safeParse(run.result);

  if (!parsedResult.success) {
    return;
  }

  const durationMs = parseDurationMs(parsedResult.data.recentRun.duration);

  await recordJobRuntime({
    durationMs: Number.isFinite(durationMs) ? durationMs : 1000,
    jobName: run.jobId,
    route: "/admin/jobs",
    summary: parsedResult.data.summary,
    toolCalls: parsedResult.data.toolCalls,
  });
  await markJobRunObserved(run.id);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const runId = searchParams.get("runId");

  if (!runId) {
    return NextResponse.json({
      artifacts: Object.keys(artifactRegistry),
      jobs: Object.values(jobRegistry),
      recentRuns: (await listJobRuns(3)).map((run) => ({
        createdAt: run.createdAt,
        id: run.id,
        jobId: run.jobId,
        status: run.status,
      })),
      status: "ready",
    });
  }

  const run = await getJobRun(runId);

  if (!run) {
    return NextResponse.json(
      {
        error: "not_found",
        message: "Unknown job run.",
      },
      { status: 404 },
    );
  }

  if (run.status === "completed") {
    await recordCompletedJob(run);
  }

  return NextResponse.json(buildJobRunSnapshot(run));
}

export async function POST(request: Request) {
  const rateLimited = checkRateLimit(request, "jobs", { windowMs: 60_000, maxRequests: 5 });
  if (rateLimited) return rateLimited;

  const payload = await request.json().catch(() => null);
  const parsed = jobRunRequestSchema.safeParse(payload);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_request",
        issues: parsed.error.flatten(),
      },
      { status: 400 },
    );
  }

  const queuedRun = await enqueueJobRun({
    jobId: parsed.data.jobId,
    locale: parsed.data.locale,
  });

  if (await hasActiveWorkers()) {
    return NextResponse.json(buildJobRunSnapshot(queuedRun), { status: 202 });
  }

  try {
    const jobResponse = await runJob(parsed.data);
    const completedRun = await completeJobRun({
      result: jobResponse as unknown as Record<string, unknown>,
      runId: queuedRun.id,
    });

    if (!completedRun) {
      throw new Error("Failed to persist the completed job result.");
    }

    const durationMs = parseDurationMs(jobResponse.recentRun.duration);

    await recordJobRuntime({
      durationMs: Number.isFinite(durationMs) ? durationMs : 1000,
      jobName: parsed.data.jobId,
      route: "/admin/jobs",
      summary: jobResponse.summary,
      toolCalls: jobResponse.toolCalls,
    });
    await markJobRunObserved(completedRun.id);

    return NextResponse.json(buildJobRunSnapshot(completedRun));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Job execution failed.";
    const failedRun = await failJobRun({
      error: message,
      runId: queuedRun.id,
    });

    return NextResponse.json(
      failedRun
        ? buildJobRunSnapshot(failedRun)
        : {
            error: "job_execution_failed",
            message,
          },
      { status: 500 },
    );
  }
}
