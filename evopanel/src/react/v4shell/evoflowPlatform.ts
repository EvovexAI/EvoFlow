/**
 * EvoFlow v4 shell — ``IPlatformService`` 完整 stub 实现 + Proxy 兜底。
 *
 * ZCode 桌面的 IPlatformService 有 ~100+ 方法（桌面原生对话框、OAuth deep link、
 * 浏览器 panel、CU permission、SSH、Docker、WSL、telemetry…）。EvoFlow 网页/Tauri
 * 桥接留给 H3-C+ —— 现阶段逐个实现不现实。
 *
 * 策略：
 *   1. 显式实现 zcode 桌面**关键调用会触发**的方法（selectDirectory / selectFile /
 *      onCloseActiveContextRequest / onNewTask / openInFileManager 等）—— 这些
 *      即便 stub 也要返回正确形状（Promise<string|null> / () => () => {}），
 *      否则 zcode 内部 hook 链会因"undefined 不是 function"整树崩。
 *   2. 其余方法通过 Proxy 兜底：未识别的方法名返回 Promise.resolve(undefined)（普通
 *      异步方法）或 () => {}（同步方法）或 null（getter）—— zcode 内部拿空值就当
 *      "不支持"，不抛错、不炸渲染。
 *
 * 用户对 EvoFlow 的要求："后端不够的可以加，不对的可以改，我就是想要他的 UI"
 * —— Proxy 兜底保证 UI 永远渲染，后端真接得上时再把对应方法改成真实实现即可。
 */

import { Event } from "@zcode/rpc";
import type { IPlatformService } from "@zcode/shared";

const noop = () => {};
const noopAsync = async () => undefined;
const noopDisposer = () => () => {};
const noopPromiseNull = async () => null as string | null;
const noopPromiseFalse = async () => ({ success: false, error: "evoflow-platform-stub" });
const noopPromiseZero = async () => 0;

/**
 * 平台方法调用的兜底：返回与 zcode 期望形状兼容的"不支持"值。
 *
 * 不同 zcode 调用方对 platform.xxx 的返回类型期望不同（Promise<T> / () => disposer
 * / sync<T>），简单 return undefined 不够。这里通过方法的**最后位置**猜返回类型：
 *   - onXxx / listen / subscribe / register → () => () => {}（disposer）
 *   - getXxx / isXxx / canXxx / hasXxx → Promise.resolve(undefined)
 *   - 其余 → Promise.resolve(undefined)
 *   - 同步方法（openExternal / syncXxx）→ noop()
 */
function makePlatformProxy(
  overrides: Partial<IPlatformService>,
): IPlatformService {
  const handler: ProxyHandler<any> = {
    get(_target, prop: string) {
      // 1. 显式 override 优先（包含 zcode 必需的方法）
      if (prop in overrides) {
        return (overrides as any)[prop];
      }
      // 2. 未知方法 —— 按命名规则返回形状正确的 stub
      if (prop.startsWith("on") || prop.startsWith("register") || prop.startsWith("listen") || prop.startsWith("subscribe")) {
        return noopDisposer;
      }
      if (prop.startsWith("sync") || prop === "notifyRendererReady" || prop === "showTaskNotification") {
        return noop;
      }
      if (prop === "openExternal") {
        return noop;
      }
      if (prop === "isLocalDevelopmentRuntime") {
        return false;
      }
      // 3. 其它：返回 Promise.resolve(undefined) —— zcode 拿空值走不支持分支
      return noopAsync;
    },
  };
  return new Proxy(overrides as any, handler) as IPlatformService;
}

/**
 * 显式实现 zcode 桌面**关键**方法。
 *
 * 这里列的方法是 zcode 桌面主对话 UI 真的**在 render 路径或挂载钩子路径**调用的；
 * 漏了会触发 `xxx is not a function` 把 EvoFlowApp 整树干掉。
 *
 * 后续 H3-C+ 接 Tauri 桥时，把这些方法替换成真实桥即可，无需改 EvoFlowApp 主体。
 */
