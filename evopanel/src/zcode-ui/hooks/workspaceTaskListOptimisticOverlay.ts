import { useMemo } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { buildTaskEntityKey, buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import { mergeTaskWithOptimisticMeta } from "@/lib/zcodeTaskMetaMerge.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { GroupedDraftTaskState } from "@/store/zcodeSessionStoreTypes.js";
import { mergeTaskListMembershipFields } from "@/v4/taskListRowActivity.js";

export interface WorkspaceOptimisticTaskOverlay {
  activeTaskId: string | null;
  tasks: ZCodeTaskMeta[];
  promotedGroupedDraftTaskByTaskId: Record<string, GroupedDraftTaskState>;
}

type WorkspaceTaskListSortBy = "created" | "updated";

interface WorkspaceOptimisticScope {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
}

export function mergeWorkspaceTaskListItemsWithOptimistic(params: {
  items: readonly ZCodeTaskMeta[];
  optimisticTasks: readonly ZCodeTaskMeta[];
  activeTaskId: string | null;
  sortBy: WorkspaceTaskListSortBy;
  visibleLimit: number | null;
}): ZCodeTaskMeta[] {
  const taskByKey = new Map(params.items.map((task) => [buildTaskEntityKey(task), task] as const));

  for (const optimisticTask of params.optimisticTasks) {
    const taskKey = buildTaskEntityKey(optimisticTask);
    const existingTask = taskByKey.get(taskKey);
    if (!existingTask && optimisticTask.taskId !== params.activeTaskId) {
      continue;
    }

    // workspace task 列表的服务端查询可能晚于首发 optimistic 写入返回。
    // 如果直接信 query cache 里的旧 meta，新任务会先在顶部，随后被旧 updatedAt/title 压回下面。
    // 这里只把已可见任务和当前 active task 的 optimistic meta 合并回来，保留真实列表成员边界。
    taskByKey.set(
      taskKey,
      existingTask
        ? mergeTaskListMembershipFields(existingTask, {
            ...mergeTaskWithOptimisticMeta(existingTask, optimisticTask),
            // unreadAt 属于 query cache 的 membership 字段，右键菜单写入的
            // legacy optimistic task 只能兼容旧消费者，不能反向覆盖 query field overlay。
            // 否则打开 task 的已读 overlay 或写入失败后的 rollback 都会被旧值盖回去。
            unreadAt: existingTask.unreadAt,
          })
        : optimisticTask,
    );
  }

  const sortedItems = [...taskByKey.values()].sort((left, right) =>
    compareZCodeTaskListItems(left, right, params.sortBy),
  );
  return params.visibleLimit === null ? sortedItems : sortedItems.slice(0, params.visibleLimit);
}

export function useWorkspaceTaskOptimisticOverlayByWorkspaceKey(
  workspaceTabs: WorkspaceTabState[],
): Map<string, WorkspaceOptimisticTaskOverlay> {
  const workspaceScopeSignature = JSON.stringify(
    workspaceTabs
      .map((tab) => ({
        workspacePath: tab.workspacePath,
        workspaceIdentity: tab.workspaceIdentity,
        workspaceKey: buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity),
      }))
      .sort((left, right) => left.workspaceKey.localeCompare(right.workspaceKey)),
  );
  const workspaceScopes = useMemo(
    () => JSON.parse(workspaceScopeSignature) as WorkspaceOptimisticScope[],
    [workspaceScopeSignature],
  );
  const optimisticTaskListSignature = useZCodeSessionStore((state) =>
    JSON.stringify(
      workspaceScopes.map((scope) => {
        const workspaceState = selectWorkspaceZCodeState(
          state,
          scope.workspacePath,
          scope.workspaceIdentity,
        );
        return [
          scope.workspaceKey,
          workspaceState.activeTaskId,
          Object.values(workspaceState.optimisticTaskListByTaskId)
            .map((task) => {
              const promotedDraft = workspaceState.promotedGroupedDraftTaskByTaskId[task.taskId];
              return [
                task.taskId,
                task.title,
                task.createdAt,
                task.updatedAt,
                task.status,
                task.unreadAt,
                task.provider,
                task.model,
                promotedDraft?.createdAt,
                promotedDraft?.placement.type,
                promotedDraft?.placement.type === "group" ? promotedDraft.placement.groupId : null,
              ];
            })
            .sort(([leftTaskId], [rightTaskId]) =>
              String(leftTaskId).localeCompare(String(rightTaskId)),
            ),
        ] as const;
      }),
    ),
  );

  return useMemo(() => {
    const state = useZCodeSessionStore.getState();
    return new Map<string, WorkspaceOptimisticTaskOverlay>(
      workspaceScopes.map((scope) => {
        const workspaceState = selectWorkspaceZCodeState(
          state,
          scope.workspacePath,
          scope.workspaceIdentity,
        );
        return [
          scope.workspaceKey,
          {
            activeTaskId: workspaceState.activeTaskId,
            tasks: Object.values(workspaceState.optimisticTaskListByTaskId),
            promotedGroupedDraftTaskByTaskId: workspaceState.promotedGroupedDraftTaskByTaskId,
          },
        ];
      }),
    );
  }, [optimisticTaskListSignature, workspaceScopes]);
}
