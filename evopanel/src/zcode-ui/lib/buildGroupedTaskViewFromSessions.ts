// Grouped 客户端投影：服务端回原始分组结构，tasks-index task rows 决定持久行，
// sessions-index 只补实时 activity/detail，最终拼出旧 ZCodeGroupedTaskView 同形结果。
// 排序语义对齐 taskIndexRepo.queryGroupedTaskView，但服务端的懒补序（normalize* 写回 sqlite）
// 改为只读的内存补序：缺 sort_order 的成员/顶层节点按同样规则（added_at / createdAt 降序，
// max+STEP 递增）派生展示序，不落库；用户拖拽保存时 applyGroupedTaskViewOrder 会全量持久化。
import type {
  ZCodeGroupedTaskView,
  ZCodeGroupedTaskViewNode,
  ZCodeGroupedTaskViewStructure,
  ZCodeGroupedTaskViewStructureMember,
  ZCodeTaskListItem,
} from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { mergeTaskIndexRowsWithSessions } from "@/v4/buildTaskListResultFromSessions.js";

// 与 taskIndexRepo GROUPED_TASK_ORDER_STEP 对齐。
const GROUPED_TASK_ORDER_STEP = 1000;

function memberTaskKey(params: { workspaceKey: string; taskId: string }): string {
  return `${params.workspaceKey}\u0000${params.taskId}`;
}

function taskKeyOf(task: ZCodeTaskMeta): string {
  return memberTaskKey({
    workspaceKey: buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity),
    taskId: task.taskId,
  });
}

/** 与 taskIndexRepo.taskOrderNodeKey 对齐（node_key = JSON.stringify([workspaceKey, taskId]）。 */
function taskOrderMapKey(task: ZCodeTaskMeta): string {
  return `task:${JSON.stringify([
    buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity),
    task.taskId,
  ])}`;
}

function nodeMapKey(node: ZCodeGroupedTaskViewNode): string {
  return node.type === "group" ? `group:${node.group.id}` : taskOrderMapKey(node.task);
}

function compareGroupedNodes(
  left: ZCodeGroupedTaskViewNode,
  right: ZCodeGroupedTaskViewNode,
): number {
  const leftOrder = left.sortOrder ?? 0;
  const rightOrder = right.sortOrder ?? 0;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return nodeMapKey(left).localeCompare(nodeMapKey(right));
}

/** 组内成员排序：已有 sort_order 用之；缺失的按 added_at 降序在 max 后补内存序。 */
function sortGroupTasks(
  tasks: ZCodeTaskListItem[],
  membersByTaskKey: Map<string, ZCodeGroupedTaskViewStructureMember>,
): ZCodeTaskListItem[] {
  const resolvedOrderByTaskKey = new Map<string, number>();
  let maxOrder = 0;
  const missing: Array<{ task: ZCodeTaskListItem; addedAt: number; key: string }> = [];
  for (const task of tasks) {
    const key = taskKeyOf(task);
    const member = membersByTaskKey.get(key);
    if (member && member.sortOrder !== null) {
      resolvedOrderByTaskKey.set(key, member.sortOrder);
      maxOrder = Math.max(maxOrder, member.sortOrder);
    } else {
      missing.push({ task, addedAt: member?.addedAt ?? task.createdAt, key });
    }
  }
  missing.sort((left, right) => {
    if (right.addedAt !== left.addedAt) {
      return right.addedAt - left.addedAt;
    }
    return left.key.localeCompare(right.key);
  });
  let nextOrder = maxOrder;
  for (const entry of missing) {
    nextOrder += GROUPED_TASK_ORDER_STEP;
    resolvedOrderByTaskKey.set(entry.key, nextOrder);
  }
  return [...tasks].sort((left, right) => {
    const leftOrder = resolvedOrderByTaskKey.get(taskKeyOf(left)) ?? 0;
    const rightOrder = resolvedOrderByTaskKey.get(taskKeyOf(right)) ?? 0;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return taskKeyOf(left).localeCompare(taskKeyOf(right));
  });
}

