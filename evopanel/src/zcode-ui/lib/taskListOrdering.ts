import type { ZCodeTaskMeta } from "@zcode/shared";
import { isTaskListRowActive } from "@/v4/taskListRowActivity.js";

type TaskListTimeSortBy = "created" | "updated";

interface TaskListSortableItem {
  taskId: string;
  createdAt: number;
  updatedAt: number;
}

function compareTaskListItemsByTime(
  left: TaskListSortableItem,
  right: TaskListSortableItem,
  sortBy: TaskListTimeSortBy,
): number {
  if (sortBy === "created") {
    if (right.createdAt !== left.createdAt) {
      return right.createdAt - left.createdAt;
    }
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    return right.taskId.localeCompare(left.taskId);
  }

  if (right.updatedAt !== left.updatedAt) {
    return right.updatedAt - left.updatedAt;
  }
  if (right.createdAt !== left.createdAt) {
    return right.createdAt - left.createdAt;
  }
  return right.taskId.localeCompare(left.taskId);
}

/**
 * 两层任务排序：运行任务整体置顶并按创建时间稳定排序，非运行任务再服从用户的时间偏好。
 *
 * 并发运行的原 task 与 fork child 会交替刷新 updatedAt。若 running 层仍读取
 * updatedAt（包括次级排序），每个流式/工具事件都会让两行互换位置。
 * 运行层的成员既包括回合在跑的 task，也包括挂着后台工作（如动态工作流 run）的 task：
 * 后者回合已收口但活动时间仍被后台事件推进，不进运行层就会重演同一类换位。
 */
function compareTaskListItemsWithRunningFirst<T extends TaskListSortableItem>(
  left: T,
  right: T,
  sortBy: TaskListTimeSortBy,
  isRunning: (task: T) => boolean,
): number {
  const leftRunning = isRunning(left);
  const rightRunning = isRunning(right);
  if (leftRunning !== rightRunning) {
    return leftRunning ? -1 : 1;
  }
  if (leftRunning) {
    if (right.createdAt !== left.createdAt) {
      return right.createdAt - left.createdAt;
    }
    // running 层禁止以 updatedAt 决胜；taskId 是不会随事件变化的稳定 tie-break。
    return right.taskId.localeCompare(left.taskId);
  }
  return compareTaskListItemsByTime(left, right, sortBy);
}

export function compareZCodeTaskListItems(
  left: ZCodeTaskMeta,
  right: ZCodeTaskMeta,
  sortBy: TaskListTimeSortBy,
): number {
  return compareTaskListItemsWithRunningFirst(left, right, sortBy, isTaskListRowActive);
}
