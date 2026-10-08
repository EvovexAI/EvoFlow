import type { ZCodeWorkspaceTaskListChanged } from "@zcode/shared";

type TaskListMembershipWorkspaceEventReason =
  | "task_archived"
  | "task_unarchived"
  | "task_pinned"
  | "task_unpinned";

const TASK_LIST_MEMBERSHIP_REASONS = new Set<ZCodeWorkspaceTaskListChanged["reason"]>([
  "task_archived",
  "task_unarchived",
  "task_pinned",
  "task_unpinned",
]);

function isTaskListMembershipWorkspaceEvent<
  T extends Pick<ZCodeWorkspaceTaskListChanged, "reason">,
>(
  event: T,
): event is T & {
  reason: TaskListMembershipWorkspaceEventReason;
} {
  return TASK_LIST_MEMBERSHIP_REASONS.has(event.reason);
}

/**
 * 侧栏以 tasks-index 行和 pin/archive/unread 归属为准，sessions-index 只补 detail，
 * 由 membershipVersion 驱动重拉。unread（setTaskUnread）与 rename 等走 task_meta_changed，
 * sessions-index 不携带 unread，故 task_meta_changed 也纳入归属重拉信号（低频）。
 * task_created 会增加 tasks-index 的正向行集合，必须在 task row/grouped order 提交后换代读取；
 * 不能只依赖 sessions-index detail 或旧的 query-cache 增量插入。
 * task_model_changed（切模型）与归属无关，显式排除——之前它混在 task_meta_changed
 * 里，切一次模型会全局 bump membershipVersion，所有列表实例连带重拉归属。
 */
export function shouldRefetchTaskListMembershipForWorkspaceEvent(
  event: Pick<ZCodeWorkspaceTaskListChanged, "reason">,
): boolean {
  // delete 后 sessions-index 仍可能继续发布保留在 CLI store 的 session；
  // task_deleted 必须换代 deleted tombstone join，不能只做一次 query cache 移除。
  return (
    isTaskListMembershipWorkspaceEvent(event) ||
    // 侧栏改为 tasks-index row 权威后，task_created 不再只是 session meta 事件。
    // 若不换代 membership/task-row Promise，新行虽已落 SQLite，Project 仍会持续显示旧集合。
    event.reason === "task_created" ||
    event.reason === "task_meta_changed" ||
    event.reason === "task_deleted"
  );
}
