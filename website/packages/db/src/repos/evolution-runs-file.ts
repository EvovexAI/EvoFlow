import fs from "node:fs";
import { storedEvolutionRunStateSchema } from "./run-state";
import {
  createRunId,
  type Locale,
  MAX_RUNS,
  normalizeLogLines,
  type StoredEvolutionRun,
} from "./run-state";
import { resolveRuntimeFilePath } from "./runtime-files";

const EVOLUTION_RUNS_FILE = resolveRuntimeFilePath(
  process.env.EVOLUTION_RUNS_STORE_FILENAME || "evolution-runs.json",
);

function createEmptyState() {
  return storedEvolutionRunStateSchema.parse({
    runs: [],
  });
}

function readState() {
  try {
    const raw = fs.readFileSync(EVOLUTION_RUNS_FILE, "utf8");
    const parsed = storedEvolutionRunStateSchema.safeParse(JSON.parse(raw));

    if (!parsed.success) {
      return createEmptyState();
    }

    return {
      runs: parsed.data.runs.slice(0, MAX_RUNS),
    };
  } catch {
    return createEmptyState();
  }
}

function writeState(state: ReturnType<typeof createEmptyState>) {
  fs.writeFileSync(
    EVOLUTION_RUNS_FILE,
    JSON.stringify(
      {
        runs: state.runs.slice(0, MAX_RUNS),
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
  writeState(state);
  return result;
}

function appendLogLines(run: StoredEvolutionRun, lines: string[]) {
  run.logLines = normalizeLogLines([...run.logLines, ...lines]);
}

export async function enqueueEvolutionRunFile(args: {
  action: string;
  locale: Locale;
}) {
  return updateState((state) => {
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

    state.runs.unshift(run);
    return run;
  });
}

export async function getEvolutionRunFile(runId: string) {
  const state = readState();
  return state.runs.find((run) => run.id === runId) ?? null;
}

export async function listEvolutionRunsFile(limit = 6) {
  const state = readState();
  return state.runs.slice(0, limit);
}

export async function peekNextQueuedEvolutionRunFile() {
  const state = readState();

  return (
    [...state.runs]
      .reverse()
      .find((run) => run.status === "queued") ?? null
  );
}

export async function claimNextQueuedEvolutionRunFile(args: {
  workerId: string;
}) {
  return updateState((state) => {
    const targetRun = [...state.runs]
      .reverse()
      .find((run) => run.status === "queued");

    if (!targetRun) {
      return null;
    }

    targetRun.startedAt = new Date().toISOString();
    targetRun.status = "running";
    targetRun.workerId = args.workerId;
    appendLogLines(targetRun, [
      `[worker] ${targetRun.action} running on ${args.workerId}`,
    ]);

    return targetRun;
  });
}

export async function completeEvolutionRunFile(args: {
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

export async function failEvolutionRunFile(args: {
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

export async function markEvolutionRunObservedFile(runId: string) {
  return updateState((state) => {
    const run = state.runs.find((entry) => entry.id === runId);

    if (!run) {
      return null;
    }

    run.observabilityRecorded = true;
    return run;
  });
}
