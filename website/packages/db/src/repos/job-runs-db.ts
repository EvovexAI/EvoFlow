import { withDatabase } from "../client";
import {
  coerceTimestamp,
  coerceJsonRecord,
  coerceStringArray,
  createRunId,
  type Locale,
  MAX_RUNS,
  normalizeLogLines,
  STALE_WORKER_WINDOW_MS,
  type StoredJobRun,
  type StoredWorkerHeartbeat,
} from "./run-state";

interface JobRunRow {
  completed_at: string | null;
  created_at: string;
  error: string | null;
  id: string;
  job_id: string;
  locale: Locale;
  log_lines: unknown;
  observability_recorded: boolean;
  result: unknown;
  started_at: string | null;
  status: StoredJobRun["status"];
  worker_id: string | null;
}

function mapJobRunRow(row: JobRunRow): StoredJobRun {
  return {
    completedAt: row.completed_at ? coerceTimestamp(row.completed_at) : null,
    createdAt: coerceTimestamp(row.created_at),
    error: row.error,
    id: row.id,
    jobId: row.job_id,
    locale: row.locale,
    logLines: normalizeLogLines(coerceStringArray(row.log_lines)),
    observabilityRecorded: row.observability_recorded,
    result: coerceJsonRecord(row.result),
    startedAt: row.started_at ? coerceTimestamp(row.started_at) : null,
    status: row.status,
    workerId: row.worker_id,
  };
}

async function trimJobRuns() {
  return withDatabase(async (client) => {
    await client`
      DELETE FROM job_runs
      WHERE id NOT IN (
        SELECT id FROM job_runs
        ORDER BY created_at DESC
        LIMIT ${MAX_RUNS}
      )
    `;
  });
}

async function pruneWorkerHeartbeats() {
  return withDatabase(async (client) => {
    const threshold = new Date(Date.now() - STALE_WORKER_WINDOW_MS).toISOString();

    await client`
      DELETE FROM worker_heartbeats
      WHERE updated_at < ${threshold}
    `;
  });
}

export async function upsertWorkerHeartbeatDatabase(args: {
  workerId: string;
}) {
  return withDatabase(async (client) => {
    const heartbeat: StoredWorkerHeartbeat = {
      updatedAt: new Date().toISOString(),
      workerId: args.workerId,
    };

    await client`
      INSERT INTO worker_heartbeats (worker_id, updated_at)
      VALUES (${heartbeat.workerId}, ${heartbeat.updatedAt})
      ON CONFLICT (worker_id)
      DO UPDATE SET updated_at = EXCLUDED.updated_at
    `;
    await pruneWorkerHeartbeats();

    return heartbeat;
  });
}

export async function hasActiveWorkersDatabase(maxAgeMs = 5_000) {
  return withDatabase(async (client) => {
    const threshold = new Date(Date.now() - maxAgeMs).toISOString();
    const rows = await client`
      SELECT worker_id
      FROM worker_heartbeats
      WHERE updated_at >= ${threshold}
      LIMIT 1
    `;

    return rows.length > 0;
  });
}

export async function enqueueJobRunDatabase(args: {
  jobId: string;
  locale: Locale;
}) {
  return withDatabase(async (client) => {
    const now = new Date().toISOString();
    const run: StoredJobRun = {
      completedAt: null,
      createdAt: now,
      error: null,
      id: createRunId(args.jobId),
      jobId: args.jobId,
      locale: args.locale,
      logLines: normalizeLogLines([`[manual] ${args.jobId} queued`]),
      observabilityRecorded: false,
      result: null,
      startedAt: null,
      status: "queued",
      workerId: null,
    };

    await client`
      INSERT INTO job_runs (
        id,
        job_id,
        locale,
        status,
        created_at,
        started_at,
        completed_at,
        worker_id,
        error,
        log_lines,
        result,
        observability_recorded
      ) VALUES (
        ${run.id},
        ${run.jobId},
        ${run.locale},
        ${run.status},
        ${run.createdAt},
        ${run.startedAt},
        ${run.completedAt},
        ${run.workerId},
        ${run.error},
        ${JSON.stringify(run.logLines)}::jsonb,
        ${run.result ? JSON.stringify(run.result) : null}::jsonb,
        ${run.observabilityRecorded}
      )
    `;
    await trimJobRuns();

    return run;
  });
}

