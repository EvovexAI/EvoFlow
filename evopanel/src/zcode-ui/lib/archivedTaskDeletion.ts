import type { IZCodeTaskService } from "@zcode/services";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { logger } from "@/logger.js";

export interface ArchivedTaskDeletionTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}

export interface ArchivedTaskDeletionWorkspace {
  workspacePath: string;
  workspaceIdentity?: string;
  label: string;
  service?: Pick<IZCodeTaskService, "listArchivedTasks" | "deleteArchivedTasks">;
}

export async function collectArchivedTaskDeletion(workspaces: ArchivedTaskDeletionWorkspace[]) {
  const unique = new Map(
    workspaces.map((workspace) => [
      buildTaskWorkspaceKey(workspace.workspacePath, workspace.workspaceIdentity),
      workspace,
    ]),
  );
  const results = await Promise.all(
    [...unique.values()].map(async (workspace) => {
      if (!workspace.service) return { workspace, targets: null };
      try {
        // 直接读取完整归档集合，不能使用 UI 已折叠或过滤的 items。
        const tasks = await workspace.service.listArchivedTasks({
          workspacePath: workspace.workspacePath,
          workspaceIdentity: workspace.workspaceIdentity,
        });
        const targets = [...new Set(tasks.map((task) => task.taskId))].map((taskId) => ({
          taskId,
          workspacePath: workspace.workspacePath,
          workspaceIdentity: workspace.workspaceIdentity,
        }));
        return { workspace, targets };
      } catch (error) {
        logger.warn("[ArchivedTaskDeletion] 读取归档项目失败", {
          workspaceKey: buildTaskWorkspaceKey(workspace.workspacePath, workspace.workspaceIdentity),
          error,
        });
        return { workspace, targets: null };
      }
    }),
  );
  return {
    groups: results.filter((result) => result.targets !== null),
    count: results.reduce((count, result) => count + (result.targets?.length ?? 0), 0),
    unavailableWorkspaces: results
      .filter((result) => result.targets === null)
      .map((result) => result.workspace.label),
  };
}

export async function deleteArchivedTaskSelection(
  selection: Awaited<ReturnType<typeof collectArchivedTaskDeletion>>,
  onDeleted: (target: ArchivedTaskDeletionTarget) => void,
) {
  let deleted = 0;
  let skipped = 0;
  let failed = 0;
  // 同一 workspace 一次 RPC，让原 source 在逐项事务后统一发事件；独立 source 可以并行。
  await Promise.all(
    selection.groups.map(async ({ workspace, targets }) => {
      if (!targets?.length) return;
      let result: Awaited<ReturnType<IZCodeTaskService["deleteArchivedTasks"]>>;
      try {
        result = await workspace.service!.deleteArchivedTasks({
          workspacePath: workspace.workspacePath,
          workspaceIdentity: workspace.workspaceIdentity,
          taskIds: targets.map((target) => target.taskId),
        });
      } catch (error) {
        failed += targets.length;
        logger.warn("[ArchivedTaskDeletion] 工作区批次删除失败", {
          workspacePath: workspace.workspacePath,
          workspaceIdentity: workspace.workspaceIdentity,
          error,
        });
        return;
      }
      const deletedIds = new Set(result.deletedTaskIds);
      const skippedIds = new Set(result.skippedTaskIds);
      for (const target of targets) {
        if (deletedIds.has(target.taskId)) {
          deleted += 1;
          onDeleted(target);
        } else if (skippedIds.has(target.taskId)) {
          skipped += 1;
        } else {
          failed += 1;
        }
      }
    }),
  );
  return { deleted, skipped, failed, unavailableWorkspaces: selection.unavailableWorkspaces };
}
