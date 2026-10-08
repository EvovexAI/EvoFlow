import type { ZCodeProvider } from "@zcode/shared";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { WorkspaceZCodeUIState } from "@/store/zcodeSessionStoreTypes.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";

function resolveChatViewActiveTaskProvider(
  taskId: string | null,
  workspaceState: Pick<
    WorkspaceZCodeUIState,
    "selectedProvider" | "taskListCache" | "optimisticTaskListByTaskId"
  >,
): ZCodeProvider {
  if (!taskId) {
    return workspaceState.selectedProvider;
  }

  // 输入框里的 $/ 技能列表和 / 面板之前只看 workspace 当前选中的 provider。
  // 用户一旦切到历史 task、fork task，或 task provider 与 workspace 默认值短暂不一致时，
  // 面板就会混入别的 agent 技能，连发送前注入的 available_skills 也会跟着跑偏。
  // 这里统一优先读取当前 task 自己的 provider，让“当前正在看的 task”成为唯一真值。
  // 另外切换 Agent 成功后，taskListCache 里的旧 provider 可能会晚一拍才刷新；
  // optimistic meta 才是当前前端刚确认过的最新结果，所以必须先吃 optimistic，图标才会立即切换。
  return (
    workspaceState.optimisticTaskListByTaskId[taskId]?.provider ??
    workspaceState.taskListCache?.find((task) => task.taskId === taskId)?.provider ??
    workspaceState.selectedProvider
  );
}

export function useChatViewActiveTaskProvider(
  taskId: string | null,
  workspacePath: string,
  workspaceIdentity?: string,
) {
  const activeTabWorkspaceIdentity = useTabStore((state) => {
    if (!state.activeTabId) {
      return undefined;
    }

    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (!activeTab || !isWorkspaceTab(activeTab) || activeTab.workspacePath !== workspacePath) {
      return undefined;
    }

    return activeTab.workspaceIdentity;
  });
  const resolvedWorkspaceIdentity = workspaceIdentity ?? activeTabWorkspaceIdentity;

  return useZCodeSessionStore((state) => {
    const workspaceState = selectWorkspaceZCodeState(
      state,
      workspacePath,
      resolvedWorkspaceIdentity,
    );

    return resolveChatViewActiveTaskProvider(taskId, workspaceState);
  });
}
