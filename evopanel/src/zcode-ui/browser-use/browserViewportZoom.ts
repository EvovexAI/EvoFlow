import {
  BROWSER_VIEWPORT_ZOOM_OPTIONS,
  DEFAULT_BROWSER_VIEWPORT_ZOOM,
  type BrowserViewportSize,
  type BrowserViewportZoom,
} from "@zcode/shared";

export { BROWSER_VIEWPORT_ZOOM_OPTIONS, DEFAULT_BROWSER_VIEWPORT_ZOOM };
export type { BrowserViewportZoom };

/** Fit 的画布内边距与 ResponsiveBrowserViewport 的 `p-4` 保持一致。 */
const RESPONSIVE_BROWSER_CANVAS_PADDING_PX = 16;

export function resolveBrowserViewportScale({
  canvasSize,
  desktopZoomFactor = 1,
  viewportSize,
  zoom,
}: {
  canvasSize: BrowserViewportSize | null;
  desktopZoomFactor?: number;
  viewportSize: BrowserViewportSize;
  zoom: BrowserViewportZoom;
}): number {
  if (zoom !== "fit") {
    return Number(zoom) / 100;
  }
  if (!canvasSize || canvasSize.width <= 0 || canvasSize.height <= 0) {
    return 1;
  }

  const safeDesktopZoomFactor =
    Number.isFinite(desktopZoomFactor) && desktopZoomFactor > 0 ? desktopZoomFactor : 1;
  // ResizeObserver 返回父 renderer 页面缩放后的 CSS 尺寸；换算为屏幕视觉尺寸后再解析 Fit，
  // 才不会让应用全局缩放被误当成浏览器预览缩放。
  const availableWidth =
    Math.max(0, canvasSize.width - RESPONSIVE_BROWSER_CANVAS_PADDING_PX * 2) *
    safeDesktopZoomFactor;
  const availableHeight =
    Math.max(0, canvasSize.height - RESPONSIVE_BROWSER_CANVAS_PADDING_PX * 2) *
    safeDesktopZoomFactor;
  if (availableWidth === 0 || availableHeight === 0) {
    return 1;
  }

  return Math.min(1, availableWidth / viewportSize.width, availableHeight / viewportSize.height);
}

export function resolveBrowserViewportRendererScale({
  desktopZoomFactor,
  visualScale,
}: {
  desktopZoomFactor: number;
  visualScale: number;
}): number {
  const safeDesktopZoomFactor =
    Number.isFinite(desktopZoomFactor) && desktopZoomFactor > 0 ? desktopZoomFactor : 1;
  return visualScale / safeDesktopZoomFactor;
}

export function resolveResponsiveBrowserGuestLayout(desktopZoomFactor: number): {
  layoutScale: number;
  transformScale: number;
} {
  const safeDesktopZoomFactor =
    Number.isFinite(desktopZoomFactor) && desktopZoomFactor > 0 ? desktopZoomFactor : 1;

  if (safeDesktopZoomFactor > 1) {
    // Desktop page zoom 放大时，外层 transform 只会扩大 webview DOM，
    // guest native raster 仍只有 frame 的 1 / zoom，因而产生右/下留白。
    // 放大补偿已下沉到 main 的 CDP metrics scale，renderer 必须保持真实 100% bounds。
    return { layoutScale: 1, transformScale: 1 };
  }

  if (safeDesktopZoomFactor < 1) {
    // 缩小档位若只缩放 surface 也会留白；先反向扩布局，再缩回 frame，
    // 同时保留完整页面内容和正确的 guest 坐标映射。
    return {
      layoutScale: 1 / safeDesktopZoomFactor,
      transformScale: safeDesktopZoomFactor,
    };
  }

  return { layoutScale: 1, transformScale: 1 };
}
