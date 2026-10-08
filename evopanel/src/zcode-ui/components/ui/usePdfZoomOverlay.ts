import type { CSSProperties } from "react";
import { useCallback, useEffect, useRef } from "react";

export const ZOOM_STEP = 0.25;
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;
export const DEFAULT_SCALE = 1;
// 修饰键 + 滚轮的连续缩放灵敏度：兼容触控板高频小 delta 和鼠标滚轮大 delta。
export const WHEEL_ZOOM_SENSITIVITY = 0.002;
// 手势停顿后才提交真实渲染，连续手势期间只做 CSS 预览。
export const ZOOM_COMMIT_DELAY_MS = 200;

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export interface PdfZoomPointer {
  clientX: number;
  clientY: number;
}

export interface PdfPageSize {
  width: number;
  height: number;
}

export interface PdfZoomAnchor extends PdfZoomPointer {
  pageXRatio: number;
  pageYRatio: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function resolvePdfPageSize(
  current: PdfPageSize | null,
  width: number,
  height: number,
): PdfPageSize {
  return current?.width === width && current.height === height ? current : { width, height };
}

export function getPdfPageDisplaySize(
  intrinsicSize: PdfPageSize | null,
  displayScale: number,
): CSSProperties | undefined {
  return intrinsicSize
    ? {
        width: Math.floor(intrinsicSize.width * displayScale),
        height: Math.floor(intrinsicSize.height * displayScale),
      }
    : undefined;
}

export function getPdfPagePreviewStyle(
  hasStableLayoutBox: boolean,
  previewScale: number,
): CSSProperties | undefined {
  if (!hasStableLayoutBox && previewScale === 1) {
    return undefined;
  }
  return {
    // 已知页面尺寸后脱离普通文档流，只让目标布局盒决定滚动范围，避免旧画布尺寸干扰缩放。
    position: hasStableLayoutBox ? "absolute" : undefined,
    inset: hasStableLayoutBox ? 0 : undefined,
    transform: previewScale === 1 ? undefined : `scale(${previewScale})`,
    transformOrigin: "top left",
  };
}

export function capturePdfZoomAnchor(
  container: HTMLDivElement,
  pageViewport: HTMLDivElement,
  pointer?: PdfZoomPointer,
): PdfZoomAnchor | null {
  const containerRect = container.getBoundingClientRect();
  const pageRect = pageViewport.getBoundingClientRect();
  if (pageRect.width === 0 || pageRect.height === 0) {
    return null;
  }

  const requestedClientX = pointer?.clientX ?? containerRect.left + containerRect.width / 2;
  const requestedClientY = pointer?.clientY ?? containerRect.top + containerRect.height / 2;
  const visibleClientX = clamp(requestedClientX, containerRect.left, containerRect.right);
  const visibleClientY = clamp(requestedClientY, containerRect.top, containerRect.bottom);
  const pageXRatio = clamp((visibleClientX - pageRect.left) / pageRect.width, 0, 1);
  const pageYRatio = clamp((visibleClientY - pageRect.top) / pageRect.height, 0, 1);

  return {
    clientX: pageRect.left + pageRect.width * pageXRatio,
    clientY: pageRect.top + pageRect.height * pageYRatio,
    pageXRatio,
    pageYRatio,
  };
}

export function restorePdfZoomAnchor(
  container: HTMLDivElement,
  pageViewport: HTMLDivElement,
  anchor: PdfZoomAnchor,
): void {
  const pageRect = pageViewport.getBoundingClientRect();
  container.scrollLeft += pageRect.left + pageRect.width * anchor.pageXRatio - anchor.clientX;
  container.scrollTop += pageRect.top + pageRect.height * anchor.pageYRatio - anchor.clientY;
}

export function usePdfZoomOverlay() {
  const pageViewportRef = useRef<HTMLDivElement | null>(null);
  const zoomOverlayRef = useRef<HTMLCanvasElement | null>(null);

  const clearZoomOverlay = useCallback(() => {
    zoomOverlayRef.current?.remove();
    zoomOverlayRef.current = null;
  }, []);

  const stageZoomOverlay = useCallback((targetWidth: number, targetHeight: number) => {
    const viewport = pageViewportRef.current;
    if (!viewport) {
      return;
    }

    let overlay = zoomOverlayRef.current;
    if (!overlay) {
      const sourceCanvas = viewport.querySelector<HTMLCanvasElement>(".react-pdf__Page__canvas");
      if (!sourceCanvas || sourceCanvas.style.visibility === "hidden") {
        return;
      }

      const width = sourceCanvas.offsetWidth;
      const height = sourceCanvas.offsetHeight;
      if (width === 0 || height === 0 || sourceCanvas.width === 0 || sourceCanvas.height === 0) {
        return;
      }

      overlay = document.createElement("canvas");
      overlay.width = sourceCanvas.width;
      overlay.height = sourceCanvas.height;
      overlay.style.position = "absolute";
      overlay.style.inset = "0";
      overlay.style.zIndex = "1";
      overlay.style.display = "block";
      overlay.style.pointerEvents = "none";
      overlay.style.userSelect = "none";
      overlay.setAttribute("aria-hidden", "true");
      const overlayContext = overlay.getContext("2d");
      if (!overlayContext) {
        return;
      }
      overlayContext.drawImage(sourceCanvas, 0, 0);
      viewport.appendChild(overlay);

      zoomOverlayRef.current = overlay;
    }

    overlay.style.width = `${targetWidth}px`;
    overlay.style.height = `${targetHeight}px`;
  }, []);

  useEffect(() => {
    return () => {
      zoomOverlayRef.current?.remove();
    };
  }, []);

  return {
    clearZoomOverlay,
    pageViewportRef,
    stageZoomOverlay,
  };
}
