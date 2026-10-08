import { useEffect, useRef, useState } from "react";
import type {
  BrowserViewScreenshotSurfacePreparePayload,
  BrowserViewScreenshotSurfaceReleasePayload,
} from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import type { BrowserUseSidePaneTab, WorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";

function matchesTab(
  tab: BrowserUseSidePaneTab,
  payload: BrowserViewScreenshotSurfacePreparePayload,
): boolean {
  return (
    tab.workspaceKey === payload.workspaceKey &&
    tab.sessionId === payload.sessionId &&
    tab.browserId === payload.browserId &&
    tab.browserGeneration === payload.browserGeneration &&
    tab.tabId === payload.tabId
  );
}

/**
 * 跨进程恢复的 browser tab（browser: 前缀）在 renderer registry 里的 browserId /
 * browserGeneration 是持久 shell 里旧进程的值；tab 被新一轮 scope 接管后 main 侧
 * owner 已更新，但 renderer 没有可靠的同步通道（residency transition 只在状态
 * 变化时携带新值）。prepare/release 若坚持七元组严格匹配，恢复 tab 的截图
 * surface 永远匹配失败：prepare 被静默忽略 → 截图必 3s 超时；release 永不命中
 * → pane 卡死在近透明 fixed 层（用户感知为透明遮罩假死）。因此降级为
 * workspaceKey + sessionId + tabId 匹配——tabId 是全局唯一 uuid，前两者防止
 * 跨工作区/会话串扰；stale 防护由 main 侧 coordinator 用请求内 generation 承担。
 */
function matchesTabLoose(
  tab: BrowserUseSidePaneTab,
  payload: BrowserViewScreenshotSurfacePreparePayload,
): boolean {
  return (
    tab.workspaceKey === payload.workspaceKey &&
    tab.sessionId === payload.sessionId &&
    tab.tabId === payload.tabId
  );
}

function matchesRequest(
  request: BrowserViewScreenshotSurfacePreparePayload,
  payload: BrowserViewScreenshotSurfaceReleasePayload,
): boolean {
  return (
    request.requestId === payload.requestId &&
    request.workspaceKey === payload.workspaceKey &&
    request.sessionId === payload.sessionId &&
    request.tabId === payload.tabId &&
    request.webContentsId === payload.webContentsId
  );
}

function findScreenshotSurfaceTab(
  tabs: readonly WorkspaceSidePaneTab[],
  payload: BrowserViewScreenshotSurfacePreparePayload,
): BrowserUseSidePaneTab | undefined {
  return tabs.find(
    (tab): tab is BrowserUseSidePaneTab => tab.type === "browser-use" && matchesTab(tab, payload),
  );
}

/**
 * prepare 已经被当前 renderer 接收后，browserGeneration 可能随 attach/restore 继续更新。
 * 此时仍需把同一个瞬时请求送到原 tab；main 会用请求中的 generation 做最终 stale 防护。
 */
export function findScreenshotSurfaceTabForRender(
  tabs: readonly WorkspaceSidePaneTab[],
  payload: BrowserViewScreenshotSurfacePreparePayload,
): BrowserUseSidePaneTab | undefined {
  return (
    findScreenshotSurfaceTab(tabs, payload) ??
    tabs.find(
      (tab): tab is BrowserUseSidePaneTab =>
        tab.type === "browser-use" && matchesTabLoose(tab, payload),
    )
  );
}

/**
 * prepare 接收匹配：严格 scope 命中优先；跨进程恢复的 tab 其 registry scope 元数据
 * 停留在旧进程值（见 matchesTabLoose 注释），必须降级匹配才能收到 prepare。
 */
function findScreenshotSurfaceTabForPrepare(
  tabs: readonly WorkspaceSidePaneTab[],
  payload: BrowserViewScreenshotSurfacePreparePayload,
): BrowserUseSidePaneTab | undefined {
  return findScreenshotSurfaceTabForRender(tabs, payload);
}

/**
 * 只保存已经匹配到当前 renderer tab registry 的瞬时准备请求。请求不进入 workspace store，
 * 从而不会把桌面合成同步扩散到 remote/replayable 的 task 状态。
 */
export function useBrowserScreenshotSurfaceRequest(
  tabs: readonly WorkspaceSidePaneTab[],
): BrowserViewScreenshotSurfacePreparePayload | null {
  const platform = usePlatform();
  const [request, setRequest] = useState<BrowserViewScreenshotSurfacePreparePayload | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  useEffect(() => {
    const disposePrepare = platform.onBrowserViewScreenshotSurfacePrepare?.((payload) => {
      // browser-use operation 会更新 tab registry；旧 effect 以 tabs 为依赖，
      // command 与 React effect cleanup 同时发生时会短暂移除 IPC listener，prepare 消息因此
      // 永久丢失并让后台截图等满 30 秒。listener 只随 platform 生命周期注册，匹配时读取最新 tabs。
      if (!findScreenshotSurfaceTabForPrepare(tabsRef.current, payload)) {
        logger.debug("[browser-use] 忽略非当前 renderer tab 的截图 surface prepare", {
          requestId: payload.requestId,
          tabId: payload.tabId,
        });
        return;
      }
      logger.debug("[browser-use] 接收截图 surface prepare", {
        requestId: payload.requestId,
        tabId: payload.tabId,
        webContentsId: payload.webContentsId,
      });
      setRequest((current) => {
        if (current && current.requestId !== payload.requestId) {
          logger.debug("[browser-use] 保留仍在准备中的截图 surface 请求", {
            requestId: current.requestId,
            tabId: current.tabId,
          });
          return current;
        }
        return payload;
      });
    });
    const disposeRelease = platform.onBrowserViewScreenshotSurfaceRelease?.((payload) => {
      setRequest((current) => {
        if (!current || !matchesRequest(current, payload)) {
          return current;
        }
        return null;
      });
    });
    return () => {
      disposePrepare?.();
      disposeRelease?.();
    };
  }, [platform]);

  return request;
}