export async function getJobRunDatabase(runId: string) {
  return withDatabase(async (client) => {
    const rows = await client<JobRunRow[]>`
      SELECT *
      FROM job_runs
      WHERE id = ${runId}
      LIMIT 1
    `;

    return rows[0] ? mapJobRunRow(rows[0]) : null;
  });
}

export async function listJobRunsDatabase(limit = 6) {
  return withDatabase(async (client) => {
    const rows = await client<JobRunRow[]>`
      SELECT *
      FROM job_runs
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;

    return rows.map(mapJobRunRow);
  });
}

export async function peekNextQueuedJobDatabase() {
  return withDatabase(async (client) => {
    const rows = await client<JobRunRow[]>`
      SELECT *
      FROM job_runs
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT 1
    `;

    return rows[0] ? mapJobRunRow(rows[0]) : null;
  });
}

export async function claimNextQueuedJobDatabase(args: { workerId: string }) {
  return withDatabase(async (client) => {
    const nextRows = await client<JobRunRow[]>`
      SELECT *
      FROM job_runs
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT 1
    `;

    if (!nextRows[0]) {
      return null;
    }

    const nextRun = mapJobRunRow(nextRows[0]);
    const now = new Date().toISOString();
    const logLines = normalizeLogLines([
      ...nextRun.logLines,
      `[worker] ${nextRun.jobId} running on ${args.workerId}`,
    ]);
    const updatedRows = await client<JobRunRow[]>`
      UPDATE job_runs
      SET
        started_at = ${now},
        status = 'running',
        worker_id = ${args.workerId},
        log_lines = ${JSON.stringify(logLines)}::jsonb
      WHERE id = ${nextRun.id}
        AND status = 'queued'
      RETURNING *
    `;

    return updatedRows[0] ? mapJobRunRow(updatedRows[0]) : null;
  });
}

export async function completeJobRunDatabase(args: {
  result: Record<string, unknown>;
  runId: string;
}) {
  return withDatabase(async (client) => {
    const currentRows = await client<JobRunRow[]>`
      SELECT *
      FROM job_runs
      WHERE id = ${args.runId}
      LIMIT 1
    `;

    if (!currentRows[0]) {
      return null;
    }

    const currentRun = mapJobRunRow(currentRows[0]);
    const logLines = normalizeLogLines(
      Array.isArray(args.result.logLines)
        ? args.result.logLines.filter((line): line is string => typeof line === "string")
        : currentRun.logLines,
    );
    const rows = await client<JobRunRow[]>`
      UPDATE job_runs
      SET
        completed_at = ${new Date().toISOString()},
        error = NULL,
        log_lines = ${JSON.stringify(logLines)}::jsonb,
        result = ${JSON.stringify(args.result)}::jsonb,
        status = 'completed'
      WHERE id = ${args.runId}
      RETURNING *
    `;

    return rows[0] ? mapJobRunRow(rows[0]) : null;
  });
}

export async function failJobRunDatabase(args: {
  error: string;
  logLines?: string[];
  runId: string;
}) {
  return withDatabase(async (client) => {
    const rows = await client<JobRunRow[]>`
      SELECT *
      FROM job_runs
      WHERE id = ${args.runId}
      LIMIT 1
    `;

    if (!rows[0]) {
      return null;
    }

    const currentRun = mapJobRunRow(rows[0]);
    const logLines = normalizeLogLines([
      ...currentRun.logLines,
      ...(args.logLines ?? [`[error] ${args.error}`]),
    ]);
    const updatedRows = await client<JobRunRow[]>`
      UPDATE job_runs
      SET
        completed_at = ${new Date().toISOString()},
        error = ${args.error},
        status = 'failed',
        log_lines = ${JSON.stringify(logLines)}::jsonb
      WHERE id = ${args.runId}
      RETURNING *
    `;

    return updatedRows[0] ? mapJobRunRow(updatedRows[0]) : null;
  });
}

export async function markJobRunObservedDatabase(runId: string) {
  return withDatabase(async (client) => {
    const rows = await client<JobRunRow[]>`
      UPDATE job_runs
      SET observability_recorded = TRUE
      WHERE id = ${runId}
      RETURNING *
    `;

    return rows[0] ? mapJobRunRow(rows[0]) : null;
  });
}
