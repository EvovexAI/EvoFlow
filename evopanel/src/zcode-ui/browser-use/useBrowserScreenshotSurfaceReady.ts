import { useEffect } from "react";
import {
  BROWSER_SCREENSHOT_SURFACE_PREPARE_TIMEOUT_MS,
  type BrowserViewportSize,
  type BrowserViewScreenshotSurfacePreparePayload,
} from "@zcode/shared";
import { safeWebviewCall } from "@/embeddedBrowserHelpers.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";

function roundViewport(width: number, height: number): BrowserViewportSize | null {
  const viewport = { width: Math.round(width), height: Math.round(height) };
  return viewport.width > 0 && viewport.height > 0 ? viewport : null;
}

function withinOnePixel(left: BrowserViewportSize, right: BrowserViewportSize): boolean {
  return Math.abs(left.width - right.width) <= 1 && Math.abs(left.height - right.height) <= 1;
}

const SURFACE_SCALE_EPSILON = 0.001;

// ready 过去只在
// requestAnimationFrame 回调里上报，而 ZCode 主窗口被遮挡/最小化时 Chromium 会冻结
// renderer 的 rAF，ready 永远发不出去，主进程握手只能固定在 1500ms 超时。用户日志里
// 失败全是 1501/1502ms、成功全是 146~736ms，且 app-activate 之后 461ms 立刻成功，
// 可以印证是"窗口不在前台 → rAF 不调度"而不是截图本身慢。
//
//   前台：prepare ──► rAF(帧1) ──► rAF(帧2) ──► ready ──► capture      ✅ ~150ms
//   后台：prepare ──► rAF 冻结 ───────────────► (无 ready) ──► 1500ms timeout ❌
//
// 因此 timer 必须和 rAF 竞速调度同一次检查：窗口被遮挡时 timer 是唯一还在走的时钟。
const SURFACE_VERIFY_FALLBACK_MS = 100;
// viewport 尚未对齐时过去直接 return，而重启点只有 ResizeObserver 和 dom-ready；
// setViewportSize / reload 之后尺寸如果恰好不再变化，就再也没有第二次验证机会，同样白等 1500ms。
// 改为受控重试；main 把当前实际 timeout 放进 prepare payload，renderer 额外保留一段
// Release 消息清理宽限。正常由 main 先释放，宽限只防止 Release 丢失后循环永久存活。
const SURFACE_VERIFY_RELEASE_GRACE_MS = 1_000;

function resolveSurfacePrepareTimeoutMs(timeoutMs: number | undefined): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : BROWSER_SCREENSHOT_SURFACE_PREPARE_TIMEOUT_MS;
}

interface StableScreenshotSurface {
  surfaceScale: number;
  viewport: BrowserViewportSize;
}

function readBrowserLayoutScale(webview: ElectronWebviewTag): number {
  const layoutScale = Number(webview.dataset.browserLayoutScale);
  return Number.isFinite(layoutScale) && layoutScale > 0 ? layoutScale : 1;
}

function readSurfaceScale(webview: ElectronWebviewTag): number {
  const responsiveViewport = webview.closest<HTMLElement>("[data-responsive-scale]");
  const surfaceScale = Number(responsiveViewport?.dataset.responsiveScale);
  return Number.isFinite(surfaceScale) && surfaceScale > 0 ? surfaceScale : 1;
}

function sameSurface(left: StableScreenshotSurface, right: StableScreenshotSurface): boolean {
  return (
    withinOnePixel(left.viewport, right.viewport) &&
    Math.abs(left.surfaceScale - right.surfaceScale) <= SURFACE_SCALE_EPSILON
  );
}

function readSurfaceViewport(
  webview: ElectronWebviewTag,
  expected: BrowserViewportSize,
): BrowserViewportSize | null {
  const rect = webview.getBoundingClientRect();
  const transformed = roundViewport(rect.width, rect.height);
  const layoutScale = readBrowserLayoutScale(webview);
  // Desktop 负缩放会先按 1 / zoom 扩张 webview 布局，再缩回可见 frame；
  // raw offset 是宿主补偿尺寸，必须按同一 layout scale 还原后才能代表逻辑截图 viewport。
  const layout = roundViewport(
    webview.offsetWidth / layoutScale,
    webview.offsetHeight / layoutScale,
  );
  if (transformed && withinOnePixel(transformed, expected)) return transformed;
  if (layout && withinOnePixel(layout, expected)) return layout;
  return transformed ?? layout;
}

