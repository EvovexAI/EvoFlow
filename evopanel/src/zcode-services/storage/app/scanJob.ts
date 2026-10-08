/**
 * 单次扫描 job：持有 AbortController，把 runner 的进度节流成 ≥ throttleMs 一次的快照事件，
 * 终态（complete / cancelled / failed）必发。状态只能 scanning → 终态。
 */
import type { StorageRootSpec, StorageUsageSnapshot } from "@zcode/shared";
import type { ScanRunnerPort, StorageScanProgress } from "./ports.js";

export interface ScanJob {
  readonly jobId: string;
  readonly done: Promise<StorageUsageSnapshot>;
  cancel(): void;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function createScanJob(params: {
  jobId: string;
  roots: StorageRootSpec[];
  runner: ScanRunnerPort;
  now: () => number;
  throttleMs: number;
  emit: (snapshot: StorageUsageSnapshot) => void;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): ScanJob {
  const { jobId, roots, runner, now, throttleMs, emit } = params;
  const setTimer = params.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = params.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  const controller = new AbortController();
  const startedAt = now();
  let latest: StorageUsageSnapshot = {
    jobId,
    status: "scanning",
    startedAt,
    roots: roots.map((root) => ({
      id: root.id,
      path: root.path,
      volume: null,
      bytes: 0,
      fileCount: 0,
      categories: [],
    })),
    errors: [],
  };
  let lastEmitAt = -Infinity;
  let pendingTimer: unknown = null;
  let settled = false;

  const flush = () => {
    pendingTimer = null;
    lastEmitAt = now();
    emit(latest);
  };
  const onProgress = (progress: StorageScanProgress) => {
    if (settled) return;
    latest = { ...latest, roots: progress.roots, errors: progress.errors };
    const elapsed = now() - lastEmitAt;
    if (elapsed >= throttleMs) {
      flush();
    } else if (pendingTimer == null) {
      pendingTimer = setTimer(flush, throttleMs - elapsed);
    }
  };
  const settle = (snapshot: StorageUsageSnapshot) => {
    settled = true;
    if (pendingTimer != null) {
      clearTimer(pendingTimer);
      pendingTimer = null;
    }
    latest = snapshot;
    emit(latest);
    return latest;
  };

  const done = runner
    .run({ roots, signal: controller.signal, onProgress })
    .then((progress) =>
      settle({
        ...latest,
        roots: progress.roots,
        errors: progress.errors,
        status: controller.signal.aborted ? "cancelled" : "complete",
        finishedAt: now(),
      }),
    )
    .catch((error: unknown) =>
      settle({
        ...latest,
        status: isAbortError(error) || controller.signal.aborted ? "cancelled" : "failed",
        finishedAt: now(),
        errors: isAbortError(error)
          ? latest.errors
          : [...latest.errors, { path: "", code: errorCode(error) }],
      }),
    );

  return {
    jobId,
    done,
    cancel: () => controller.abort(),
  };
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return error instanceof Error ? error.name : "UNKNOWN";
}
