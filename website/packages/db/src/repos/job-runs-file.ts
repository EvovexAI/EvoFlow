import fs from "node:fs";
import { storedJobRunStateSchema } from "./run-state";
import {
  createRunId,
  type Locale,
  MAX_RUNS,
  normalizeLogLines,
  pruneWorkers,
  type StoredJobRun,
  type StoredWorkerHeartbeat,
} from "./run-state";
import { resolveRuntimeFilePath } from "./runtime-files";

const JOB_RUNS_FILE = resolveRuntimeFilePath(
  process.env.JOB_RUNS_STORE_FILENAME || "job-runs.json",
);

function createEmptyState() {
  return storedJobRunStateSchema.parse({
    runs: [],
    workers: [],
  });
}

function readState() {
  try {
    const raw = fs.readFileSync(JOB_RUNS_FILE, "utf8");
    const parsed = storedJobRunStateSchema.safeParse(JSON.parse(raw));

    if (!parsed.success) {
      return createEmptyState();
    }

    return {
      runs: parsed.data.runs.slice(0, MAX_RUNS),
      workers: pruneWorkers(parsed.data.workers, Date.now()),
    };
  } catch {
    return createEmptyState();
  }
}

function writeState(state: ReturnType<typeof createEmptyState>) {
  fs.writeFileSync(
    JOB_RUNS_FILE,
    JSON.stringify(
      {
        runs: state.runs.slice(0, MAX_RUNS),
        workers: pruneWorkers(state.workers, Date.now()),
      },
      null,
      2,
    ),
    "utf8",
  );
}

function updateState<T>(
  mutator: (state: ReturnType<typeof createEmptyState>) => T,
) {
  const state = readState();
  const result = mutator(state);
  state.runs = state.runs.slice(0, MAX_RUNS);
  state.workers = pruneWorkers(state.workers, Date.now());
  writeState(state);
  return result;
}

function appendLogLines(run: StoredJobRun, lines: string[]) {
  run.logLines = normalizeLogLines([...run.logLines, ...lines]);
}

export async function upsertWorkerHeartbeatFile(args: { workerId: string }) {
  return updateState((state) => {
    const nextHeartbeat: StoredWorkerHeartbeat = {
      updatedAt: new Date().toISOString(),
      workerId: args.workerId,
    };
    const existingIndex = state.workers.findIndex(
      (worker) => worker.workerId === args.workerId,
    );

    if (existingIndex >= 0) {
      state.workers[existingIndex] = nextHeartbeat;
    } else {
      state.workers.unshift(nextHeartbeat);
    }

    return nextHeartbeat;
  });
}

export async function hasActiveWorkersFile(maxAgeMs = 5_000) {
  const nowMs = Date.now();
  const state = readState();

  return state.workers.some((worker) => {
    const updatedAtMs = Date.parse(worker.updatedAt);
    return Number.isFinite(updatedAtMs) && nowMs - updatedAtMs <= maxAgeMs;
  });
}

export async function enqueueJobRunFile(args: {
  jobId: string;
  locale: Locale;
}) {
  return updateState((state) => {
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

    state.runs.unshift(run);
    return run;
  });
}

export async function getJobRunFile(runId: string) {
  const state = readState();
  return state.runs.find((run) => run.id === runId) ?? null;
}

export async function listJobRunsFile(limit = 6) {
  const state = readState();
  return state.runs.slice(0, limit);
}

export async function peekNextQueuedJobFile() {
  const state = readState();

  return (
    [...state.runs]
      .reverse()
      .find((run) => run.status === "queued") ?? null
  );
}

export async function claimNextQueuedJobFile(args: { workerId: string }) {
  return updateState((state) => {
    const targetRun = [...state.runs]
      .reverse()
      .find((run) => run.status === "queued");

    if (!targetRun) {
      return null;
    }

    const now = new Date().toISOString();
    targetRun.startedAt = now;
    targetRun.status = "running";
    targetRun.workerId = args.workerId;
    appendLogLines(targetRun, [`[worker] ${targetRun.jobId} running on ${args.workerId}`]);

    return targetRun;
  });
}

export async function completeJobRunFile(args: {
  result: Record<string, unknown>;
  runId: string;
}) {
  return updateState((state) => {
    const run = state.runs.find((entry) => entry.id === args.runId);

    if (!run) {
      return null;
    }

    run.completedAt = new Date().toISOString();
    run.error = null;
    run.logLines = normalizeLogLines(
      Array.isArray(args.result.logLines)
        ? args.result.logLines.filter((line): line is string => typeof line === "string")
        : run.logLines,
    );
    run.result = args.result;
    run.status = "completed";

    return run;
  });
}

export async function failJobRunFile(args: {
  error: string;
  logLines?: string[];
  runId: string;
}) {
  return updateState((state) => {
    const run = state.runs.find((entry) => entry.id === args.runId);

    if (!run) {
      return null;
    }

    run.completedAt = new Date().toISOString();
    run.error = args.error;
    run.status = "failed";
    appendLogLines(run, args.logLines ?? [`[error] ${args.error}`]);

    return run;
  });
}

export async function markJobRunObservedFile(runId: string) {
  return updateState((state) => {
    const run = state.runs.find((entry) => entry.id === runId);

    if (!run) {
      return null;
    }

    run.observabilityRecorded = true;
    return run;
  });
}
