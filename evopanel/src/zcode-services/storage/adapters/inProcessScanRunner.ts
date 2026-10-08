/**
 * 进程内扫描 runner：walker + domain 累加器 + 卷探测。
 * Worker 入口（desktop main）与单测都调用这里的 runStorageScan，保证只有一条扫描路径。
 */
import type { StorageScanProgress, VolumeProbePort } from "../app/ports.js";
import type { StoragePathError, StorageRootSpec, StorageRootUsage } from "@zcode/shared";
import { createStorageUsageAccumulator } from "../domain/usageAggregate.js";
import { walkStorageRoot } from "./fsWalker.js";
import { createFsVolumeProbe } from "./volumeProbe.js";

interface RunStorageScanOptions {
  roots: StorageRootSpec[];
  signal: AbortSignal;
  onProgress: (progress: StorageScanProgress) => void;
  volumeProbe?: VolumeProbePort;
  /** 上报进度的最小间隔；runner 自己也节流，避免 Worker 向主线程刷消息。默认 300ms。 */
  progressIntervalMs?: number;
  concurrency?: number;
  now?: () => number;
}

export async function runStorageScan(options: RunStorageScanOptions): Promise<StorageScanProgress> {
  const now = options.now ?? Date.now;
  const probe = options.volumeProbe ?? createFsVolumeProbe();
  const interval = options.progressIntervalMs ?? 300;
  const errors: StoragePathError[] = [];
  const finished: StorageRootUsage[] = [];
  let lastReportAt = -Infinity;

  for (const root of options.roots) {
    const accumulator = createStorageUsageAccumulator(root);
    const volume = await probe.probe(root.path);
    const report = () => {
      lastReportAt = now();
      options.onProgress({
        roots: [...finished, accumulator.snapshot(volume)],
        errors: [...errors],
      });
    };
    await walkStorageRoot({
      rootPath: root.path,
      signal: options.signal,
      concurrency: options.concurrency,
      onEntry: (entry) => {
        accumulator.add(entry);
        if (now() - lastReportAt >= interval) report();
      },
      onError: (error) => errors.push({ ...error, path: `${root.id}:${error.path}` }),
    });
    finished.push(accumulator.snapshot(volume));
  }
  const progress = { roots: finished, errors };
  options.onProgress(progress);
  return progress;
}
