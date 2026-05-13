import {
  claimNextQueuedEvolutionRunDatabase,
  completeEvolutionRunDatabase,
  enqueueEvolutionRunDatabase,
  failEvolutionRunDatabase,
  getEvolutionRunDatabase,
  listEvolutionRunsDatabase,
  markEvolutionRunObservedDatabase,
  peekNextQueuedEvolutionRunDatabase,
} from "./evolution-runs-db";
import {
  claimNextQueuedEvolutionRunFile,
  completeEvolutionRunFile,
  enqueueEvolutionRunFile,
  failEvolutionRunFile,
  getEvolutionRunFile,
  listEvolutionRunsFile,
  markEvolutionRunObservedFile,
  peekNextQueuedEvolutionRunFile,
} from "./evolution-runs-file";
import type { Locale, RunStatus, StoredEvolutionRun } from "./run-state";

export type EvolutionRunStatus = RunStatus;
export type { StoredEvolutionRun };

export async function enqueueEvolutionRun(args: {
  action: string;
  locale: Locale;
}) {
  const result = await enqueueEvolutionRunDatabase(args);
  return result ?? enqueueEvolutionRunFile(args);
}

export async function getEvolutionRun(runId: string) {
  const result = await getEvolutionRunDatabase(runId);
  return result === undefined ? getEvolutionRunFile(runId) : result;
}

export async function listEvolutionRuns(limit = 6) {
  const result = await listEvolutionRunsDatabase(limit);
  return result ?? listEvolutionRunsFile(limit);
}

export async function peekNextQueuedEvolutionRun() {
  const result = await peekNextQueuedEvolutionRunDatabase();
  return result === undefined ? peekNextQueuedEvolutionRunFile() : result;
}

export async function claimNextQueuedEvolutionRun(args: {
  workerId: string;
}) {
  const result = await claimNextQueuedEvolutionRunDatabase(args);
  return result === undefined ? claimNextQueuedEvolutionRunFile(args) : result;
}

export async function completeEvolutionRun(args: {
  result: Record<string, unknown>;
  runId: string;
}) {
  const result = await completeEvolutionRunDatabase(args);
  return result === undefined ? completeEvolutionRunFile(args) : result;
}

export async function failEvolutionRun(args: {
  error: string;
  logLines?: string[];
  runId: string;
}) {
  const result = await failEvolutionRunDatabase(args);
  return result === undefined ? failEvolutionRunFile(args) : result;
}

export async function markEvolutionRunObserved(runId: string) {
  const result = await markEvolutionRunObservedDatabase(runId);
  return result === undefined ? markEvolutionRunObservedFile(runId) : result;
}
