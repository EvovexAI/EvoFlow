import {
  claimNextQueuedJobDatabase,
  completeJobRunDatabase,
  enqueueJobRunDatabase,
  failJobRunDatabase,
  getJobRunDatabase,
  hasActiveWorkersDatabase,
  listJobRunsDatabase,
  markJobRunObservedDatabase,
  peekNextQueuedJobDatabase,
  upsertWorkerHeartbeatDatabase,
} from "./job-runs-db";
import {
  claimNextQueuedJobFile,
  completeJobRunFile,
  enqueueJobRunFile,
  failJobRunFile,
  getJobRunFile,
  hasActiveWorkersFile,
  listJobRunsFile,
  markJobRunObservedFile,
  peekNextQueuedJobFile,
  upsertWorkerHeartbeatFile,
} from "./job-runs-file";
import type {
  RunStatus as JobRunStatus,
  StoredJobRun,
  StoredWorkerHeartbeat,
} from "./run-state";
import type { Locale } from "./run-state";

export type { StoredJobRun, StoredWorkerHeartbeat };
export type { JobRunStatus };

export async function upsertWorkerHeartbeat(args: { workerId: string }) {
  const result = await upsertWorkerHeartbeatDatabase(args);
  return result ?? upsertWorkerHeartbeatFile(args);
}

export async function hasActiveWorkers(maxAgeMs = 5_000) {
  const result = await hasActiveWorkersDatabase(maxAgeMs);
  return result ?? hasActiveWorkersFile(maxAgeMs);
}

export async function enqueueJobRun(args: {
  jobId: string;
  locale: Locale;
}) {
  const result = await enqueueJobRunDatabase(args);
  return result ?? enqueueJobRunFile(args);
}

export async function getJobRun(runId: string) {
  const result = await getJobRunDatabase(runId);
  return result === undefined ? getJobRunFile(runId) : result;
}

export async function listJobRuns(limit = 6) {
  const result = await listJobRunsDatabase(limit);
  return result ?? listJobRunsFile(limit);
}

export async function peekNextQueuedJob() {
  const result = await peekNextQueuedJobDatabase();
  return result === undefined ? peekNextQueuedJobFile() : result;
}

export async function claimNextQueuedJob(args: { workerId: string }) {
  const result = await claimNextQueuedJobDatabase(args);
  return result === undefined ? claimNextQueuedJobFile(args) : result;
}

export async function completeJobRun(args: {
  result: Record<string, unknown>;
  runId: string;
}) {
  const result = await completeJobRunDatabase(args);
  return result === undefined ? completeJobRunFile(args) : result;
}

export async function failJobRun(args: {
  error: string;
  logLines?: string[];
  runId: string;
}) {
  const result = await failJobRunDatabase(args);
  return result === undefined ? failJobRunFile(args) : result;
}

export async function markJobRunObserved(runId: string) {
  const result = await markJobRunObservedDatabase(runId);
  return result === undefined ? markJobRunObservedFile(runId) : result;
}
