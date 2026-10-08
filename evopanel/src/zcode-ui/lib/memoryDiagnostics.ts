import {
  createMemoryDiagnosticsRegistry,
  createMemorySampleWriteGate,
  formatMemorySampleLine,
  MEMORY_SAMPLE_INTERVAL_MS,
  type MemoryDiagnosticsRegistry,
  type MemorySample,
  type RendererHeapSample,
} from "@zcode/shared";
import { logMemoryDiagnostics } from "@/logger.js";

/**
 * renderer 内存诊断计数器注册表。
 * 各缓存/store 模块在模块加载时注册纯读取 provider；`startMemoryDiagnosticsLogger` 每 60 秒
 * 采样一次，经门控后通过 `logger.logMemoryDiagnostics` 写桌面主日志。
 */
export const uiMemoryDiagnosticsRegistry: MemoryDiagnosticsRegistry =
  createMemoryDiagnosticsRegistry();

interface RendererHeapSnapshot {
  usedJSHeapSize?: number;
  totalJSHeapSize?: number;
}

/** Chromium 专有的 `performance.memory`；Web 端浏览器缺失时返回 undefined。 */
function readRendererHeapSnapshot(): RendererHeapSnapshot | undefined {
  if (typeof performance === "undefined") {
    return undefined;
  }
  const memory = (performance as Performance & { memory?: RendererHeapSnapshot }).memory;
  if (!memory || typeof memory.usedJSHeapSize !== "number") {
    return undefined;
  }
  return memory;
}

interface StartMemoryDiagnosticsLoggerOptions {
  intervalMs?: number;
  now?: () => number;
  readHeap?: () => RendererHeapSnapshot | undefined;
  write?: (line: string) => void;
  registry?: MemoryDiagnosticsRegistry;
  /**
   * 资源遥测出口：同一次读数除写本地
   * 诊断日志外，还经 preload 桥送 main 的 `renderer_main` 角色事件。由 App 注入
   * `platform.reportRendererHeapSample`；Web 端与手机远控没有桥，不注入即 no-op。
   */
  reportHeapSample?: (sample: RendererHeapSample) => void;
}

interface MemoryDiagnosticsLoggerHandle {
  sampleNow(): boolean;
  stop(): void;
}

export function startMemoryDiagnosticsLogger(
  options: StartMemoryDiagnosticsLoggerOptions = {},
): MemoryDiagnosticsLoggerHandle {
  const now = options.now ?? (() => Date.now());
  const readHeap = options.readHeap ?? readRendererHeapSnapshot;
  const write = options.write ?? logMemoryDiagnostics;
  const registry = options.registry ?? uiMemoryDiagnosticsRegistry;
  const reportHeapSample = options.reportHeapSample;
  const gate = createMemorySampleWriteGate();

  const sampleNow = (): boolean => {
    try {
      const heap = readHeap();
      const heapUsedKb = heap ? Math.round(heap.usedJSHeapSize! / 1024) : undefined;
      // 读到就先交给资源遥测：ARMS 要的是完整的 60 秒序列，而本地日志只在有变化时才写，
      // 两个出口不能共用同一个门控结论；计数器采集与格式化也不该拖走这条 heap 样本。
      if (heapUsedKb !== undefined) {
        try {
          reportHeapSample?.({ heapUsedKb });
        } catch {
          // 桥失败只丢这条遥测样本，本地诊断日志与渲染都不受影响。
        }
      }
      const sample: MemorySample = {
        role: "renderer",
        counters: registry.collect(),
      };
      if (heap) {
        sample.heapUsedKb = heapUsedKb;
        if (typeof heap.totalJSHeapSize === "number") {
          sample.heapTotalKb = Math.round(heap.totalJSHeapSize / 1024);
        }
      }
      const reason = gate.evaluate(sample, now());
      if (!reason) {
        return false;
      }
      write(formatMemorySampleLine(sample, reason));
      return true;
    } catch {
      // 诊断采样失败只丢当前样本，不能影响渲染。
      return false;
    }
  };

  let handle: ReturnType<typeof setInterval> | undefined = setInterval(
    sampleNow,
    options.intervalMs ?? MEMORY_SAMPLE_INTERVAL_MS,
  );

  return {
    sampleNow,
    stop() {
      if (handle === undefined) {
        return;
      }
      clearInterval(handle);
      handle = undefined;
    },
  };
}