/** 在后台合成层中等候两个稳定帧，确认 guest id 与自然 viewport 同时仍然有效。 */
export function useBrowserScreenshotSurfaceReady({
  request,
  webview,
}: {
  request: BrowserViewScreenshotSurfacePreparePayload | null;
  webview: ElectronWebviewTag | null;
}): void {
  const platform = usePlatform();

  useEffect(() => {
    logger.debug("[browser-use] 截图 surface ready effect", {
      requestId: request?.requestId,
      tabId: request?.tabId,
      hasWebview: Boolean(webview),
      hasResizeObserver: typeof ResizeObserver !== "undefined",
    });
    if (!request || !webview || typeof ResizeObserver === "undefined") {
      logger.debug("[browser-use] 截图 surface ready 暂不启动", {
        requestId: request?.requestId,
        tabId: request?.tabId,
        hasWebview: Boolean(webview),
        hasResizeObserver: typeof ResizeObserver !== "undefined",
      });
      return;
    }

    // TypeScript 不会把 early return 的非空收窄带进下面的 hoisted function declaration
    // （它们理论上可能在守卫前被调用），这里固定一份已收窄的引用给整个验证链使用。
    const activeRequest = request;
    const activeWebview = webview;

    let disposed = false;
    let reported = false;
    let firstFrame: StableScreenshotSurface | null = null;
    let rafId: number | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let mismatchLogged = false;
    let verificationVersion = 0;
    const prepareTimeoutMs = resolveSurfacePrepareTimeoutMs(activeRequest.timeoutMs);
    const verifyDeadlineMs = prepareTimeoutMs + SURFACE_VERIFY_RELEASE_GRACE_MS;
    const deadline = Date.now() + verifyDeadlineMs;
    const cancelPendingVerification = () => {
      verificationVersion += 1;
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (fallbackTimer !== null) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
    };
    // rAF 与 timer 竞速：谁先到谁执行这一次检查，另一路立即取消，语义上仍然是"一次验证"。
    function verify(): void {
      if (disposed || reported) return;
      cancelPendingVerification();
      const version = verificationVersion;
      const run = () => {
        if (disposed || reported || version !== verificationVersion) return;
        cancelPendingVerification();
        runVerification();
      };
      rafId = window.requestAnimationFrame(run);
      fallbackTimer = setTimeout(run, SURFACE_VERIFY_FALLBACK_MS);
    }
    function retry(): void {
      if (Date.now() >= deadline) {
        logger.warn("[browser-use] 截图 surface 等待超时，停止重试", {
          requestId: activeRequest.requestId,
          tabId: activeRequest.tabId,
          expectedViewport: activeRequest.viewport,
          prepareTimeoutMs,
          verifyDeadlineMs,
        });
        return;
      }
      verify();
    }
    function runVerification(): void {
      const guestId = safeWebviewCall(() => activeWebview.getWebContentsId(), 0);
      if (guestId !== activeRequest.webContentsId) {
        logger.debug("[browser-use] 截图 surface 等待当前 guest", {
          requestId: activeRequest.requestId,
          expectedGuestId: activeRequest.webContentsId,
          guestId,
        });
        retry();
        return;
      }
      const viewport = readSurfaceViewport(activeWebview, activeRequest.viewport);
      if (!viewport || !withinOnePixel(viewport, activeRequest.viewport)) {
        if (!mismatchLogged) {
          mismatchLogged = true;
          logger.debug("[browser-use] 截图 surface viewport 尚未对齐", {
            requestId: activeRequest.requestId,
            expectedViewport: activeRequest.viewport,
            viewport,
          });
        }
        retry();
        return;
      }
      const current = { surfaceScale: readSurfaceScale(activeWebview), viewport };
      if (!firstFrame || !sameSurface(firstFrame, current)) {
        firstFrame = current;
        retry();
        return;
      }
      if (disposed) return;
      logger.debug("[browser-use] 截图 surface 已稳定", {
        requestId: activeRequest.requestId,
        tabId: activeRequest.tabId,
        surfaceScale: current.surfaceScale,
        viewport: current.viewport,
      });
      reported = true;
      platform.browserViewScreenshotSurfaceReady?.({
        ...activeRequest,
        surfaceScale: current.surfaceScale,
        viewport: current.viewport,
      });
    }
    function restartVerification(): void {
      if (disposed || reported) return;
      firstFrame = null;
      mismatchLogged = false;
      cancelPendingVerification();
      verify();
    }
    const observer = new ResizeObserver(() => {
      restartVerification();
    });
    // guest 首次 attach 时 getWebContentsId() 可能暂时返回 0；若布局尺寸没有变化，
    // ResizeObserver 不会再次触发。dom-ready 是 guest identity 可读后的同一视图边界，
    // 因此在这里重置稳定帧重新开始验证。
    const handleDomReady = () => {
      restartVerification();
    };
    // 窗口从后台回到前台时 Chromium 才恢复 rAF 与合成，此时 surface 可能刚重建，
    // 之前采到的稳定帧不能再信任；这里清空重来，让恢复可见的瞬间就能重新走完两帧验证。
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      restartVerification();
    };
    observer.observe(activeWebview);
    activeWebview.addEventListener("dom-ready", handleDomReady);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    verify();
    return () => {
      disposed = true;
      observer.disconnect();
      activeWebview.removeEventListener("dom-ready", handleDomReady);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      cancelPendingVerification();
    };
  }, [platform, request, webview]);
}
