import type { ZCodeTaskMeta } from "@zcode/shared";
import type { CachedTaskListResult } from "@/lib/taskQueryCache.js";
import {
  mergeWorkspaceTaskListItemsWithOptimistic,
  type WorkspaceOptimisticTaskOverlay,
} from "@/hooks/workspaceTaskListOptimisticOverlay.js";
import { areTaskListItemsEquivalent } from "@/hooks/workspaceTaskListRefreshSignatures.js";
import { countLiveWorkflowRuns } from "@/lib/workflowRunLine.js";
import { getTaskListRowActivity } from "@/v4/taskListRowActivity.js";

interface WorkspaceTaskListDisplayConfig {
  scope: {
    workspacePath: string;
    workspaceIdentity?: string;
  };
  workspaceKey: string;
  visibleLimit: number;
  queryKey: string;
}

export interface WorkspaceTaskListGroup {
  workspacePath: string;
  workspaceIdentity?: string;
  items: ZCodeTaskMeta[];
  total: number;
  hasMore: boolean;
  hasUnread: boolean;
  /** 组内在跑的工作流 run 数：项目收起时组头旁的脉冲灯。 */
  liveWorkflowCount: number;
}

export function buildWorkspaceTaskListDisplayGroups(params: {
  queryConfigs: WorkspaceTaskListDisplayConfig[];
  resultsByQueryKey: Record<string, CachedTaskListResult>;
  taskMetaByEntityKey: Record<string, ZCodeTaskMeta>;
  taskUnreadOverlayByEntityKey: Record<string, number | null>;
  optimisticTaskOverlayByWorkspaceKey: Map<string, WorkspaceOptimisticTaskOverlay>;
  previousGroupsByWorkspaceKey: Map<string, WorkspaceTaskListGroup>;
  sortBy: "created" | "updated";
}): {
  groups: WorkspaceTaskListGroup[];
  cache: Map<string, WorkspaceTaskListGroup>;
} {
  const cache = new Map<string, WorkspaceTaskListGroup>();
  const groups = params.queryConfigs.map<WorkspaceTaskListGroup>((config) => {
    const cachedResult = params.resultsByQueryKey[config.queryKey];
    const previousGroup = params.previousGroupsByWorkspaceKey.get(config.workspaceKey);
    if (!cachedResult && previousGroup) {
      // workspace 的可见上限从 5 切到 10/15 时会生成新的 limit cache key。
      // 新 key 首次计算期间沿用上一档快照，并按目标上限裁剪，避免任务行闪空；
      // 收起重置为 5 时也不会短暂显示上一档的更多任务。
      const placeholderItems = previousGroup.items.slice(0, config.visibleLimit);
      const placeholderHasMore = previousGroup.total > placeholderItems.length;
      const placeholderGroup =
        placeholderItems.length === previousGroup.items.length &&
        previousGroup.hasMore === placeholderHasMore &&
        previousGroup.workspacePath === config.scope.workspacePath &&
        previousGroup.workspaceIdentity === config.scope.workspaceIdentity
          ? previousGroup
          : {
              ...previousGroup,
              workspacePath: config.scope.workspacePath,
              workspaceIdentity: config.scope.workspaceIdentity,
              items: placeholderItems,
              hasMore: placeholderHasMore,
            };
      cache.set(config.workspaceKey, placeholderGroup);
      return placeholderGroup;
    }

    const displayResult = cachedResult;
    const cachedItems =
      displayResult?.taskKeys
        .map((taskKey) => params.taskMetaByEntityKey[taskKey])
        .filter((task): task is ZCodeTaskMeta => Boolean(task)) ?? [];
    const optimisticOverlay = params.optimisticTaskOverlayByWorkspaceKey.get(config.workspaceKey);
    const items = mergeWorkspaceTaskListItemsWithOptimistic({
      items: cachedItems,
      optimisticTasks: optimisticOverlay?.tasks ?? [],
      activeTaskId: optimisticOverlay?.activeTaskId ?? null,
      sortBy: params.sortBy,
      visibleLimit: config.visibleLimit,
    });
    const total = Math.max(displayResult?.total ?? cachedItems.length, items.length);
    const hasUnread =
      items.some((task) => typeof task.unreadAt === "number") ||
      (displayResult?.unreadTaskKeys ?? []).some(
        (taskKey) => params.taskUnreadOverlayByEntityKey[taskKey] !== null,
      );
    const liveWorkflowCount = items.reduce(
      (count, task) =>
        count + countLiveWorkflowRuns(getTaskListRowActivity(task)?.workflowActivity),
      0,
    );
    const nextGroup = {
      workspacePath: config.scope.workspacePath,
      workspaceIdentity: config.scope.workspaceIdentity,
      items,
      total,
      hasMore: Math.max(total, items.length) > items.length,
      hasUnread,
      liveWorkflowCount,
    };
    if (
      previousGroup &&
      previousGroup.workspacePath === nextGroup.workspacePath &&
      previousGroup.workspaceIdentity === nextGroup.workspaceIdentity &&
      previousGroup.total === nextGroup.total &&
      previousGroup.hasMore === nextGroup.hasMore &&
      previousGroup.hasUnread === nextGroup.hasUnread &&
      previousGroup.liveWorkflowCount === nextGroup.liveWorkflowCount &&
      areTaskListItemsEquivalent(previousGroup.items, nextGroup.items)
    ) {
      cache.set(config.workspaceKey, previousGroup);
      return previousGroup;
    }

    // 添加 workspace 或拖拽重排只改变 workspace 容器顺序时，
    // 每次都重建所有 group/items 数组会让 memo 行组件收到新引用，看起来像整条侧栏刷新。
    // 这里按 workspaceKey 复用等价的展示快照，只让新增或真实变更的 workspace 进入乐观加载。
    cache.set(config.workspaceKey, nextGroup);
    return nextGroup;
  });

  return { groups, cache };
}