interface BuildGroupedTaskViewParams {
  structure: ZCodeGroupedTaskViewStructure;
  /** tasks-index active/pinned/archived 三个持久分区的 task 行并集。 */
  taskIndexItems: ZCodeTaskMeta[];
  /** sessions-index 派生的会话 activity/detail，只 enrich 命中的持久行。 */
  sessions: ZCodeTaskMeta[];
  /** 服务端权威 pin/archive id 集（grouped 视图口径 = 非 pinned 非 archived）。 */
  pinnedIds: ReadonlySet<string>;
  archivedIds: ReadonlySet<string>;
  /** tasks-index 持久删除 tombstone；优先于所有 task row/session detail。 */
  deletedIds?: ReadonlySet<string>;
}

/** 客户端 join：分组结构 + task rows + session details → 与旧 listGroupedTaskView 同形的视图。 */
export function buildGroupedTaskViewFromSessions(
  params: BuildGroupedTaskViewParams,
): ZCodeGroupedTaskView {
  const { structure } = params;
  const activeTaskByKey = new Map<string, ZCodeTaskListItem>();
  const taskRows = mergeTaskIndexRowsWithSessions({
    taskIndexItems: params.taskIndexItems,
    sessions: params.sessions,
  });
  for (const task of taskRows) {
    // sessions-index 仍可能保留 deleted session；deleted 是所有 grouped
    // membership 之前的负向 guard，不能依赖 archivedIds 缺失来推断它仍是普通任务。
    if (params.deletedIds?.has(task.taskId)) {
      continue;
    }
    if (params.pinnedIds.has(task.taskId) || params.archivedIds.has(task.taskId)) {
      continue;
    }
    activeTaskByKey.set(taskKeyOf(task), task);
  }

  const membersByTaskKey = new Map(
    structure.members.map((member) => [memberTaskKey(member), member]),
  );
  const membersByGroupId = new Map<string, ZCodeGroupedTaskViewStructureMember[]>();
  for (const member of structure.members) {
    const groupMembers = membersByGroupId.get(member.groupId) ?? [];
    groupMembers.push(member);
    membersByGroupId.set(member.groupId, groupMembers);
  }
  const topOrderByMapKey = new Map<string, number>();
  for (const order of structure.topLevelOrders) {
    const mapKey =
      order.type === "group"
        ? `group:${order.groupId}`
        : `task:${JSON.stringify([order.workspaceKey, order.taskId])}`;
    topOrderByMapKey.set(mapKey, order.sortOrder);
  }

  const nodes: ZCodeGroupedTaskViewNode[] = structure.groups.map((group) => {
    const groupTasks = (membersByGroupId.get(group.id) ?? [])
      .map((member) => activeTaskByKey.get(memberTaskKey(member)))
      .filter((task): task is ZCodeTaskListItem => Boolean(task));
    const order = topOrderByMapKey.get(`group:${group.id}`);
    return {
      type: "group",
      group,
      tasks: sortGroupTasks(groupTasks, membersByTaskKey),
      ...(order !== undefined ? { sortOrder: order } : {}),
    };
  });

  for (const [taskKey, task] of activeTaskByKey) {
    // 任一组的成员（含不可见 bootstrap 组）都不出现在顶层——与服务端排除规则一致。
    if (membersByTaskKey.has(taskKey)) {
      continue;
    }
    const order = topOrderByMapKey.get(taskOrderMapKey(task));
    nodes.push({
      type: "task",
      task,
      ...(order !== undefined ? { sortOrder: order } : {}),
    });
  }

  // 顶层缺序节点内存补序（normalizeGroupedTopNodeOrders 只读版）：createdAt 降序 → max+STEP。
  const missingNodes = nodes
    .filter((node) => node.sortOrder === undefined)
    .sort((left, right) => {
      const leftCreated = left.type === "group" ? left.group.createdAt : left.task.createdAt;
      const rightCreated = right.type === "group" ? right.group.createdAt : right.task.createdAt;
      if (rightCreated !== leftCreated) {
        return rightCreated - leftCreated;
      }
      return nodeMapKey(left).localeCompare(nodeMapKey(right));
    });
  let nextSortOrder = structure.topLevelOrders.reduce(
    (max, order) => Math.max(max, order.sortOrder),
    0,
  );
  for (const node of missingNodes) {
    nextSortOrder += GROUPED_TASK_ORDER_STEP;
    node.sortOrder = nextSortOrder;
  }

  nodes.sort(compareGroupedNodes);
  return { nodes };
}
