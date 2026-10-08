import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useBrowserUseOperationActive } from "@/browser-use/useBrowserUseOperationActive.js";
import { logger } from "@/logger.js";

const RESIZE_WARNING_DURATION_MS = 3_000;
const AGENT_LAYOUT_SETTLE_MIN_DURATION_MS = 300;
const AGENT_LAYOUT_SETTLE_QUIET_DURATION_MS = 100;
const AGENT_LAYOUT_SETTLE_MAX_DURATION_MS = 500;

/**
 * 在与 tab 鼠标图标相同的 Browser Use active 周期内监听浏览器区域尺寸。
 * 这里只产生 renderer 本地弱提示，不取消工具、不修改 snapshot，也不把状态写入协议层。
 */
export function useBrowserResizeOperationWarning({
  browserKey,
  isVisible,
  operationUntil,
  resizeBaselineVersion,
}: {
  browserKey: string;
  isVisible: boolean;
  operationUntil?: number;
  resizeBaselineVersion?: number;
}) {
  const [showResizeWarning, setShowResizeWarning] = useState(false);
  const browserRegionRef = useRef<HTMLDivElement | null>(null);
  const lastSizeRef = useRef<{ width: number; height: number } | null>(null);
  const warnedForActiveCycleRef = useRef(false);
  const warningTimerRef = useRef<number | null>(null);
  const agentLayoutSettleUntilRef = useRef(0);
  const agentLayoutSettleMaxUntilRef = useRef(0);
  const previousResizeBaselineVersionRef = useRef(resizeBaselineVersion);
  const hasAppliedResizeBaselineVersionRef = useRef(false);
  const isVisibleRef = useRef(isVisible);
  const isAgentOperating = useBrowserUseOperationActive(operationUntil);
  const isAgentOperatingRef = useRef(isAgentOperating);
  // ResizeObserver 可能在 effect 刷新前回调；render 时同步 ref，确保它和图标当帧状态一致。
  isVisibleRef.current = isVisible;
  isAgentOperatingRef.current = isAgentOperating;

  const warnForBrowserResize = useCallback(() => {
    if (!isVisibleRef.current || !isAgentOperatingRef.current || warnedForActiveCycleRef.current) {
      return;
    }

    warnedForActiveCycleRef.current = true;
    setShowResizeWarning(true);
    warningTimerRef.current = window.setTimeout(() => {
      warningTimerRef.current = null;
      setShowResizeWarning(false);
    }, RESIZE_WARNING_DURATION_MS);
  }, []);

  const beginAgentLayoutSettlement = useCallback(() => {
    const now = Date.now();
    lastSizeRef.current = null;
    agentLayoutSettleUntilRef.current = now + AGENT_LAYOUT_SETTLE_MIN_DURATION_MS;
    agentLayoutSettleMaxUntilRef.current = now + AGENT_LAYOUT_SETTLE_MAX_DURATION_MS;
  }, []);

  const prepareForAgentViewportChange = useCallback(
    (willChangeResponsiveMode: boolean) => {
      if (!willChangeResponsiveMode) return;
      beginAgentLayoutSettlement();
    },
    [beginAgentLayoutSettlement],
  );

  useLayoutEffect(() => {
    const previousVersion = previousResizeBaselineVersionRef.current;
    const hasAppliedVersion = hasAppliedResizeBaselineVersionRef.current;
    const hasInitialAgentMarker = !hasAppliedVersion && (resizeBaselineVersion ?? 0) > 0;
    const agentMarkerChanged = hasAppliedVersion && previousVersion !== resizeBaselineVersion;
    previousResizeBaselineVersionRef.current = resizeBaselineVersion;
    hasAppliedResizeBaselineVersionRef.current = true;

    // 模型 newTab 的 ready/visibility 先挂载 view，真实 tabId 对应的 operation 后到；
    // marker 之后 guest 挂载和 side-pane 动画还会产生多帧 ResizeObserver 回调。只清一次
    // baseline 会吞掉第一帧，却把第二帧误报成用户 resize。这里对模型布局 marker 开启
    // 有界稳定期；普通初挂载/用户切 tab 仍只重建 baseline，不扩大静默窗口。
    lastSizeRef.current = null;
    if (hasInitialAgentMarker || agentMarkerChanged) beginAgentLayoutSettlement();
  }, [beginAgentLayoutSettlement, isVisible, resizeBaselineVersion]);

  useEffect(() => {
    if (isAgentOperating) return;
    warnedForActiveCycleRef.current = false;
    setShowResizeWarning(false);
    if (warningTimerRef.current !== null) {
      window.clearTimeout(warningTimerRef.current);
      warningTimerRef.current = null;
    }
  }, [isAgentOperating]);

  useEffect(() => {
    const element = browserRegionRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const nextSize = {
        width: Math.round(entry.contentRect.width),
        height: Math.round(entry.contentRect.height),
      };
      if (nextSize.width <= 0 || nextSize.height <= 0) return;

      const previousSize = lastSizeRef.current;
      lastSizeRef.current = nextSize;
      const now = Date.now();
      const isAgentLayoutSettling = now <= agentLayoutSettleUntilRef.current;
      if (isAgentLayoutSettling) {
        agentLayoutSettleUntilRef.current = Math.min(
          agentLayoutSettleMaxUntilRef.current,
          Math.max(agentLayoutSettleUntilRef.current, now + AGENT_LAYOUT_SETTLE_QUIET_DURATION_MS),
        );
      }
      const sizeChanged =
        previousSize !== null &&
        (previousSize.width !== nextSize.width || previousSize.height !== nextSize.height);
      logger.debug("[browser-use] browser region ResizeObserver", {
        browserKey,
        isAgentOperating: isAgentOperatingRef.current,
        isVisible: isVisibleRef.current,
        nextSize,
        previousSize,
        resizeBaselineVersion,
        isAgentLayoutSettling,
        sizeChanged,
        warnedForActiveCycle: warnedForActiveCycleRef.current,
      });
      if (!sizeChanged || isAgentLayoutSettling) return;

      // 坐标类动作可能仍基于 resize 前的视觉信息。同一 active 周期只提示一次，
      // 避免连续拖拽产生提示风暴，同时保持 locator/CUA 的既有执行语义不变。
      warnForBrowserResize();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [browserKey, resizeBaselineVersion, warnForBrowserResize]);

  useEffect(
    () => () => {
      if (warningTimerRef.current !== null) window.clearTimeout(warningTimerRef.current);
    },
    [],
  );

  return {
    browserRegionRef,
    notifyBrowserViewportResize: warnForBrowserResize,
    prepareForAgentViewportChange,
    showResizeWarning,
  };
}
