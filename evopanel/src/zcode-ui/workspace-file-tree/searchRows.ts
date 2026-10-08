import type { WorkspaceFileEntry } from "@zcode/shared";
import {
  getWorkspaceFileAncestorDirectories,
  isWorkspaceFilePathInside,
  type WorkspaceFileTreeRow,
} from "@/workspace-file-tree/model.js";

export function createWorkspaceFileTreeRowsFromSearchEntries(
  entries: WorkspaceFileEntry[],
): WorkspaceFileTreeRow[] {
  return entries.map((entry) => ({
    path: entry.path,
    // 搜索结果来自全 workspace 索引，目录可能未在懒加载树里展开过；显示相对路径能避免多个同名 Java 类看起来无法区分。
    name: entry.relativePath,
    type: entry.type,
    depth: 0,
    expanded: false,
    loaded: false,
    loading: false,
    error: null,
  }));
}

export function getWorkspaceFileSearchDirectoryRevealPaths({
  workspacePath,
  directoryPath,
}: {
  workspacePath: string;
  directoryPath: string;
}): string[] {
  if (!isWorkspaceFilePathInside(workspacePath, directoryPath)) {
    return [];
  }

  return [...getWorkspaceFileAncestorDirectories(workspacePath, directoryPath), directoryPath];
}
