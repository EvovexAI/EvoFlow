import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

export const WORKSPACE_TASK_PAGE_SIZE = 5;

export type WorkspaceTaskVisibleLimitByKey = Record<string, number>;

export function resolveVisibleWorkspaceTaskKeys(params: {
  enabled: boolean;
  expandedWorkspacePaths: ReadonlySet<string>;
  workspaces: ReadonlyArray<{ workspacePath: string; workspaceIdentity?: string }>;
}): Set<string> {
  if (!params.enabled) {
    return new Set();
  }
  return new Set(
    params.workspaces
      .filter((workspace) => params.expandedWorkspacePaths.has(workspace.workspacePath))
      .map((workspace) =>
        buildTaskWorkspaceKey(workspace.workspacePath, workspace.workspaceIdentity),
      ),
  );
}

export function resolveWorkspaceTaskVisibleLimit(
  limits: Readonly<WorkspaceTaskVisibleLimitByKey>,
  workspaceKey: string,
  pageSize = WORKSPACE_TASK_PAGE_SIZE,
): number {
  const storedLimit = limits[workspaceKey];
  return typeof storedLimit === "number" && Number.isFinite(storedLimit)
    ? Math.max(pageSize, Math.floor(storedLimit))
    : pageSize;
}

export function increaseWorkspaceTaskVisibleLimit(
  limits: Readonly<WorkspaceTaskVisibleLimitByKey>,
  workspaceKey: string,
  pageSize = WORKSPACE_TASK_PAGE_SIZE,
): WorkspaceTaskVisibleLimitByKey {
  return {
    ...limits,
    [workspaceKey]: resolveWorkspaceTaskVisibleLimit(limits, workspaceKey, pageSize) + pageSize,
  };
}

export function retainWorkspaceTaskVisibleLimits(
  limits: Readonly<WorkspaceTaskVisibleLimitByKey>,
  visibleWorkspaceKeys: ReadonlySet<string>,
): WorkspaceTaskVisibleLimitByKey {
  const entries = Object.entries(limits);
  const retainedEntries = entries.filter(([workspaceKey]) =>
    visibleWorkspaceKeys.has(workspaceKey),
  );
  if (retainedEntries.length === entries.length) {
    return limits as WorkspaceTaskVisibleLimitByKey;
  }
  return Object.fromEntries(retainedEntries);
}
