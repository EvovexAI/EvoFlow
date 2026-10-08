import { getVisibleTaskMetas } from "@/store/zcodeSessionStoreSelectors.js";
import type { WorkspaceZCodeUIState } from "@/store/zcodeSessionStoreTypes.js";

type WorkspaceUnreadState = Pick<
  WorkspaceZCodeUIState,
  "optimisticTaskListByTaskId" | "taskListCache"
> &
  Partial<Pick<WorkspaceZCodeUIState, "taskUnreadByTaskId">>;

export function countAllUnreadTasks(workspaces: Record<string, WorkspaceUnreadState>): number {
  const countedTaskKeys = new Set<string>();
  const visitedWorkspaceStates = new WeakSet<object>();

  for (const [workspaceKey, workspace] of Object.entries(workspaces)) {
    if (visitedWorkspaceStates.has(workspace)) {
      continue;
    }
    visitedWorkspaceStates.add(workspace);
    // 未读状态现在统一以 task meta.unreadAt 为准。
    // Dock badge 必须和任务列表蓝点读取同一份元数据，不能再单独依赖旧的临时 map。
    const visibleTasks = getVisibleTaskMetas(workspace);
    for (const task of visibleTasks) {
      if (!task.unreadAt) {
        continue;
      }
      countedTaskKeys.add(
        `${task.workspaceIdentity?.trim() || task.workspacePath}::${task.taskId}`,
      );
    }

    if (visibleTasks.length > 0) {
      continue;
    }

    // remote workspace 会同时保留 path key 和 workspaceIdentity key 的兼容状态。
    // 这里按 workspaceKey + taskId 去重，并跳过相同对象引用，避免窗口未读角标把同一个远端 task 算两次。
    for (const taskId of Object.keys(workspace.taskUnreadByTaskId ?? {})) {
      countedTaskKeys.add(`${workspaceKey}::${taskId}`);
    }
  }

  return countedTaskKeys.size;
}
