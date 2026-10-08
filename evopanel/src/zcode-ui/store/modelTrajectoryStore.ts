import { create } from "zustand";

/**
 * 打开“模型调用轨迹”侧边栏的请求桥接 store。
 *
 * 背景：触发入口在任务右键菜单 / Header 菜单里，挂载位置很深；而侧边栏 tab 状态由
 * 每个 workspace 的 useAppPanels 持有。为避免把一个新回调贯穿整棵任务列表树，
 * 这里用一个轻量单例 store 作为桥：菜单写入 pending 请求，目标 workspace 的
 * useAppPanels 订阅并消费（按 workspaceKey 匹配，避免多 workspace 实例串开）。
 */
interface ModelTrajectoryOpenRequest {
  /** 唯一请求 id，保证同一 task 连续点击也能触发消费。 */
  requestId: string;
  taskId: string;
  /** workspaceIdentity?.trim() || workspacePath，用于定位目标 workspace 侧边栏。 */
  workspaceKey: string;
  title?: string | null;
}

interface ModelTrajectoryStoreState {
  pendingRequest: ModelTrajectoryOpenRequest | null;
  requestOpen: (request: Omit<ModelTrajectoryOpenRequest, "requestId">) => void;
  consumeRequest: (requestId: string) => void;
}

declare global {
  interface Window {
    __zcodeModelTrajectoryStoreE2E?: typeof useModelTrajectoryStore;
  }
}

let requestSeq = 0;

export const useModelTrajectoryStore = create<ModelTrajectoryStoreState>((set) => ({
  pendingRequest: null,
  requestOpen: (request) => {
    requestSeq += 1;
    set({
      pendingRequest: { ...request, requestId: `model-trajectory-open:${requestSeq}` },
    });
  },
  consumeRequest: (requestId) => {
    set((state) =>
      state.pendingRequest?.requestId === requestId ? { pendingRequest: null } : state,
    );
  },
}));

// E2E 需要在双 workspace 壳中直接验证 request bridge → 目标 workspace side pane 的完整链路。
// Header 菜单只绑定当前 header 的 activeTaskId，不能作为分屏壳（split pane）的稳定测试入口；
// 与 __zcodeSessionStoreE2E 保持同一模式，暴露 store 本身而不是另造测试专用业务实现。
if (typeof window !== "undefined") {
  window.__zcodeModelTrajectoryStoreE2E = useModelTrajectoryStore;
}
