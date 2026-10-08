import type { ZCodeBackgroundTaskControlItem } from "./background-task-controls.js";

export function mergeZCodeBackgroundTaskControlItems(
  current: readonly ZCodeBackgroundTaskControlItem[],
  updates: readonly ZCodeBackgroundTaskControlItem[],
): ZCodeBackgroundTaskControlItem[] {
  const jobsById = new Map(current.map((job) => [job.jobId, job] as const));
  for (const job of updates) {
    jobsById.set(job.jobId, job);
  }
  return Array.from(jobsById.values());
}
