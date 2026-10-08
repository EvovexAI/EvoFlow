import { useCallback } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { logger } from "@/logger.js";
import type { TabStoreState } from "@/store/tabStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { usePaneLayoutStore } from "@/v4/paneLayoutStore.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";

export function useConversationWorkspaceActions({
  services,
  addTab,
  setWorkspaceActionError,
}: {
  services: IServiceAccessor;
  addTab: TabStoreState["addTab"];
  setWorkspaceActionError: (error: string | null) => void;
}) {
  const handleSelectConversationWorkspace = useCallback(
    (path: string) => {
      // 对话工作区是 app 管理的共享 cwd，不属于用户项目：不走跨窗口项目激活，
      // 也不写 recentProjects，只用 purpose 让展示层把它归到“对话”。
      logger.info("[Root] select conversation workspace", { path });
      addTab(path, { workspacePurpose: "conversation" });
      setWorkspaceActionError(null);
    },
    [addTab, setWorkspaceActionError],
  );

  const handleResolveConversationWorkspace = useCallback(async () => {
    try {
      const result = await services.fileService.ensureConversationWorkspace();
      setWorkspaceActionError(null);
      return result.path;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[Root] ensure conversation workspace failed", { error });
      setWorkspaceActionError(message);
      throw error;
    }
  }, [services.fileService, setWorkspaceActionError]);

  const handleEnsureConversationWorkspace = useCallback(async () => {
    const path = await handleResolveConversationWorkspace();
    handleSelectConversationWorkspace(path);
    return path;
  }, [handleResolveConversationWorkspace, handleSelectConversationWorkspace]);

  const handleCreateConversationTask = useCallback(async () => {
    try {
      const path = await handleResolveConversationWorkspace();
      handleSelectConversationWorkspace(path);
      // “对话 +”是显式目标，不应被当前 split pane / workbench group 的项目绑定覆盖。
      useWorkbenchGroupStore.getState().deactivateActiveGroup();
      usePaneLayoutStore.getState().resetToPrimaryPane();
      useZCodeSessionStore.getState().startDraft(path);
    } catch {
      // handleResolveConversationWorkspace 已记录错误并保留当前 workspace。
    }
  }, [handleResolveConversationWorkspace, handleSelectConversationWorkspace]);

  return {
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask,
  };
}
