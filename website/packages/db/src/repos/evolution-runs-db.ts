import { withDatabase } from "../client";
import {
  coerceTimestamp,
  coerceJsonRecord,
  coerceStringArray,
  createRunId,
  type Locale,
  MAX_RUNS,
  normalizeLogLines,
  type StoredEvolutionRun,
} from "./run-state";

interface EvolutionRunRow {
  action: string;
  completed_at: string | null;
  created_at: string;
  error: string | null;
  id: string;
  locale: Locale;
  log_lines: unknown;
  observability_recorded: boolean;
  result: unknown;
  started_at: string | null;
  status: StoredEvolutionRun["status"];
  worker_id: string | null;
}

function mapEvolutionRunRow(row: EvolutionRunRow): StoredEvolutionRun {
  return {
    action: row.action,
    completedAt: row.completed_at ? coerceTimestamp(row.completed_at) : null,
    createdAt: coerceTimestamp(row.created_at),
    error: row.error,
    id: row.id,
    locale: row.locale,
    logLines: normalizeLogLines(coerceStringArray(row.log_lines)),
    observabilityRecorded: row.observability_recorded,
    result: coerceJsonRecord(row.result),
    startedAt: row.started_at ? coerceTimestamp(row.started_at) : null,
    status: row.status,
    workerId: row.worker_id,
  };
}

async function trimEvolutionRuns() {
  return withDatabase(async (client) => {
    await client`
      DELETE FROM evolution_runs
      WHERE id NOT IN (
        SELECT id FROM evolution_runs
        ORDER BY created_at DESC
        LIMIT ${MAX_RUNS}
      )
    `;
  });
}

export async function enqueueEvolutionRunDatabase(args: {
  action: string;
  locale: Locale;
}) {
  return withDatabase(async (client) => {
    const now = new Date().toISOString();
    const run: StoredEvolutionRun = {
      action: args.action,
      completedAt: null,
      createdAt: now,
      error: null,
      id: createRunId(args.action),
      locale: args.locale,
      logLines: normalizeLogLines([`[manual] ${args.action} queued`]),
      observabilityRecorded: false,
      result: null,
      startedAt: null,
      status: "queued",
      workerId: null,
    };

    await client`
      INSERT INTO evolution_runs (
        id,
        action,
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
        ${run.action},
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
    await trimEvolutionRuns();

    return run;
  });
}

export async function getEvolutionRunDatabase(runId: string) {
  return withDatabase(async (client) => {
    const rows = await client<EvolutionRunRow[]>`
      SELECT *
      FROM evolution_runs
      WHERE id = ${runId}
      LIMIT 1
    `;

    return rows[0] ? mapEvolutionRunRow(rows[0]) : null;
  });
}

export async function listEvolutionRunsDatabase(limit = 6) {
  return withDatabase(async (client) => {
    const rows = await client<EvolutionRunRow[]>`
      SELECT *
      FROM evolution_runs
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;

    return rows.map(mapEvolutionRunRow);
  });
}

export async function peekNextQueuedEvolutionRunDatabase() {
  return withDatabase(async (client) => {
    const rows = await client<EvolutionRunRow[]>`
      SELECT *
      FROM evolution_runs
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT 1
    `;

    return rows[0] ? mapEvolutionRunRow(rows[0]) : null;
  });
}

export async function claimNextQueuedEvolutionRunDatabase(args: {
  workerId: string;
}) {
  return withDatabase(async (client) => {
    const nextRows = await client<EvolutionRunRow[]>`
      SELECT *
      FROM evolution_runs
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT 1
    `;

    if (!nextRows[0]) {
      return null;
    }

    const nextRun = mapEvolutionRunRow(nextRows[0]);
    const now = new Date().toISOString();
    const logLines = normalizeLogLines([
      ...nextRun.logLines,
      `[worker] ${nextRun.action} running on ${args.workerId}`,
    ]);
    const updatedRows = await client<EvolutionRunRow[]>`
      UPDATE evolution_runs
      SET
        started_at = ${now},
        status = 'running',
        worker_id = ${args.workerId},
        log_lines = ${JSON.stringify(logLines)}::jsonb
      WHERE id = ${nextRun.id}
        AND status = 'queued'
      RETURNING *
    `;

    return updatedRows[0] ? mapEvolutionRunRow(updatedRows[0]) : null;
  });
}

export async function completeEvolutionRunDatabase(args: {
  result: Record<string, unknown>;
  runId: string;
}) {
  return withDatabase(async (client) => {
    const currentRows = await client<EvolutionRunRow[]>`
      SELECT *
      FROM evolution_runs
      WHERE id = ${args.runId}
      LIMIT 1
    `;

    if (!currentRows[0]) {
      return null;
    }

    const currentRun = mapEvolutionRunRow(currentRows[0]);
    const logLines = normalizeLogLines(
      Array.isArray(args.result.logLines)
        ? args.result.logLines.filter((line): line is string => typeof line === "string")
        : currentRun.logLines,
    );
    const rows = await client<EvolutionRunRow[]>`
      UPDATE evolution_runs
      SET
        completed_at = ${new Date().toISOString()},
        error = NULL,
        log_lines = ${JSON.stringify(logLines)}::jsonb,
        result = ${JSON.stringify(args.result)}::jsonb,
        status = 'completed'
      WHERE id = ${args.runId}
      RETURNING *
    `;

    return rows[0] ? mapEvolutionRunRow(rows[0]) : null;
  });
}

export async function failEvolutionRunDatabase(args: {
  error: string;
  logLines?: string[];
  runId: string;
}) {
  return withDatabase(async (client) => {
    const rows = await client<EvolutionRunRow[]>`
      SELECT *
      FROM evolution_runs
      WHERE id = ${args.runId}
      LIMIT 1
    `;

    if (!rows[0]) {
      return null;
    }

    const currentRun = mapEvolutionRunRow(rows[0]);
    const logLines = normalizeLogLines([
      ...currentRun.logLines,
      ...(args.logLines ?? [`[error] ${args.error}`]),
    ]);
    const updatedRows = await client<EvolutionRunRow[]>`
      UPDATE evolution_runs
      SET
        completed_at = ${new Date().toISOString()},
        error = ${args.error},
        status = 'failed',
        log_lines = ${JSON.stringify(logLines)}::jsonb
      WHERE id = ${args.runId}
      RETURNING *
    `;

    return updatedRows[0] ? mapEvolutionRunRow(updatedRows[0]) : null;
  });
}

export async function markEvolutionRunObservedDatabase(runId: string) {
  return withDatabase(async (client) => {
    const rows = await client<EvolutionRunRow[]>`
      UPDATE evolution_runs
      SET observability_recorded = TRUE
      WHERE id = ${runId}
      RETURNING *
    `;

    return rows[0] ? mapEvolutionRunRow(rows[0]) : null;
  });
}
