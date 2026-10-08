/**
 * host 与 scheduler 两个 utilityProcess 自采 CPU / 内存的共用换算逻辑
 *
 * 只做差分换算：不持有定时器、也不负责发送。host 复用内存诊断日志既有的 60 秒定时器，
 * scheduler 自己起唯一的一个 unref 定时器，两边都把同一次 `process.memoryUsage()` 读数
 * 交给这里换算成一条样本。零外部进程，只用进程内 API。
 */

import { availableParallelism } from "node:os";
import { bytesToKb } from "../memoryDiagnostics.js";
import type { NodeSelfResourceSample } from "../validation.js";

interface NodeCpuUsageSnapshot {
  user: number;
  system: number;
}

/** Node 进程自采周期：60 秒，与本地内存诊断日志同节拍。 */
export const NODE_SELF_RESOURCE_SAMPLE_INTERVAL_MS = 60_000;

export interface NodeSelfResourceSamplerOptions {
  readCpuUsage?: () => NodeCpuUsageSnapshot;
  readMonotonicTimeNs?: () => bigint;
  logicalCpuCount?: number;
}

export interface NodeSelfResourceSampler {
  /**
   * 用调用方刚读到的 `memoryUsage` 换算一条样本。
   * 基线不可用（首次读数失败、时钟未前进、CPU 计数回退）时返回 null，只丢当前样本。
   */
  sample(memoryUsage: NodeJS.MemoryUsage): NodeSelfResourceSample | null;
}

interface SamplerBaseline {
  cpu: NodeCpuUsageSnapshot;
  monotonicTimeNs: bigint;
}

/** CPU 百分比保留 4 位小数，与 CLI 自采样本同口径。 */
function roundResourceMetric(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function createNodeSelfResourceSampler(
  options: NodeSelfResourceSamplerOptions = {},
): NodeSelfResourceSampler {
  const readCpuUsage = options.readCpuUsage ?? (() => process.cpuUsage());
  const readMonotonicTimeNs = options.readMonotonicTimeNs ?? (() => process.hrtime.bigint());
  const logicalCpuCount = Math.max(
    1,
    Math.min(4_096, Math.trunc(options.logicalCpuCount ?? availableParallelism())),
  );

  const readBaseline = (): SamplerBaseline | null => {
    try {
      return { cpu: readCpuUsage(), monotonicTimeNs: readMonotonicTimeNs() };
    } catch {
      return null;
    }
  };

  // 构造时就建立基线，第一个 60 秒 tick 才能直接产出样本而不是空转一轮。
  let baseline = readBaseline();

  return {
    sample(memoryUsage) {
      const next = readBaseline();
      if (!next) {
        return null;
      }
      const previous = baseline;
      baseline = next;
      if (!previous) {
        return null;
      }

      const elapsedNs = next.monotonicTimeNs - previous.monotonicTimeNs;
      const cpuDeltaUs =
        next.cpu.user - previous.cpu.user + (next.cpu.system - previous.cpu.system);
      if (elapsedNs <= 0n || cpuDeltaUs < 0) {
        return null;
      }

      const cpuCores = cpuDeltaUs / (Number(elapsedNs) / 1_000);
      return {
        cpuPercent: roundResourceMetric((cpuCores / logicalCpuCount) * 100),
        rssKb: bytesToKb(memoryUsage.rss),
        heapUsedKb: bytesToKb(memoryUsage.heapUsed),
      };
    },
  };
}
