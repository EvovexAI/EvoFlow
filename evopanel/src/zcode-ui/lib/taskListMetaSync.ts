import type { ZCodeTaskMeta } from "@zcode/shared";
import { mergeTaskMetaCandidates } from "@/lib/zcodeTaskMetaMerge.js";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";
import { getTaskMeta, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  applyTaskQueryCacheMutation,
  removeTaskFromTaskQueryCaches,
  updateTaskQueryCacheTaskMetaPreservingMembership,
  upsertTaskQueryCacheTaskMeta,
  useTaskQueryCacheStore,
  type TaskListMembershipState,
} from "@/store/taskQueryCacheStore.js";

export function removeTaskFromTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}): boolean {
  const store = useZCodeSessionStore.getState();
  const workspaceState = store.getWorkspaceState(params.workspacePath, params.workspaceIdentity);
  if (workspaceState.taskListCache) {
    store.setTaskListCache(
      params.workspacePath,
      workspaceState.taskListCache.filter((task) => task.taskId !== params.taskId),
      params.workspaceIdentity,
    );
  }
  store.removeTaskState(params.workspacePath, params.taskId, params.workspaceIdentity);
  return removeTaskFromTaskQueryCaches(params);
}

const ABSENT_MEMBERSHIP: TaskListMembershipState = {
  pinned: true,
  archived: true,
};

function sortTasksByUpdatedAt(tasks: readonly ZCodeTaskMeta[]): ZCodeTaskMeta[] {
  return [...tasks].sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    if (right.createdAt !== left.createdAt) {
      return right.createdAt - left.createdAt;
    }
    return right.taskId.localeCompare(left.taskId);
  });
}

export function syncTaskMetaToTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  task: ZCodeTaskMeta;
  membership?: TaskListMembershipState;
  forceInsertMembership?: boolean;
  ensureInWorkspaceTaskCache?: boolean;
  preserveListMembership?: boolean;
  applyQueryCacheMutation?: boolean;
}): void {
  const store = useZCodeSessionStore.getState();
  const workspaceState = store.getWorkspaceState(params.workspacePath, params.workspaceIdentity);
  const previousTask = getTaskMeta(workspaceState, params.task.taskId);
  const queryTask = useTaskQueryCacheStore.getState().taskMetaByEntityKey[
    buildTaskEntityKey({
      taskId: params.task.taskId,
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity ?? params.task.workspaceIdentity,
    })
  ];
  // Bugfix: session/readSession 快照的 updatedAt 可能落后于首发 prompt 写入的前端乐观时间。
  // 同步快照时必须先和本地已有 task meta 单调合并，否则新建任务会在 sqlite 首屏刷新后跳回下面。
  // Bugfix: 重启恢复时 workspace store 可能还没有当前 task，但 query cache 已经有 sqlite indexed meta。
  // raw session snapshot 不带 titleOverridden，必须一起合并，避免手动重命名标题在 renderer 被还原。
  const task =
    mergeTaskMetaCandidates(params.task, previousTask, queryTask) ?? params.task;
  const cachedTasks = workspaceState.taskListCache ?? [];
  const hasCachedTask = cachedTasks.some((cachedTask) => cachedTask.taskId === task.taskId);
  const shouldExistInWorkspaceTaskCache =
    params.membership?.pinned === false && params.membership.archived === false;
  const nextCachedTasks = params.preserveListMembership
    ? cachedTasks.map((cachedTask) => (cachedTask.taskId === task.taskId ? task : cachedTask))
    : shouldExistInWorkspaceTaskCache
      ? sortTasksByUpdatedAt([
          task,
          ...cachedTasks.filter((cachedTask) => cachedTask.taskId !== task.taskId),
        ])
      : cachedTasks.filter((cachedTask) => cachedTask.taskId !== task.taskId);

  // Bugfix: 终态/回滚类操作之前统一 bump 整个 taskListVersion，只是为了把最新 snapshot.meta
  // 重新捞回列表。这里改成按 task 增量回写 taskListCache，避免所有 task 列表整轮重查。
  if (
    workspaceState.taskListCache !== null &&
    ((params.preserveListMembership && hasCachedTask) ||
      params.ensureInWorkspaceTaskCache ||
      hasCachedTask ||
      !shouldExistInWorkspaceTaskCache)
  ) {
    store.setTaskListCache(params.workspacePath, nextCachedTasks, params.workspaceIdentity);
  }

  // Bugfix: Header / 当前会话信息会优先拿 optimistic meta 覆盖旧缓存。
  // 如果这里只改 query cache，不补 optimistic 池，当前激活 task 仍可能继续显示旧标题/旧摘要。
  store.upsertOptimisticTaskListItem(params.workspacePath, task, params.workspaceIdentity);
  upsertTaskQueryCacheTaskMeta(task);

  if (params.preserveListMembership) {
    updateTaskQueryCacheTaskMetaPreservingMembership(task);
  } else if (params.membership && params.applyQueryCacheMutation !== false) {
    // Bugfix: 手机 shared-host 创建 task 时，桌面 renderer 只收到 workspace 事件，
    // 没有本地首发路径的 insertTaskIntoTaskCaches。previousTask 缺失时仍要按 active
    // 成员关系插入 query cache，否则远控首页会继续同步旧列表顺序。
    // Bugfix: 本地首发会先写 optimistic meta，再插入列表成员；此时 previousTask 虽然存在，
    // 但它只代表“已有元数据”，不代表“已经计入列表 total”。新建任务必须显式按 absent -> active
    // 处理，否则第 6 个 workspace task 的 total 仍停在 5，Show more 不会出现。
    applyTaskQueryCacheMutation({
      previousTask: previousTask ?? task,
      nextTask: task,
      previousState:
        previousTask && !params.forceInsertMembership
          ? params.membership
          : ABSENT_MEMBERSHIP,
      nextState: params.membership,
    });
  }
}

export function insertTaskIntoTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  task: ZCodeTaskMeta;
  membership: TaskListMembershipState;
}): void {
  // Bugfix: 新建/fork/远控 shared-host 创建 task 都应走同一条“无 -> 有”成员变更。
  // syncTaskMetaToTaskCaches 会在 previousTask 缺失时按 ABSENT_MEMBERSHIP 插入 query cache，
  // 这里不能再二次 apply mutation，否则 total 会被重复加一。
  syncTaskMetaToTaskCaches({
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    task: params.task,
    membership: params.membership,
    forceInsertMembership: true,
    ensureInWorkspaceTaskCache:
      params.membership.pinned === false && params.membership.archived === false,
  });
}
