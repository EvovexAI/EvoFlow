import { useMemo } from "react";
import {
  addDeletedGitStatusRowsToWorkspaceFileTree,
  flattenWorkspaceFileTreeRows,
  type WorkspaceFileGitStatus,
  type WorkspaceFileTreeNode,
} from "@/workspace-file-tree/model.js";

export function useWorkspaceFileTreeRows({
  workspacePath,
  childrenByDirectory,
  expandedPaths,
  loadedDirectoryPaths,
  loadingDirectoryPaths,
  errorByDirectory,
  gitStatusByPath,
}: {
  workspacePath: string;
  childrenByDirectory: Map<string, WorkspaceFileTreeNode[]>;
  expandedPaths: Set<string>;
  loadedDirectoryPaths: Set<string>;
  loadingDirectoryPaths: Set<string>;
  errorByDirectory: Map<string, Error>;
  gitStatusByPath: Map<string, WorkspaceFileGitStatus>;
}) {
  return useMemo(() => {
    const childrenWithGitOnlyRows = addDeletedGitStatusRowsToWorkspaceFileTree({
      rootPath: workspacePath,
      childrenByDirectory,
      statusByPath: gitStatusByPath,
    });

    return flattenWorkspaceFileTreeRows({
      rootPath: workspacePath,
      childrenByDirectory: childrenWithGitOnlyRows,
      expandedPaths,
      loadedDirectoryPaths,
      loadingDirectoryPaths,
      errorByDirectory,
      flattenEmptyDirectories: true,
    });
  }, [
    childrenByDirectory,
    errorByDirectory,
    expandedPaths,
    gitStatusByPath,
    loadedDirectoryPaths,
    loadingDirectoryPaths,
    workspacePath,
  ]);
}
