import type {
  GitBranchMutationIssueCode,
  GitBranchMutationIssue,
  GitBranchMutationResult,
  GitFileChange,
  GitHeadRefType,
} from "@zcode/shared";

interface GitDirtySectionLike {
  changes: Array<{
    path: string;
  }>;
}

interface GitDirtyDatasetsLike {
  staged: {
    sections: GitDirtySectionLike[];
  };
  unstaged: {
    sections: GitDirtySectionLike[];
  };
}

export interface GitBranchCommitPreviewFile {
  stagePath: string;
  repoRelativePath: string;
  workspaceRelativePath: string;
  kind: GitFileChange["kind"];
  added: number;
  removed: number;
}

export function getGitDirtyFileCount(datasets: GitDirtyDatasetsLike): number {
  const dirtyPaths = new Set<string>();
  for (const dataset of [datasets.unstaged, datasets.staged]) {
    for (const section of dataset.sections) {
      for (const change of section.changes) {
        dirtyPaths.add(change.path);
      }
    }
  }

  return dirtyPaths.size;
}

export function resolveGitBranchTriggerLabel(options: {
  headRefType: GitHeadRefType;
  currentBranchName: string | null;
  detachedLabel: string;
  fallbackLabel: string;
}): string {
  if (options.headRefType === "detached") {
    return options.detachedLabel;
  }

  const normalizedBranchName = options.currentBranchName?.trim() ?? "";
  return normalizedBranchName.length > 0 ? normalizedBranchName : options.fallbackLabel;
}

export function matchesGitBranchSearch(branchName: string, searchText: string): boolean {
  const normalizedSearchText = searchText.trim().toLocaleLowerCase();
  if (normalizedSearchText.length === 0) {
    return true;
  }

  return branchName.trim().toLocaleLowerCase().includes(normalizedSearchText);
}

export function getPrimaryGitBranchIssue(
  issues: readonly GitBranchMutationIssue[],
): GitBranchMutationIssue | null {
  return issues[0] ?? null;
}

export function isGitBranchCommitAssistIssue(
  code: GitBranchMutationIssueCode | undefined,
): boolean {
  return (
    code === "tracked-changes-would-be-overwritten" ||
    code === "untracked-changes-would-be-overwritten"
  );
}

export function resolveGitBranchIssueMessageId(
  issue: GitBranchMutationIssue | null,
): string | null {
  switch (issue?.code) {
    case "invalid-branch-name":
      return "git.branchSwitcher.error.invalidBranchName";
    case "branch-already-exists":
      return "git.branchSwitcher.error.branchAlreadyExists";
    case "target-branch-not-found":
      return "git.branchSwitcher.error.targetBranchNotFound";
    case "tracked-changes-would-be-overwritten":
      return "git.branchSwitcher.error.trackedOverwrite";
    case "untracked-changes-would-be-overwritten":
      return "git.branchSwitcher.error.untrackedOverwrite";
    case "conflicts-present":
      return "git.branchSwitcher.error.conflictsPresent";
    case "operation-in-progress":
      return "git.branchSwitcher.error.operationInProgress";
    case "branch-in-other-worktree":
      return "git.branchSwitcher.error.branchInOtherWorktree";
    default:
      return null;
  }
}

export function resolveGitBranchSuccessMessageId(
  result: Pick<GitBranchMutationResult, "action" | "created" | "didChange">,
): string | null {
  if (!result.didChange) {
    return null;
  }

  if (result.action === "create-and-switch" || result.created) {
    return "git.branchSwitcher.toast.createSuccess";
  }

  return "git.branchSwitcher.toast.switchSuccess";
}

export function summarizeGitBranchIssuePaths(
  paths: readonly string[] | undefined,
  limit = 2,
): {
  visiblePaths: string[];
  remainingCount: number;
} {
  const normalizedPaths = (paths ?? []).filter((path) => path.trim().length > 0);
  return {
    visiblePaths: normalizedPaths.slice(0, limit),
    remainingCount: Math.max(0, normalizedPaths.length - limit),
  };
}

export function buildGitBranchCommitPreviewFiles(
  changes: readonly GitFileChange[],
): GitBranchCommitPreviewFile[] {
  const previewByRepoPath = new Map<string, GitBranchCommitPreviewFile>();

  for (const change of changes) {
    const existing = previewByRepoPath.get(change.repoRelativePath);
    if (!existing) {
      previewByRepoPath.set(change.repoRelativePath, {
        stagePath: change.path,
        repoRelativePath: change.repoRelativePath,
        workspaceRelativePath: change.workspaceRelativePath,
        kind: change.kind,
        added: change.added,
        removed: change.removed,
      });
      continue;
    }

    previewByRepoPath.set(change.repoRelativePath, {
      ...existing,
      // 关键业务逻辑：同一个文件可能同时出现在 staged / unstaged。
      // 这里把增删行数聚合后再展示，避免阻塞卡片和提交弹窗看到两条重复记录。
      added: existing.added + change.added,
      removed: existing.removed + change.removed,
      kind: existing.kind === change.kind ? existing.kind : "modified",
    });
  }

  return Array.from(previewByRepoPath.values()).sort((left, right) =>
    left.repoRelativePath.localeCompare(right.repoRelativePath),
  );
}

export function getGitBranchCommitTotals(files: readonly GitBranchCommitPreviewFile[]): {
  fileCount: number;
  totalAdded: number;
  totalRemoved: number;
} {
  return files.reduce(
    (result, file) => {
      result.fileCount += 1;
      result.totalAdded += file.added;
      result.totalRemoved += file.removed;
      return result;
    },
    {
      fileCount: 0,
      totalAdded: 0,
      totalRemoved: 0,
    },
  );
}

export function selectGitBranchAffectedFiles(options: {
  files: readonly GitBranchCommitPreviewFile[];
  issuePaths: readonly string[] | undefined;
}): GitBranchCommitPreviewFile[] {
  const fileByRepoPath = new Map(
    options.files.map((file) => [file.repoRelativePath, file] as const),
  );
  const normalizedIssuePaths = (options.issuePaths ?? []).filter((path) => path.trim().length > 0);

  return normalizedIssuePaths.map(
    (repoRelativePath) =>
      fileByRepoPath.get(repoRelativePath) ?? {
        stagePath: repoRelativePath,
        repoRelativePath,
        workspaceRelativePath: repoRelativePath,
        kind: "modified",
        added: 0,
        removed: 0,
      },
  );
}

export function buildGitBranchAutoCommitMessage(targetBranchName: string): string {
  const normalizedBranchName = targetBranchName.trim();
  return normalizedBranchName.length > 0
    ? `chore: checkpoint before switching to ${normalizedBranchName}`
    : "chore: checkpoint before switching branches";
}
