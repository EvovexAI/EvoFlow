import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BrowserViewportSize,
  BrowserViewportZoom,
  EmbeddedBrowserViewportPreference,
} from "@zcode/shared";
import { DEFAULT_BROWSER_VIEWPORT_ZOOM } from "@/browser-use/browserViewportZoom.js";
import { DEFAULT_RESPONSIVE_BROWSER_VIEWPORT_SIZE } from "@/browser-use/ResponsiveBrowserViewport.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";

export type HumanBrowserViewportPreferenceChangeSource = "mode" | "viewport" | "zoom";

export function useResponsiveBrowserViewportControl({
  browserKey,
  desktopZoomFactor,
  onAgentViewportChange,
  onViewportSynchronized,
  onViewportResize,
  initialHumanViewportPreference,
  onHumanViewportPreferenceChange,
  sessionId,
}: {
  browserKey: string;
  desktopZoomFactor: number;
  onAgentViewportChange: (willChangeResponsiveMode: boolean) => void;
  onViewportSynchronized: () => void;
  onViewportResize: () => void;
  initialHumanViewportPreference?: EmbeddedBrowserViewportPreference;
  onHumanViewportPreferenceChange?: (
    preference: EmbeddedBrowserViewportPreference,
    source: HumanBrowserViewportPreferenceChangeSource,
  ) => void;
  sessionId?: string;
}) {
  const platform = usePlatform();
  const initialResponsiveMode = initialHumanViewportPreference?.mode === "responsive";
  const initialResponsiveViewportSize =
    initialHumanViewportPreference?.viewport ?? DEFAULT_RESPONSIVE_BROWSER_VIEWPORT_SIZE;
  const initialResponsiveViewportZoom =
    initialHumanViewportPreference?.zoom ?? DEFAULT_BROWSER_VIEWPORT_ZOOM;
  const [isResponsiveMode, setIsResponsiveMode] = useState(initialResponsiveMode);
  const [responsiveViewportSize, setResponsiveViewportSize] = useState<BrowserViewportSize>({
    ...initialResponsiveViewportSize,
  });
  const [responsiveViewportZoom, setResponsiveViewportZoom] = useState<BrowserViewportZoom>(
    initialResponsiveViewportZoom,
  );
  const isResponsiveModeRef = useRef(initialResponsiveMode);
  const responsiveViewportSizeRef = useRef<BrowserViewportSize>({
    ...initialResponsiveViewportSize,
  });
  const responsiveViewportZoomRef = useRef<BrowserViewportZoom>(initialResponsiveViewportZoom);
  const didSynchronizeInitialHumanViewportRef = useRef(false);
  const lastDesktopZoomFactorRef = useRef(desktopZoomFactor);
  const wasResponsiveModeForZoomRef = useRef(initialResponsiveMode);

  const reportHumanViewportPreference = useCallback(
    (source: HumanBrowserViewportPreferenceChangeSource) => {
      if (!initialHumanViewportPreference || !onHumanViewportPreferenceChange) return;
      onHumanViewportPreferenceChange(
        {
          mode: isResponsiveModeRef.current ? "responsive" : "normal",
          viewport: { ...responsiveViewportSizeRef.current },
          zoom: responsiveViewportZoomRef.current,
        },
        source,
      );
    },
    [initialHumanViewportPreference, onHumanViewportPreferenceChange],
  );

  const applyResponsiveMode = useCallback((nextMode: boolean) => {
    // viewport 事件也会用于模式内尺寸同步；仅在 false → true 时重置，避免覆盖用户刚选的固定缩放。
    if (nextMode && !isResponsiveModeRef.current) {
      responsiveViewportZoomRef.current = DEFAULT_BROWSER_VIEWPORT_ZOOM;
      setResponsiveViewportZoom(DEFAULT_BROWSER_VIEWPORT_ZOOM);
    }
    isResponsiveModeRef.current = nextMode;
    setIsResponsiveMode(nextMode);
  }, []);

  const updateControlledViewport = useCallback(
    (viewport: BrowserViewportSize | null) => {
      const request = platform.browserViewUpdateViewport?.({ tabId: browserKey, viewport });
      if (!request) return;
      void request
        .then(() => {
          // metrics 在 main 内串行完成后再把 guest zoom 固定回 1。若提前在
          // React effect 中设置，Desktop page zoom 的异步传播会再将 guest 改回全局缩放。
          if (viewport) onViewportSynchronized();
        })
        .catch((error) => {
          logger.debug("[browser-use] 同步 tab viewport 失败", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [browserKey, onViewportSynchronized, platform],
  );

  useEffect(() => {
    const wasResponsiveMode = wasResponsiveModeForZoomRef.current;
    const zoomChanged = lastDesktopZoomFactorRef.current !== desktopZoomFactor;
    wasResponsiveModeForZoomRef.current = isResponsiveMode;
    lastDesktopZoomFactorRef.current = desktopZoomFactor;
    if (!isResponsiveMode || !wasResponsiveMode || !zoomChanged) return;
    // Electron 放大 Desktop page zoom 后，guest native raster 仍按缩放前的
    // backing 尺寸输出。zoom 每次变化都重发同一 viewport，让 main 从可信
    // BrowserWindow 读取当前 zoom factor 并重放 metrics；不把 zoom 写入 Agent viewport 状态。
    updateControlledViewport(responsiveViewportSize);
  }, [desktopZoomFactor, isResponsiveMode, responsiveViewportSize, updateControlledViewport]);

  useEffect(() => {
    return platform.onBrowserViewViewportChanged?.((payload) => {
      if (payload.tabId !== browserKey) return;
      if (sessionId && payload.sessionId !== sessionId) return;
      const willChangeResponsiveMode = (payload.viewport !== null) !== isResponsiveModeRef.current;
      onAgentViewportChange(willChangeResponsiveMode);
      logger.debug("[browser-use] 模型 viewport 变更不触发 resize 弱提示", {
        modeChanged: willChangeResponsiveMode,
        tabId: browserKey,
        viewport: payload.viewport,
      });
      if (payload.viewport) {
        responsiveViewportSizeRef.current = { ...payload.viewport };
        setResponsiveViewportSize({ ...payload.viewport });
        applyResponsiveMode(true);
        // Agent 创建/设置 viewport 的 main 路径不经过 renderer IPC；只在当前窗口
        // 处于放大档位时回送一次，让 main 补入可信 zoom factor。默认/缩小不需要回声。
        if (desktopZoomFactor > 1) updateControlledViewport(payload.viewport);
        return;
      }
      applyResponsiveMode(false);
    });
  }, [
    applyResponsiveMode,
    browserKey,
    desktopZoomFactor,
    onAgentViewportChange,
    platform,
    sessionId,
    updateControlledViewport,
  ]);

  const toggleResponsiveMode = useCallback(() => {
    onViewportResize();
    const nextMode = !isResponsiveModeRef.current;
    applyResponsiveMode(nextMode);
    updateControlledViewport(nextMode ? responsiveViewportSize : null);
    reportHumanViewportPreference("mode");
  }, [
    applyResponsiveMode,
    onViewportResize,
    reportHumanViewportPreference,
    responsiveViewportSize,
    updateControlledViewport,
  ]);

  const updateResponsiveViewportSize = useCallback(
    (viewportSize: BrowserViewportSize) => {
      responsiveViewportSizeRef.current = { ...viewportSize };
      setResponsiveViewportSize(viewportSize);
      updateControlledViewport(viewportSize);
      reportHumanViewportPreference("viewport");
    },
    [reportHumanViewportPreference, updateControlledViewport],
  );

  const updateResponsiveViewportZoom = useCallback(
    (zoom: BrowserViewportZoom) => {
      responsiveViewportZoomRef.current = zoom;
      setResponsiveViewportZoom(zoom);
      reportHumanViewportPreference("zoom");
    },
    [reportHumanViewportPreference],
  );

  const synchronizeInitialHumanViewport = useCallback(() => {
    if (
      !initialHumanViewportPreference ||
      initialHumanViewportPreference.mode !== "responsive" ||
      didSynchronizeInitialHumanViewportRef.current
    ) {
      return;
    }
    didSynchronizeInitialHumanViewportRef.current = true;
    updateControlledViewport(responsiveViewportSizeRef.current);
  }, [initialHumanViewportPreference, updateControlledViewport]);

  return {
    isResponsiveMode,
    responsiveViewportSize,
    responsiveViewportZoom,
    setResponsiveViewportZoom: updateResponsiveViewportZoom,
    synchronizeInitialHumanViewport,
    toggleResponsiveMode,
    updateResponsiveViewportSize,
  };
}
