// 左侧列表投影：tasks-index 决定持久行集合与 membership，sessions-index 只补实时 activity/detail。
// 这里保持纯函数，供 Project/Timeline/Pinned/Archived/Grouped 共用同一字段权威。
import type { ZCodeTaskMeta } from "@zcode/shared";
import { matchesTaskListMembershipKind } from "@zcode/shared/zcode-protocol-v4";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";
import { compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import { attachTaskListRowActivity, getTaskListRowActivity } from "@/v4/taskListRowActivity.js";

type TaskListKind = "pinned" | "archived" | "timeline" | "active";
type TaskListSortBy = "created" | "updated";

interface BuildTaskListParams {
  /** tasks-index active/pinned/archived 三个持久分区的 task 行并集。 */
  taskIndexItems: ZCodeTaskMeta[];
  /** sessions-index 派生的会话 activity/detail；只覆盖命中的持久行。 */
  sessions: ZCodeTaskMeta[];
  kind: TaskListKind;
  /** 服务端权威 pin/archive id 集（tasks-index.sqlite 持久化）。 */
  pinnedIds: ReadonlySet<string>;
  archivedIds: ReadonlySet<string>;
  /** tasks-index 持久删除 tombstone；命中后不属于任何列表 kind。 */
  deletedIds?: ReadonlySet<string>;
  search?: string;
  sortBy: TaskListSortBy;
  /** 折叠上限；undefined = 全量（expanded）。 */
  limit?: number;
  /**
   * taskId → unreadAt（tasks-index 组织态，与 pin/archive 同源平行拉取）。
   * sessions-index schema 冻结不携带 unread，这里在列表构建时 join 进 meta。
   */
  unreadAtByTaskId?: ReadonlyMap<string, number>;
  /** taskId → terminal status（tasks-index 历史终态；只补冷启动 stored summary）。 */
  terminalStatusByTaskId?: ReadonlyMap<
    string,
    Extract<ZCodeTaskMeta["status"], "completed" | "error">
  >;
  /** taskId → 旧 task-index 手动标题；只覆盖 titleOverridden!==true 的 session meta。 */
  titleOverrideByTaskId?: ReadonlyMap<string, string>;
  /** taskId -> cronAutomationId（tasks-index 元数据；SessionSummary 不携带）。 */
  cronAutomationIdByTaskId?: ReadonlyMap<string, string>;
}

interface BuildTaskListResult {
  items: ZCodeTaskMeta[];
  total: number;
}

function mergeTaskIndexRowWithSession(
  taskIndexTask: ZCodeTaskMeta,
  sessionTask: ZCodeTaskMeta,
): ZCodeTaskMeta {
  const activity = getTaskListRowActivity(sessionTask);
  const sessionTitle = sessionTask.title.trim();
  const sessionTitleWins =
    sessionTitle.length > 0 &&
    (sessionTask.titleOverridden === true || taskIndexTask.titleOverridden !== true);
  const titleOverridden =
    sessionTask.titleOverridden === true || taskIndexTask.titleOverridden === true
      ? true
      : undefined;
  const merged: ZCodeTaskMeta = {
    ...taskIndexTask,
    title: sessionTitleWins ? sessionTask.title : taskIndexTask.title,
    titleOverridden,
    // session activity 是创建/活动时间与终态的实时权威；task row 只在 summary 缺失时兜底。
    createdAt: sessionTask.createdAt || taskIndexTask.createdAt,
    updatedAt: (activity?.lastActivityAt ?? sessionTask.updatedAt) || taskIndexTask.updatedAt,
    status: sessionTask.status ?? taskIndexTask.status,
    forkedFromTaskId: sessionTask.forkedFromTaskId ?? taskIndexTask.forkedFromTaskId,
    // pending interaction 属于当前 session 投影；summary 已到达但字段为空时必须清掉旧持久值。
    pendingInteraction: sessionTask.pendingInteraction,
  };
  return activity ? attachTaskListRowActivity(merged, activity) : merged;
}

/**
 * 以 tasks-index 行为左表做字段级 join。summary 缺失时保留原 task 引用；session-only 冷摘要
 * 不会进入持久列表，新建短窗口由既有 optimistic/live overlay 负责。
 */
export function mergeTaskIndexRowsWithSessions(params: {
  taskIndexItems: ZCodeTaskMeta[];
  sessions: ZCodeTaskMeta[];
}): ZCodeTaskMeta[] {
  const sessionByEntityKey = new Map(
    params.sessions.map((session) => [buildTaskEntityKey(session), session]),
  );
  return params.taskIndexItems.map((task) => {
    const session = sessionByEntityKey.get(buildTaskEntityKey(task));
    return session ? mergeTaskIndexRowWithSession(task, session) : task;
  });
}

/** unreadAt join：map 已加载时以 tasks-index 为准，未加载时不动原 meta，避免首帧闪烁。 */
export function joinTaskListUnreadAt(
  tasks: ZCodeTaskMeta[],
  unreadAtByTaskId: ReadonlyMap<string, number> | undefined,
): ZCodeTaskMeta[] {
  return joinTaskListMembershipMeta(tasks, { unreadAtByTaskId });
}

function joinTaskListMembershipMeta(
  tasks: ZCodeTaskMeta[],
  params: {
    unreadAtByTaskId?: ReadonlyMap<string, number>;
    terminalStatusByTaskId?: ReadonlyMap<
      string,
      Extract<ZCodeTaskMeta["status"], "completed" | "error">
    >;
    titleOverrideByTaskId?: ReadonlyMap<string, string>;
    cronAutomationIdByTaskId?: ReadonlyMap<string, string>;
  },
): ZCodeTaskMeta[] {
  const {
    unreadAtByTaskId,
    terminalStatusByTaskId,
    titleOverrideByTaskId,
    cronAutomationIdByTaskId,
  } = params;
  if (
    unreadAtByTaskId === undefined &&
    (!terminalStatusByTaskId || terminalStatusByTaskId.size === 0) &&
    (!titleOverrideByTaskId || titleOverrideByTaskId.size === 0) &&
    (!cronAutomationIdByTaskId || cronAutomationIdByTaskId.size === 0)
  ) {
    return tasks;
  }
  return tasks.map((task) => {
    const activity = getTaskListRowActivity(task);
    const unreadAt = unreadAtByTaskId?.get(task.taskId);
    const terminalStatus = terminalStatusByTaskId?.get(task.taskId);
    const titleOverride =
      task.titleOverridden === true ? undefined : titleOverrideByTaskId?.get(task.taskId);
    const cronAutomationId = cronAutomationIdByTaskId?.get(task.taskId);
    const shouldUpdateUnread =
      unreadAtByTaskId !== undefined &&
      (unreadAt !== task.unreadAt || (unreadAt === undefined && task.unreadAt !== undefined));
    // v4 冷启动 stored summaries 可能还没 activity sidecar，只能从
    // tasks-index 补历史 terminal status；一旦 sessions-index 已投影 activity，所有实时终态
    // 都归它所有，不能再被旧 tasks-index 的 error/completed 反向覆盖。
    const shouldUpdateStatus =
      activity === null &&
      terminalStatus !== undefined &&
      (task.status === undefined || (terminalStatus === "error" && task.status === "completed"));
    const shouldUpdateTitle =
      titleOverride !== undefined &&
      (task.title !== titleOverride || task.titleOverridden !== true);
    const shouldUpdateCronAutomationId =
      cronAutomationId !== undefined && cronAutomationId !== task.cronAutomationId;
    if (
      !shouldUpdateUnread &&
      !shouldUpdateStatus &&
      !shouldUpdateTitle &&
      !shouldUpdateCronAutomationId
    ) {
      return task;
    }
    return {
      ...task,
      ...(shouldUpdateUnread ? { unreadAt } : {}),
      ...(shouldUpdateStatus ? { status: terminalStatus } : {}),
      ...(shouldUpdateTitle ? { title: titleOverride, titleOverridden: true } : {}),
      // sessions-index 的冻结 summary 不含 cron 身份；必须从 tasks-index join 回来，
      // 否则数据库已标记为定时任务，侧栏传给 React 的 meta 仍无法通过 isCronTask。
      ...(shouldUpdateCronAutomationId ? { cronAutomationId } : {}),
    };
  });
}

/** 客户端过滤/排序/分页，产出与旧 listTaskList 同形的 { items, total }。 */
export function buildTaskListResult(params: BuildTaskListParams): BuildTaskListResult {
  const query = params.search?.trim().toLocaleLowerCase() ?? "";
  const rows = mergeTaskIndexRowsWithSessions({
    taskIndexItems: params.taskIndexItems,
    sessions: params.sessions,
  });
  const tasks = joinTaskListMembershipMeta(rows, {
    unreadAtByTaskId: params.unreadAtByTaskId,
    terminalStatusByTaskId: params.terminalStatusByTaskId,
    titleOverrideByTaskId: params.titleOverrideByTaskId,
    cronAutomationIdByTaskId: params.cronAutomationIdByTaskId,
  });
  const filtered = tasks.filter((task) => {
    // CLI session store 不会随归档列表“永久删除”一起物理清理；若不先应用
    // deleted 负向 membership，冷启动 sessions-index 会把它当成非 archived 普通任务复活。
    if (params.deletedIds?.has(task.taskId)) return false;
    const pinned = params.pinnedIds.has(task.taskId);
    const archived = params.archivedIds.has(task.taskId);
    if (!matchesTaskListMembershipKind({ pinned, archived }, params.kind)) return false;
    if (query && !task.title.toLocaleLowerCase().includes(query)) return false;
    return true;
  });
  filtered.sort((a, b) => compareZCodeTaskListItems(a, b, params.sortBy));
  const total = filtered.length;
  const items = params.limit === undefined ? filtered : filtered.slice(0, params.limit);
  return { items, total };
}
