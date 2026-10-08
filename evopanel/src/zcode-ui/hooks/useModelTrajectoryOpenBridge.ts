import { useEffect } from "react";
import { useModelTrajectoryStore } from "@/store/modelTrajectoryStore.js";

/**
 * 订阅“打开模型调用轨迹”请求并交给当前 workspace 的侧边栏控制器。
 *
 * 触发入口在任务右键菜单 / Header 菜单深处，通过单例 store 发起请求；这里按 workspaceKey
 * 匹配后调用 onOpen 打开侧边栏 tab，再消费请求，避免多 workspace 实例串开。
 */
export function useModelTrajectoryOpenBridge(
  ownWorkspaceKey: string,
  onOpen: (params: { taskId: string; title?: string | null }) => void,
): void {
  useEffect(() => {
    const handlePending = (
      pendingRequest: ReturnType<typeof useModelTrajectoryStore.getState>["pendingRequest"],
    ) => {
      if (!pendingRequest || pendingRequest.workspaceKey !== ownWorkspaceKey) {
        return;
      }
      onOpen({ taskId: pendingRequest.taskId, title: pendingRequest.title });
      useModelTrajectoryStore.getState().consumeRequest(pendingRequest.requestId);
    };

    // 订阅期间可能已有 pending 请求（点击与挂载存在竞态），先处理一次当前值。
    handlePending(useModelTrajectoryStore.getState().pendingRequest);
    return useModelTrajectoryStore.subscribe((state) => {
      handlePending(state.pendingRequest);
    });
  }, [onOpen, ownWorkspaceKey]);
}
