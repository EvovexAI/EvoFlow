import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskMeta, ZCodeWorkspaceTaskListChanged } from "@zcode/shared";
import { buildTaskEntityKey, buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  markTaskQueryCacheScopesStale,
  reconcileTaskQueryCacheUnread,
  rollbackTaskQueryCacheUnread,
  setTaskQueryCacheUnreadOverlay,
  useTaskQueryCacheStore,
} from "@/store/taskQueryCacheStore.js";
import { getTaskUnreadIndicator, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { bumpTaskListMembershipVersion } from "@/v4/taskListMembershipVersion.js";
import { logger } from "@/logger.js";

type TaskUnreadService = Pick<IZCodeTaskService, "setTaskUnread">;

const STATUS_UNREAD_DEDUPE_WINDOW_MS = 1_000;
const STATUS_UNREAD_DEDUPE_MAX_KEYS = 256;
const recentStatusUnreadAtByKey = new Map<string, number>();

function isTerminalTaskStatus(status: ZCodeTaskMeta["status"]): boolean {
  return status === "completed" || status === "error";
}

function buildStatusUnreadKey(event: ZCodeWorkspaceTaskListChanged, taskId: string): string {
  const workspaceKey = buildTaskWorkspaceKey(event.workspacePath, event.workspaceIdentity);
  return [workspaceKey, taskId, event.taskMeta?.status ?? "", event.taskMeta?.updatedAt ?? ""].join(
    "::",
  );
}

function shouldSkipRecentStatusUnread(key: string): boolean {
  const now = Date.now();
  for (const [recentKey, at] of recentStatusUnreadAtByKey) {
    if (now - at > STATUS_UNREAD_DEDUPE_WINDOW_MS) {
      recentStatusUnreadAtByKey.delete(recentKey);
    }
  }
  if (recentStatusUnreadAtByKey.has(key)) {
    return true;
  }
  recentStatusUnreadAtByKey.set(key, now);
  if (recentStatusUnreadAtByKey.size > STATUS_UNREAD_DEDUPE_MAX_KEYS) {
    const oldestKey = recentStatusUnreadAtByKey.keys().next().value;
    if (oldestKey) {
      recentStatusUnreadAtByKey.delete(oldestKey);
    }
  }
  return false;
}

function shouldMarkStatusEventTaskUnread(params: {
  activeTaskId: string | null;
  activeWorkspace: { workspacePath: string; workspaceIdentity?: string };
  event: ZCodeWorkspaceTaskListChanged;
}): boolean {
  const taskId = params.event.taskId ?? params.event.taskMeta?.taskId;
  const isEventWorkspaceActive =
    buildTaskWorkspaceKey(
      params.activeWorkspace.workspacePath,
      params.activeWorkspace.workspaceIdentity,
    ) === buildTaskWorkspaceKey(params.event.workspacePath, params.event.workspaceIdentity);
  return (
    params.event.reason === "task_status_changed" &&
    params.event.unreadSignal === "background_terminal" &&
    Boolean(taskId) &&
    isTerminalTaskStatus(params.event.taskMeta?.status) &&
    (!isEventWorkspaceActive || params.activeTaskId !== taskId)
  );
}

export function syncTaskUnreadFromStatusWorkspaceEvent(params: {
  activeWorkspace: { workspacePath: string; workspaceIdentity?: string };
  event: ZCodeWorkspaceTaskListChanged;
  service: TaskUnreadService;
}): void {
  const { event, service } = params;
  const taskId = event.taskId ?? event.taskMeta?.taskId;
  if (
    !taskId ||
    event.reason !== "task_status_changed" ||
    event.unreadSignal !== "background_terminal"
  ) {
    return;
  }

  const store = useZCodeSessionStore.getState();
  const workspaceState = store.getWorkspaceState(event.workspacePath, event.workspaceIdentity);
  if (
    !shouldMarkStatusEventTaskUnread({
      activeTaskId: workspaceState.activeTaskId,
      activeWorkspace: params.activeWorkspace,
      event,
    })
  ) {
    return;
  }

  const targetTask = {
    taskId,
    workspacePath: event.workspacePath,
    ...(event.workspaceIdentity ? { workspaceIdentity: event.workspaceIdentity } : {}),
  };
  const taskEntityKey = buildTaskEntityKey(targetTask);
  const queryCacheState = useTaskQueryCacheStore.getState();
  const cachedTask = queryCacheState.taskMetaByEntityKey[taskEntityKey];
  const pendingUnreadAt = queryCacheState.taskUnreadOverlayByEntityKey[taskEntityKey];
  const persistedUnreadAt =
    cachedTask?.unreadAt ??
    event.taskMeta?.unreadAt ??
    (typeof pendingUnreadAt === "number" ? pendingUnreadAt : undefined);
  if (typeof persistedUnreadAt === "number") {
    // 同一条 status 事件会由多个侧栏订阅收到。首个 listener 已经写入
    // query-row overlay 后，后续 listener 只补兼容 Dock badge，不重复落库。
    // 如果 unreadAt 已由事件携带，则直接对账字段；不能为已有未读再创建永久 overlay。
    if (typeof cachedTask?.unreadAt !== "number" && typeof pendingUnreadAt !== "number") {
      rollbackTaskQueryCacheUnread(targetTask, persistedUnreadAt);
    }
    store.setTaskUnreadIndicator(event.workspacePath, taskId, true, event.workspaceIdentity);
    return;
  }

  const dedupeKey = buildStatusUnreadKey(event, taskId);
  if (shouldSkipRecentStatusUnread(dedupeKey)) {
    return;
  }

  const previousUnreadAt = cachedTask?.unreadAt;
  const previousLegacyUnread = getTaskUnreadIndicator(workspaceState, taskId);
  const optimisticUnreadAt = Date.now();
  // V4 侧栏已经只消费 task query row 的 unreadAt，旧 Zustand
  // taskUnreadByTaskId 不再驱动 TaskListItem。后台终态必须先按精确 entity key 写
  // field overlay；即使新 task 的 row 还没 publish，后续 query 也会合并这份 overlay。
  setTaskQueryCacheUnreadOverlay(targetTask, optimisticUnreadAt);
  // 兼容 Dock badge 的迁移期投影；侧栏蓝点的事实源仍只有 query row unreadAt。
  store.setTaskUnreadIndicator(event.workspacePath, taskId, true, event.workspaceIdentity);
  void service
    .setTaskUnread({
      ...targetTask,
      unread: true,
    })
    .then((meta) => {
      // 服务端先更新 tasks-index 再回包；只对账 unreadAt 字段，禁止整份 meta
      // 覆盖 sessions-index activity，避免后台完成或未读写入改变 Updated 排序。
      const committedUnreadAt = meta.unreadAt ?? optimisticUnreadAt;
      reconcileTaskQueryCacheUnread(targetTask, committedUnreadAt);
      store.setTaskUnreadIndicator(event.workspacePath, taskId, true, event.workspaceIdentity);
    })
    .catch((error: unknown) => {
      // 持久化失败时不能留下 renderer-only 假未读。恢复提交前字段，
      // 再标脏精确 workspace，让下一轮 membership join 回到 tasks-index 事实。
      rollbackTaskQueryCacheUnread(targetTask, previousUnreadAt);
      store.setTaskUnreadIndicator(
        event.workspacePath,
        taskId,
        previousLegacyUnread,
        event.workspaceIdentity,
      );
      markTaskQueryCacheScopesStale([targetTask]);
      bumpTaskListMembershipVersion();
      logger.warn(
        "[taskStatusUnreadSync] 持久化后台终态未读失败",
        {
          taskId,
          workspaceIdentity: event.workspaceIdentity ?? null,
          workspacePath: event.workspacePath,
        },
        error,
      );
    });
}
