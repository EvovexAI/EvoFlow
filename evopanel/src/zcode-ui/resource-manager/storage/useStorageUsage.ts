/**
 * useStorageUsage —— 资源管理器「存储」tab 的数据源，输入是 preload 暴露的 StorageManagementBridge。
 * 生命周期与 tab 绑定：enabled 时开始扫描并订阅进度，卸载 / 切走时取消；
 * 窗口失焦超过 60s 取消扫描，回到前台后重新开始（性能约束）。
 * 只消费当前 jobId 的快照，旧 job 的尾包直接丢弃；进入时先展示上次完成的快照（stale-while-revalidate）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  StorageCleanRequest,
  StorageCleanResult,
  StorageManagementBridge,
  StorageUsageSnapshot,
} from "@zcode/shared";
import { logger } from "@/logger.js";

const STORAGE_SCAN_BLUR_CANCEL_MS = 60_000;

interface StorageUsageState {
  snapshot: StorageUsageSnapshot | null;
  scanning: boolean;
  rescan: () => Promise<void>;
  clean: (request: StorageCleanRequest) => Promise<StorageCleanResult>;
}

export function useStorageUsage({
  bridge,
  enabled,
}: {
  bridge: StorageManagementBridge | undefined;
  enabled: boolean;
}): StorageUsageState {
  const [snapshot, setSnapshot] = useState<StorageUsageSnapshot | null>(null);
  const [scanning, setScanning] = useState(false);
  const jobIdRef = useRef<string | null>(null);

  const start = useCallback(async () => {
    if (!bridge) return;
    try {
      const { jobId } = await bridge.startScan();
      jobIdRef.current = jobId;
      setScanning(true);
    } catch (error) {
      logger.warn("[storage] startScan failed", { error });
      setScanning(false);
    }
  }, [bridge]);

  const cancel = useCallback(async () => {
    const jobId = jobIdRef.current;
    jobIdRef.current = null;
    setScanning(false);
    if (!jobId || !bridge) return;
    try {
      await bridge.cancelScan(jobId);
    } catch (error) {
      logger.warn("[storage] cancelScan failed", { error, jobId });
    }
  }, [bridge]);

  useEffect(() => {
    if (!enabled || !bridge) return;
    let disposed = false;
    const unsubscribe = bridge.subscribeScanProgress((next) => {
      if (disposed || next.jobId !== jobIdRef.current) return;
      setSnapshot(next);
      if (next.status !== "scanning") {
        jobIdRef.current = null;
        setScanning(false);
      }
    });
    void bridge
      .getSnapshot()
      .then((previous) => {
        if (!disposed && previous && !jobIdRef.current) setSnapshot(previous);
      })
      .catch(() => {});
    void start();
    return () => {
      disposed = true;
      unsubscribe();
      void cancel();
    };
  }, [enabled, bridge, start, cancel]);

  useEffect(() => {
    if (!enabled || !bridge || typeof window === "undefined") return;
    let blurTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelledByBlur = false;
    const onBlur = () => {
      if (blurTimer) clearTimeout(blurTimer);
      blurTimer = setTimeout(() => {
        blurTimer = null;
        if (!jobIdRef.current) return;
        cancelledByBlur = true;
        void cancel();
      }, STORAGE_SCAN_BLUR_CANCEL_MS);
    };
    const onFocus = () => {
      if (blurTimer) {
        clearTimeout(blurTimer);
        blurTimer = null;
      }
      if (cancelledByBlur) {
        cancelledByBlur = false;
        void start();
      }
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      if (blurTimer) clearTimeout(blurTimer);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, bridge, start, cancel]);

  const clean = useCallback(
    async (request: StorageCleanRequest) => {
      if (!bridge) throw new Error("storage bridge unavailable");
      jobIdRef.current = null;
      setScanning(false);
      const result = await bridge.clean(request);
      await start();
      return result;
    },
    [bridge, start],
  );

  return { snapshot, scanning, rescan: start, clean };
}
