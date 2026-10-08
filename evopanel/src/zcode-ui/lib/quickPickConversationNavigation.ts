import type { ZCodeTaskMeta } from "@zcode/shared";
import type { CachedTaskListResult, TaskEntityKey } from "@/lib/taskQueryCache.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

interface QuickPickConversationNavigationState {
  canSelectPreviousConversation: boolean;
  canSelectNextConversation: boolean;
  previousTaskId: string | null;
  nextTaskId: string | null;
}

export function resolveQuickPickConversationNavigation(params: {
  taskIds: readonly string[];
  activeTaskId: string | null;
}): QuickPickConversationNavigationState {
  const taskIds = [...new Set(params.taskIds.filter((taskId) => taskId.length > 0))];
  const activeIndex = params.activeTaskId ? taskIds.indexOf(params.activeTaskId) : -1;
  const previousBaseIndex = activeIndex === -1 ? taskIds.length : activeIndex;
  const nextBaseIndex = activeIndex === -1 ? -1 : activeIndex;
  const previousTaskId = taskIds[previousBaseIndex - 1] ?? null;
  const nextTaskId = taskIds[nextBaseIndex + 1] ?? null;

  return {
    canSelectPreviousConversation: previousTaskId !== null,
    canSelectNextConversation: nextTaskId !== null,
    previousTaskId,
    nextTaskId,
  };
}

export function selectQuickPickConversationTaskIds(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  resultsByQueryKey: Record<string, CachedTaskListResult>;
  taskMetaByEntityKey: Record<TaskEntityKey, ZCodeTaskMeta>;
  fallbackTaskIds: readonly string[];
}): string[] {
  const workspaceKey = buildTaskWorkspaceKey(params.workspacePath, params.workspaceIdentity);
  const candidates = Object.values(params.resultsByQueryKey)
    .filter((result) => {
      const descriptor = result.descriptor;
      return (
        descriptor.kind === "workspace" &&
        descriptor.search === "" &&
        descriptor.workspaceKeys.length === 1 &&
        descriptor.workspaceKeys[0] === workspaceKey
      );
    })
    .sort((left, right) => {
      if (left.stale !== right.stale) {
        return Number(left.stale) - Number(right.stale);
      }
      if (left.descriptor.visibleLimit !== right.descriptor.visibleLimit) {
        return left.descriptor.visibleLimit === null ? -1 : 1;
      }
      return right.fetchedAt - left.fetchedAt;
    });

  for (const candidate of candidates) {
    const taskIds: string[] = [];
    for (const taskKey of candidate.taskKeys) {
      const task = params.taskMetaByEntityKey[taskKey];
      if (!task) {
        continue;
      }

      if (buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity) !== workspaceKey) {
        continue;
      }

      taskIds.push(task.taskId);
    }

    if (taskIds.length > 0) {
      return taskIds;
    }
  }

  // quickpick 的上/下一个任务以前只读 zcodeSessionStore.taskListCache。
  // 任务列表迁到 task query cache 后，旧缓存可能为空或顺序过期；只有新缓存还没到时才走旧路径兜底。
  return [...params.fallbackTaskIds];
}
