import { useEffect, useRef, useState } from "react";
import type { DesktopWindowChromeState, IPlatformService, UpdateStatePayload } from "@zcode/shared";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const MACOS_WINDOW_CONTROLS_DEFAULT_LEFT_PADDING_PX = 96;
const WINDOWS_WINDOW_CONTROLS_DEFAULT_RIGHT_PADDING_PX = 136;

function readFinitePositivePx(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

function resolveInitialWindowControlsPaddingPx({
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  platform,
}: {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  platform: IPlatformService;
}) {
  const metrics = platform.getWindowControlsOverlayMetrics?.();
  const leftPaddingPx =
    isDesktop && isMacDesktop
      ? (readFinitePositivePx(metrics?.leftPaddingPx) ??
        MACOS_WINDOW_CONTROLS_DEFAULT_LEFT_PADDING_PX)
      : MACOS_WINDOW_CONTROLS_DEFAULT_LEFT_PADDING_PX;
  const rightPaddingPx =
    isDesktop && isWindowsDesktop
      ? (readFinitePositivePx(metrics?.rightPaddingPx) ??
        WINDOWS_WINDOW_CONTROLS_DEFAULT_RIGHT_PADDING_PX)
      : WINDOWS_WINDOW_CONTROLS_DEFAULT_RIGHT_PADDING_PX;

  return { leftPaddingPx, rightPaddingPx };
}

function resolveLegacyReadyVersionFromState(payload: UpdateStatePayload) {
  // 旧的 UpdateReady 事件只会告诉 renderer “某版本 ready”，不会告诉它后续
  // 进入 staging error 等不可安装状态。新状态流一旦不是 update-downloaded，就必须清掉旧 ready。
  return payload.kind === "update-downloaded" ? payload.version : null;
}

export function useAppChromeState({
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  platform,
  workspaceAbsPath,
}: {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  platform: IPlatformService;
  workspaceAbsPath: string;
}) {
  const initialWindowControlsPadding = resolveInitialWindowControlsPaddingPx({
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
    platform,
  });
  const [isMacFullscreen, setIsMacFullscreen] = useState(false);
  const [desktopWindowChromeState, setDesktopWindowChromeState] =
    useState<DesktopWindowChromeState | null>(null);
  const [macWindowControlsLeftPaddingPx, setMacWindowControlsLeftPaddingPx] = useState(
    () => initialWindowControlsPadding.leftPaddingPx,
  );
  const [windowsWindowControlsRightPaddingPx, setWindowsWindowControlsRightPaddingPx] = useState(
    () => initialWindowControlsPadding.rightPaddingPx,
  );
  const [updateReadyVersion, setUpdateReadyVersion] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<UpdateStatePayload | null>(null);
  const sidebarContainerRef = useRef<HTMLElement | null>(null);
  const hasShownUpdateToastRef = useRef(false);
  const updateStateEventRevisionRef = useRef(0);
  const { intl } = useZCodeIntl();

  useEffect(() => {
    if (!isDesktop || !isMacDesktop) {
      setIsMacFullscreen(false);
      setMacWindowControlsLeftPaddingPx(MACOS_WINDOW_CONTROLS_DEFAULT_LEFT_PADDING_PX);
      return;
    }

    // macOS 全屏后红绿灯会重新贴近左上角布局。
    // 顶部浮层继续沿用窗口态的 pl-24 会把左侧安全区撑得过大，视觉上像是三键"消失"。
    // 这里订阅桌面窗口全屏状态，只在 macOS 全屏时收窄留白，不影响普通窗口态。
    return platform.onWindowFullscreenChanged((fullscreen) => {
      setIsMacFullscreen(fullscreen);
    });
  }, [isDesktop, isMacDesktop, platform]);

  useEffect(() => {
    // 排除 macOS 会让版本始终未知，Tahoe 也错误采用 Sequoia 的 6px 圆角。
    // 所有桌面平台共用窗口状态查询，保留事件优先和卸载清理；Web 不读取原生状态。
    if (!isDesktop || !platform.getDesktopWindowChromeState) {
      setDesktopWindowChromeState(null);
      return;
    }

    let disposed = false;
    let eventRevision = 0;
    const dispose = platform.onDesktopWindowChromeStateChanged?.((state) => {
      eventRevision += 1;
      setDesktopWindowChromeState(state);
    });
    const requestRevision = eventRevision;

    // 只监听 maximize/unmaximize 会漏掉“应用启动时窗口已最大化”的初始状态。
    // 先订阅再主动查询，并用 revision 防止较慢的查询结果覆盖更新的窗口事件。
    void platform.getDesktopWindowChromeState().then(
      (state) => {
        if (!disposed && eventRevision === requestRevision) setDesktopWindowChromeState(state);
      },
      (error) => logger.warn("[app-chrome] 同步桌面窗口外观状态失败", { error }),
    );

    return () => {
      disposed = true;
      dispose?.();
    };
  }, [isDesktop, platform]);

  useEffect(() => {
    const isLinuxDesktop = isDesktop && !isMacDesktop && !isWindowsDesktop;
    const rootElement = document.documentElement;
    if (!rootElement) return;
    // Linux 外壳由 renderer 裁切，若最大化后仍保留圆角，屏幕四角会露出透明缺口。
    // 复用 main 进程的窗口状态作为唯一来源，让 Workspace 与设置页同时切换。
    rootElement.classList.toggle(
      "window-maximized",
      isLinuxDesktop && (desktopWindowChromeState?.isMaximized ?? false),
    );
    return () => rootElement.classList.remove("window-maximized");
  }, [desktopWindowChromeState?.isMaximized, isDesktop, isMacDesktop, isWindowsDesktop]);

  useEffect(() => {
    if (
      !isDesktop ||
      (!isMacDesktop && !isWindowsDesktop) ||
      !platform.onWindowControlsOverlayChanged
    ) {
      setMacWindowControlsLeftPaddingPx(MACOS_WINDOW_CONTROLS_DEFAULT_LEFT_PADDING_PX);
      setWindowsWindowControlsRightPaddingPx(WINDOWS_WINDOW_CONTROLS_DEFAULT_RIGHT_PADDING_PX);
      return;
    }

    // 页面缩放后，原生窗口控制区不会随 renderer zoom 一起缩放。
    // macOS 同步左侧红绿灯安全区，Windows 同步右侧标题栏按钮安全区。
    return platform.onWindowControlsOverlayChanged((metrics) => {
      const leftPaddingPx = readFinitePositivePx(metrics.leftPaddingPx);
      const rightPaddingPx = readFinitePositivePx(metrics.rightPaddingPx);
      logger.debug("[app-chrome] 收到原生窗口控制区几何变化", {
        isMacDesktop,
        isWindowsDesktop,
        leftPaddingPx,
        rightPaddingPx,
      });
      if (isMacDesktop && leftPaddingPx !== null) {
        setMacWindowControlsLeftPaddingPx(leftPaddingPx);
      }
      if (isWindowsDesktop && rightPaddingPx !== null) {
        setWindowsWindowControlsRightPaddingPx(rightPaddingPx);
      }
    });
  }, [isDesktop, isMacDesktop, isWindowsDesktop, platform]);

  useEffect(() => {
    if (!platform.onUpdateReady) {
      return;
    }

    // 更新就绪状态之前散落在按钮组件内部，各处只能各自重复订阅平台事件。
    // 这样 WorkspaceHeader 无法知道"当前是否有更新"，也容易让多个入口各自维护一份分叉状态。
    // 这里把 version 提升到 App 统一管理，再按需往 Header / Overlay 分发。
    return platform.onUpdateReady((version) => {
      logger.info("[App] 收到可安装更新", {
        workspaceAbsPath,
        version,
      });
      setUpdateReadyVersion(version);

      // Windows 桌面端收到更新时显示轻提示，不阻塞主界面
      if (isWindowsDesktop && !hasShownUpdateToastRef.current) {
        hasShownUpdateToastRef.current = true;
        toast(intl.formatMessage({ id: "update.toast.ready" }, { version }), {
          durationMs: 4000,
          position: "bottom-left",
          variant: "update",
        });
      }
    });
  }, [platform, workspaceAbsPath, isWindowsDesktop, intl]);

  useEffect(() => {
    let cancelled = false;

    if (platform.getUpdateState) {
      const requestRevision = updateStateEventRevisionRef.current;
      void platform.getUpdateState().then(
        (payload) => {
          if (!cancelled && updateStateEventRevisionRef.current === requestRevision) {
            setUpdateState(payload);
            setUpdateReadyVersion(resolveLegacyReadyVersionFromState(payload));
          }
        },
        (error) => {
          logger.warn("[App] 同步自动更新状态失败", { error });
        },
      );
    }

    if (!platform.onUpdateStateChanged) {
      return () => {
        cancelled = true;
      };
    }

    const dispose = platform.onUpdateStateChanged((payload) => {
      updateStateEventRevisionRef.current += 1;
      setUpdateState(payload);
      setUpdateReadyVersion(resolveLegacyReadyVersionFromState(payload));
    });
    return () => {
      cancelled = true;
      dispose();
    };
  }, [platform]);

  return {
    isMacFullscreen,
    desktopWindowChromeState,
    macWindowControlsLeftPaddingPx,
    windowsWindowControlsRightPaddingPx,
    updateReadyVersion,
    updateState,
    sidebarContainerRef,
  };
}
