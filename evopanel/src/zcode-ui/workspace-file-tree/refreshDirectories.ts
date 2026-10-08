import { isWorkspaceFilePathInside } from "@/workspace-file-tree/model.js";

export function getWorkspaceFileTreeRefreshDirectoryPaths({
  workspacePath,
  expandedPaths,
  loadedDirectoryPaths,
}: {
  workspacePath: string;
  expandedPaths: ReadonlySet<string>;
  loadedDirectoryPaths: ReadonlySet<string>;
}): string[] {
  const refreshPaths: string[] = [];
  const seenPaths = new Set<string>();
  const addRefreshPath = (path: string) => {
    if (!isWorkspaceFilePathInside(workspacePath, path) || seenPaths.has(path)) {
      return;
    }
    seenPaths.add(path);
    refreshPaths.push(path);
  };

  addRefreshPath(workspacePath);
  for (const path of loadedDirectoryPaths) {
    addRefreshPath(path);
  }
  for (const path of expandedPaths) {
    addRefreshPath(path);
  }

  return refreshPaths;
}