const baseImplementations: Partial<IPlatformService> = {
  // ── 文件对话框（EvoFlow 走 Tauri dialog 桥接留给 TBD） ──
  canSelectFilePath: false,
  selectDirectory: noopPromiseNull,
  selectFile: noopPromiseNull,
  selectFiles: async () => [],
  saveFile: async () => ({ success: false, error: "evoflow-stub" }) as any,
  printPageToPdf: async () => ({ success: false }) as any,
  getPathForFile: () => null,
  createLocalMediaPreviewUrl: () => "",
  createTempTextAttachment: async () => ({ success: false }) as any,

  // ── 远程连接日志 / session 关闭 —— web 端无 native 桥，返回 no-op 订阅 ──
  onRemoteConnectionLog: noopDisposer,
  onRemoteSessionClosed: noopDisposer,
  onBotRemoteWorkspaceReconnected: noopDisposer,

  // ── 远程工作区（EvoFlow 暂不接） ──
  activateOrSetWorkspace: async () => ({ activated: false }),
  connectRemote: async () => ({ success: false, error: "evoflow-stub" }),
  cancelPendingRemoteConnection: noopAsync,
  bindRemoteWorkspaceSessionContext: noopAsync,
  disposeRemoteSession: noopAsync,
  isDockerAvailable: noopPromiseFalse as any,
  listWSLDistros: async () => [],
  listDockerContainers: async () => [],
  listSSHConfigAliases: async () => [],
  loadMcpFromUserDirectory: async () => ({ configs: [] }) as any,
  saveMcpToUserDirectory: async () => ({ success: false }),
  migrateLegacyCommonMcp: async () => ({ migrated: false }) as any,

  // ── 应用/反馈/社群 ──
  openExternal: noop,
  getApplicationIcon: async () => null,
  openFeedback: noopAsync,
  onOpenFeedbackDialog: noopDisposer,
  onOpenTicketsPanel: noopDisposer,
  openCommunity: noopAsync,
  canOpenCommunity: async () => false,
  openInFileManager: noopPromiseFalse,
  openExternalFile: noopPromiseFalse,
  openCuaPermissionOnboarding: async () => ({ authorized: false }) as any,
  cancelCuaPermissionOnboarding: noop,
  prepareCuaHelperPermissionDrag: async () => ({ ok: false }) as any,
  startCuaHelperPermissionDrag: noop,

  // ── OAuth / 支付 deep link ──
  registerOAuthState: noop,
  onOAuthCallback: noopDisposer,
  onPaymentCallback: noopDisposer,
  onShareImport: noopDisposer,

  // ── 生命周期 / 通知 / 遥测 ──
  notifyRendererReady: noop,
  showTaskNotification: noop,
  reportTelemetryEvent: noopAsync,
  reportArmsCustomEvent: noopAsync,
  getRendererActionTraceConfig: async () => ({ enabled: false, sampleRate: 0, armsKey: "" }) as any,
  onRendererActionTraceConfigChanged: noopDisposer,
  reportRendererActionTraceBatch: noop,
  reportLocalTtftBatch: noop,
  reportRendererHeapSample: noop,
  syncWindowTabs: noop,
  syncWindowUnreadCount: noop,
  syncActiveTaskSession: noop,
  syncAppSettings: noop,
  setShortcutRecordingActive: noop,
  onFocusTab: noopDisposer,
  onNewTab: noopDisposer,
  onCloseActiveContextRequest: noopDisposer,
  onOpenBrowserUrl: noopDisposer,
  onBrowserViewReady: noopDisposer,
  onBrowserViewOperation: noopDisposer,
  onBrowserViewVisibility: noopDisposer,
  onBrowserViewViewportChanged: noopDisposer,
  onBrowserViewScreenshotSurfacePrepare: noopDisposer,
  onBrowserViewScreenshotSurfaceRelease: noopDisposer,
  browserViewScreenshotSurfaceReady: noop,
  onBrowserViewCloseTab: noopDisposer,
  onBrowserViewSuspend: noopDisposer,
  onBrowserViewRestore: noopDisposer,
  onNewTask: noopDisposer,
  onOpenWorkspace: noopDisposer,
  onOpenWorkspacePath: noopDisposer,
  onWindowFullscreenChanged: noopDisposer,
  getDesktopWindowChromeState: async () => ({ isFullscreen: false, isMaximized: false }) as any,
  onDesktopWindowChromeStateChanged: noopDisposer,
  getWindowControlsOverlayMetrics: () => null,
  onWindowControlsOverlayChanged: noopDisposer,
  getDesktopZoomLevel: async () => ({ level: 0, percent: 100 }) as any,
  onDesktopZoomLevelChanged: noopDisposer,
  onTaskNotificationClick: noopDisposer,
  exportLogs: async () => ({ success: false, error: "evoflow-stub" }),
  captureWindowScreenshot: async () => null,
  browserViewAttachGuest: async () => ({ ok: false }) as any,
  browserViewDetachGuest: async () => false,
  browserViewCloseTab: noopAsync,
  browserViewReportResidency: noopAsync,
  browserViewSuspendReady: noopAsync,
  browserViewEnsureResident: noopAsync,
  browserViewRestoreTabs: async () => [],
  browserViewUpdateViewport: noopAsync,
  importChromeBrowserData: async () => ({ success: false, cookies: 0, localStorage: 0, sites: [] }) as any,
  clearEmbeddedBrowserData: async () => ({ success: false }) as any,

  // ── 更新 ──
  onUpdateReady: noopDisposer,
  onUpdateCheckResult: noopDisposer,
  onUpdateStateChanged: noopDisposer,
  getUpdateState: async () => ({ kind: "idle" }) as any,
  downloadUpdate: noopAsync,
  cancelUpdateDownload: noopAsync,
  openUpdateStatusWindow: noopAsync,
  getAutoUpdatePreferences: async () => ({ autoDownloadAndInstallUpdates: false }),
  setAutoDownloadAndInstallUpdates: noopAsync,
  skipUpdateVersion: noopAsync,
  getDesktopSessionActivity: async () => ({ runningAgentSessionCount: 0 }),
  getZCodeStdioTapDevState: async () => ({ enabled: false }) as any,
  isLocalDevelopmentRuntime: false,
  onSettingsChanged: noopDisposer,
  onApplicationLocaleChanged: noopDisposer,
  getSystemLocale: async () => "zh-CN" as any,
  onPostUpdateReleaseNotes: noopDisposer,
  acknowledgePostUpdateReleaseNotes: noopAsync,
  quitAndInstallUpdate: noopAsync,

  // ── 编辑器（关键：原来 v3.5 漏实现，zcode 命令中心会抛 `getInstalledEditors is not a function`） ──
  getInstalledEditors: async () => [],
  openInEditor: noopPromiseFalse,
  executeDesktopCommand: noopAsync,
  setApplicationLocale: noopAsync,
  setTitleBarTheme: noopAsync,
};

export const evoflowPlatform: IPlatformService = makePlatformProxy(baseImplementations);

// 显式标注：Event.None 的使用方式与 zcode services 侧一致。
void Event.None;
