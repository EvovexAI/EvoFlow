import type { ZCodeTaskMeta } from "@zcode/shared";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

function taskKey(
  task: Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity" | "taskId">,
): string {
  return `${buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity)}\u0000${task.taskId}`;
}

export { taskKey };
