import {
  collectVisibleZCodeBackgroundTaskControlItems,
  getZCodeBackgroundTaskControlItemElapsedMs,
  isActiveZCodeBackgroundTaskControlItem,
  parseZCodeBackgroundTaskControlItems,
  type ZCodeBackgroundTaskControlItem,
  type ZCodeBackgroundTaskControlStatus,
} from "./background-task-controls.js";

export type ZCodeBackgroundBashJobStatus = ZCodeBackgroundTaskControlStatus;
export type ZCodeBackgroundBashJob = ZCodeBackgroundTaskControlItem & {
  taskKind: "bash";
};

export function parseZCodeBackgroundBashJobs(value: unknown): ZCodeBackgroundBashJob[] {
  return parseZCodeBackgroundTaskControlItems(value).filter(isBackgroundBashJob);
}

export function isActiveZCodeBackgroundBashJob(job: ZCodeBackgroundBashJob): boolean {
  return isActiveZCodeBackgroundTaskControlItem(job);
}

export function getZCodeBackgroundBashJobElapsedMs(
  job: ZCodeBackgroundBashJob,
  now = Date.now(),
): number {
  return getZCodeBackgroundTaskControlItemElapsedMs(job, now);
}

export function collectVisibleZCodeBackgroundBashJobs(
  jobs: readonly ZCodeBackgroundBashJob[],
  now = Date.now(),
  thresholdMs = 30_000,
): Array<ZCodeBackgroundBashJob & { elapsedMs: number }> {
  return collectVisibleZCodeBackgroundTaskControlItems(jobs, now, thresholdMs) as Array<
    ZCodeBackgroundBashJob & { elapsedMs: number }
  >;
}

function isBackgroundBashJob(job: ZCodeBackgroundTaskControlItem): job is ZCodeBackgroundBashJob {
  return job.taskKind === "bash";
}
