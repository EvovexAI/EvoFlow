import type { ZCodeTaskMeta } from "@zcode/shared";
import type { TaskNavEntry } from "@/lib/taskNavigationHistory.js";
import type { TaskEntityKey } from "@/lib/taskQueryCache.js";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";

export function taskNavigationTargetExists(params: {
  entry: TaskNavEntry;
  visibleTasks: readonly Pick<ZCodeTaskMeta, "taskId">[];
  taskMetaByEntityKey: Record<TaskEntityKey, ZCodeTaskMeta>;
}): boolean {
  if (params.visibleTasks.some((task) => task.taskId === params.entry.taskId)) {
    return true;
  }

  const cachedTask = params.taskMetaByEntityKey[buildTaskEntityKey(params.entry)];
  if (!cachedTask) {
    return false;
  }

  // 任务列表迁到 task query cache 后，旧 taskListCache 可能为空。
  // 后退/前进不能只看旧 visibleTasks，否则会把真实存在的历史目标误删，表现成按钮点了没反应。
  return cachedTask.taskId === params.entry.taskId;
}
