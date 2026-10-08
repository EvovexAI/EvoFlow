import type { IGitService } from "@zcode/services";
import {
  buildWorkspaceFileGitStatusByPath,
  isWorkspaceFileTreeGitStatusAvailable,
  type WorkspaceFileGitStatus,
} from "@/workspace-file-tree/model.js";

interface WorkspaceFileTreeGitStatusState {
  available: boolean;
  statusByPath: Map<string, WorkspaceFileGitStatus>;
}

export async function loadWorkspaceFileTreeGitStatus(params: {
  gitService: IGitService;
  workspacePath: string;
}): Promise<WorkspaceFileTreeGitStatusState> {
  const gitRefresh = await params.gitService.refresh({
    workspacePath: params.workspacePath,
  });
  const available = isWorkspaceFileTreeGitStatusAvailable(gitRefresh.summary);

  return {
    available,
    statusByPath: available
      ? buildWorkspaceFileGitStatusByPath([
          ...gitRefresh.unstagedChanges,
          ...gitRefresh.stagedChanges,
        ])
      : new Map(),
  };
}
