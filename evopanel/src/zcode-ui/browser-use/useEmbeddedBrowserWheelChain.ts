import { useEffect, type RefObject } from "react";
import {
  EmbeddedBrowserWebviewChannels,
  type EmbeddedBrowserWheelBoundaryPayload,
} from "@zcode/shared";
import { logger } from "@/logger.js";

function validatedDelta(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 把 guest 已到边界的二维 wheel 续接到自由尺寸宿主画布。 */
export function useEmbeddedBrowserWheelChain({
  browserRegionRef,
  isResponsiveMode,
  webview,
}: {
  browserRegionRef: RefObject<HTMLDivElement | null>;
  isResponsiveMode: boolean;
  webview: ElectronWebviewTag | null;
}): void {
  useEffect(() => {
    if (!webview) return;

    const handleGuestIpcMessage = (event: ElectronWebviewIpcMessageEvent): void => {
      if (!isResponsiveMode || event.channel !== EmbeddedBrowserWebviewChannels.WheelBoundary) {
        return;
      }
      const payload = event.args[0] as Partial<EmbeddedBrowserWheelBoundaryPayload> | undefined;
      // IPC payload 可能缺字段或携带非有限数，不能直接传给宿主滚动画布。
      const deltaX = validatedDelta(payload?.deltaX);
      const deltaY = validatedDelta(payload?.deltaY);
      if (deltaX === 0 && deltaY === 0) return;

      const responsiveCanvas = browserRegionRef.current?.querySelector<HTMLElement>(
        '[data-responsive-browser-mode="active"]',
      );
      if (!responsiveCanvas) return;
      // Electron `<webview>` guest 的 wheel 不会冒泡到宿主 DOM；固定 preload
      // 仅在网页无法继续消费对应轴时发消息，在这里续接外层自由尺寸画布的滚动链。
      responsiveCanvas.scrollBy({ behavior: "auto", left: deltaX, top: deltaY });
      // wheel 与消息流同量级，只用 debug，生产构建不会落盘。
      logger.debug("[browser-use] guest wheel 续接自由尺寸画布", {
        deltaX,
        deltaY,
        scrollLeft: responsiveCanvas.scrollLeft,
        scrollTop: responsiveCanvas.scrollTop,
      });
    };

    webview.addEventListener("ipc-message", handleGuestIpcMessage);
    return () => webview.removeEventListener("ipc-message", handleGuestIpcMessage);
  }, [browserRegionRef, isResponsiveMode, webview]);
}
