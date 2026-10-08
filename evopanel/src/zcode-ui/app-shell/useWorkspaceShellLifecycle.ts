import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { TaskChatMessage as TestChatMessage } from "@/lib/taskChatMessageTypes.js";
import type { BrowserNavigationRequest } from "@/hooks/useAppPanels.js";
import { logger } from "@/logger.js";
import {
  getWorkspaceDisplayedTaskState,
  getWorkspaceInitState,
  useZCodeSessionStore,
} from "@/store/zcodeSessionStore.js";

export function useWorkspaceShellLifecycle({
  workspaceAbsPath,
  workspaceIdentity,
  services,
  setBrowserNavigationRequest,
  setTestMessages,
}: {
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  services: IServiceAccessor;
  setBrowserNavigationRequest: Dispatch<SetStateAction<BrowserNavigationRequest | null>>;
  setTestMessages: Dispatch<SetStateAction<TestChatMessage[] | null>>;
}) {
  const previousWorkspaceAbsPathRef = useRef(workspaceAbsPath);

  useEffect(() => {
    if (previousWorkspaceAbsPathRef.current === workspaceAbsPath) {
      return;
    }

    previousWorkspaceAbsPathRef.current = workspaceAbsPath;

    // Root 之前依赖按 workspacePath 改 key 来"切工作区就整棵重建 App"，
    // 这样虽然顺手清空了局部状态，但也会把侧边栏 / TaskList 一起卸载，导致切任务时出现整列闪烁。
    // 现在改成保留同一个 App 实例后，只显式清理真正和旧 workspace 强绑定的状态，
    // 避免把上一项目的代码预览或测试覆盖消息串到新项目里。
    // side pane 现在按 workspaceIdentity/workspacePath 做内存恢复。
    // 这里不能再按 workspacePath 变化清掉 Git/source 或 tabs，否则跨 workspace 切回时会覆盖缓存。
    setBrowserNavigationRequest(null);
    setTestMessages(null);
  }, [setBrowserNavigationRequest, setTestMessages, workspaceAbsPath]);

  useEffect(() => {
    return () => {
      const currentWorkspaceState = useZCodeSessionStore
        .getState()
        .getWorkspaceState(workspaceAbsPath);
      const displayedTaskState = getWorkspaceDisplayedTaskState(currentWorkspaceState);
      if (
        currentWorkspaceState.activeTaskId ||
        displayedTaskState.taskStatus === "creating" ||
        displayedTaskState.taskStatus === "streaming"
      ) {
        return;
      }

      // 预热 session 会让没有 task 的 workspace 也常驻一个 ZCode Agent 进程。
      // 如果切走 tab 时不清理这类"只预热、未真正使用"的会话，来回切多个 workspace 后，
      // 背景里会留下多条空转进程。这里在离开当前 workspace 时做一次 best-effort 回收。
      // 另外必须把 workspace 初始化状态同步回退成 idle，否则下一次进入页面仍可能看到
      // 上一次残留的 ready/failed。单 ZCode Agent 下这里不再按 provider 循环清理。
      const workspaceInitState = getWorkspaceInitState(currentWorkspaceState);
      if (workspaceInitState.status === "idle") {
        return;
      }

      const provider = currentWorkspaceState.selectedProvider;
      logger.info(
        `[App] 回退 workspace 预热状态 workspace=${workspaceAbsPath} provider=${provider}`,
      );
      useZCodeSessionStore
        .getState()
        .setWorkspaceInitAttempts(workspaceAbsPath, 0, workspaceIdentity);
      useZCodeSessionStore
        .getState()
        .setWorkspaceInitState(workspaceAbsPath, "idle", null, workspaceIdentity);

      void services.zcodeTaskService
        .releaseWorkspacePreparation({
          workspacePath: workspaceAbsPath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          provider,
        })
        .catch((error: unknown) => {
          logger.error(
            `[App] 释放 workspace 预热态失败 workspace=${workspaceAbsPath} provider=${provider}:`,
            error,
          );
        });
    };
  }, [services.zcodeTaskService, workspaceIdentity, workspaceAbsPath]);
}
