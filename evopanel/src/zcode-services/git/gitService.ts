import { resolve } from "node:path";
import type { GitBranchComparison, GitFileChange, GitChangeSectionId } from "@zcode/shared";
import { isPathInWorkspaceScope, normalizeGitPath, toWorkspaceRelativeGitPath } from "./config.js";
import { filterCommitMessageFilesByCurrentSession } from "./commitMessageFileScope.js";
import type { IGitService } from "./git.js";
import type { GitCommitMessageGenerator } from "./gitCommitMessageGenerator.js";
import {
  createGitCliRepo,
  type GitBranchComparisonChange,
  type GitBranchComparisonSnapshot,
  type GitCliRepo,
  type GitStatusEntry,
  type GitStatusSnapshot,
} from "./repo/gitCliRepo.js";

function toAbsolutePath(repoRoot: string, repoRelativePath: string): string {
  return resolve(repoRoot, ...normalizeGitPath(repoRelativePath).split("/"));
}

function matchesWorkspaceScope(
  workspaceInRepoPath: string,
  entry: { path: string; originalPath: string | null },
): boolean {
  return (
    isPathInWorkspaceScope(entry.path, workspaceInRepoPath) ||
    (entry.originalPath ? isPathInWorkspaceScope(entry.originalPath, workspaceInRepoPath) : false)
  );
}

function buildFileChange(
  snapshot: GitStatusSnapshot,
  entry: GitStatusEntry,
  section: GitChangeSectionId,
  added: number,
  removed: number,
): GitFileChange {
  return {
    path: toAbsolutePath(snapshot.resolution.repoRoot, entry.path),
    repoRelativePath: entry.path,
    workspaceRelativePath: toWorkspaceRelativeGitPath(
      entry.path,
      snapshot.summary.workspaceInRepoPath,
    ),
    x: entry.x ?? undefined,
    y: entry.y ?? undefined,
    kind: entry.kind,
    section,
    added,
    removed,
    isStaged: section === "staged",
    isUntracked: section === "untracked",
    isConflicted: section === "conflicted",
  };
}

function shouldIncludeUntrackedChange(
  entry: GitStatusEntry,
  stat: { added: number; removed: number },
): boolean {
  // 构建目录里常见大量未跟踪的空文件、失效链接或不可读产物。
  // 这类条目没有可审查的文本增删，之前会以 +0/-0 挤进 Review 面板，既污染列表又拖慢打开。
  // 但详细 status 超限后，Git 会用末尾 `/` 的目录记录表达整棵未跟踪目录；它本身不可读，
  // 行数必然为 0，却仍必须作为可 stage/discard 的降级入口保留。
  return entry.path.endsWith("/") || stat.added > 0 || stat.removed > 0;
}

function toChangeForSource(
  snapshot: GitStatusSnapshot,
  entry: GitStatusEntry,
  sourceId: "unstaged" | "staged",
): GitFileChange | null {
  if (!matchesWorkspaceScope(snapshot.summary.workspaceInRepoPath, entry)) {
    return null;
  }

  if (sourceId === "staged") {
    if (entry.isUntracked || entry.isConflicted || !entry.x || entry.x === ".") {
      return null;
    }

    const stat = snapshot.stagedStats.get(entry.path) ?? {
      added: 0,
      removed: 0,
    };
    return buildFileChange(snapshot, entry, "staged", stat.added, stat.removed);
  }

  if (entry.isConflicted) {
    return buildFileChange(snapshot, entry, "conflicted", 0, 0);
  }

  if (entry.isUntracked) {
    const stat = snapshot.untrackedStats.get(entry.path) ?? {
      added: 0,
      removed: 0,
    };
    if (!shouldIncludeUntrackedChange(entry, stat)) {
      return null;
    }
    return buildFileChange(snapshot, entry, "untracked", stat.added, stat.removed);
  }

  if (!entry.y || entry.y === ".") {
    return null;
  }

  const stat = snapshot.unstagedStats.get(entry.path) ?? {
    added: 0,
    removed: 0,
  };
  return buildFileChange(snapshot, entry, "unstaged", stat.added, stat.removed);
}

function getChangesForSource(
  snapshot: GitStatusSnapshot,
  sourceId: "unstaged" | "staged",
): GitFileChange[] {
  return snapshot.entries
    .map((entry) => toChangeForSource(snapshot, entry, sourceId))
    .filter((entry): entry is GitFileChange => Boolean(entry));
}

function toBranchComparisonChange(
  snapshot: GitBranchComparisonSnapshot,
  change: GitBranchComparisonChange,
): GitFileChange | null {
  if (!matchesWorkspaceScope(snapshot.resolution.workspaceInRepoPath, change)) {
    return null;
  }

  return {
    path: toAbsolutePath(snapshot.resolution.repoRoot, change.path),
    repoRelativePath: change.path,
    workspaceRelativePath: toWorkspaceRelativeGitPath(
      change.path,
      snapshot.resolution.workspaceInRepoPath,
    ),
    kind: change.kind,
    section: "branch",
    added: change.added,
    removed: change.removed,
    isStaged: false,
    isUntracked: false,
    isConflicted: false,
  };
}

const COMMIT_MESSAGE_DIFF_FILE_LIMIT = 8;

function getCommitMessageDiffQueries(
  files: readonly GitFileChange[],
  includeUnstaged: boolean,
): Array<{ path: string; sourceId: "unstaged" | "staged" }> {
  const queries: Array<{ path: string; sourceId: "unstaged" | "staged" }> = [];
  for (const file of files.slice(0, COMMIT_MESSAGE_DIFF_FILE_LIMIT)) {
    if (file.section === "staged") {
      queries.push({ path: file.path, sourceId: "staged" });
      continue;
    }

    if (!includeUnstaged) {
      continue;
    }

    queries.push({ path: file.path, sourceId: "unstaged" });
  }
  return queries;
}

export function createGitService(options?: {
  repo?: GitCliRepo;
  commitMessageGenerator?: GitCommitMessageGenerator;
}): IGitService {
  const repo = options?.repo ?? createGitCliRepo();

  return {
    async getRepositorySummary(params) {
      const status = await repo.getStatus(params.workspacePath);
      return status.summary;
    },

    async getWorkspaceRepositoryInfo(params) {
      return await repo.getWorkspaceRepositoryInfo(params.workspacePath);
    },

    async getLocalBranches(params) {
      return await repo.listLocalBranches(params.workspacePath);
    },

    async getCommitGraph(params) {
      const snapshot = await repo.getCommitGraph(
        params.workspacePath,
        params.maxCount,
        params.skip,
      );
      return {
        commits: snapshot.commits,
        hasMore: snapshot.hasMore,
      };
    },

    async switchBranch(params) {
      return await repo.switchBranch(params.workspacePath, params.targetBranchName);
    },

    async createBranchAndSwitch(params) {
      return await repo.createBranchAndSwitch(
        params.workspacePath,
        params.branchName,
        params.startPoint,
      );
    },

    async getChanges(params) {
      const status = await repo.getStatus(params.workspacePath);

      // workspace 可以是 monorepo 子目录，所以这里统一在 service 层按作用域裁剪。
      // 这样 repo 继续只负责“把 Git 原始状态解析出来”，上层则始终拿到符合当前 workspace 边界的数据。
      return getChangesForSource(status, params.sourceId);
    },

    async getIgnoredPaths(params) {
      return await repo.getIgnoredPaths(params.workspacePath, params.paths);
    },

    async getDiff(params) {
      return await repo.getDiff(params);
    },

    async getBranchComparison(params): Promise<GitBranchComparison> {
      const comparison = await repo.getBranchComparison(params.workspacePath);
      return {
        baseRef: comparison.baseRef,
        headRef: comparison.headRef,
        comparisonLabel: comparison.comparisonLabel,
        changes: comparison.changes
          .map((change) => toBranchComparisonChange(comparison, change))
          .filter((change): change is GitFileChange => Boolean(change)),
      };
    },

    async stagePaths(params) {
      await repo.stage(params.workspacePath, params.paths);
    },

    async unstagePaths(params) {
      await repo.unstage(params.workspacePath, params.paths);
    },

    async discardPaths(params) {
      await repo.discard(params.workspacePath, params.paths, params.staged ?? false);
    },

    async generateCommitMessage(params) {
      if (!options?.commitMessageGenerator) {
        throw new Error("Commit message generation is not available.");
      }

      const includeUnstaged = (params as { includeUnstaged?: boolean }).includeUnstaged ?? true;
      const status = await repo.getStatus(params.workspacePath);
      const unstagedChanges = includeUnstaged ? getChangesForSource(status, "unstaged") : [];
      const stagedChanges = getChangesForSource(status, "staged");
      const files = filterCommitMessageFilesByCurrentSession({
        files: [...unstagedChanges, ...stagedChanges],
        workspacePath: params.workspacePath,
        repoRoot: status.resolution.repoRoot,
        workspaceInRepoPath: status.resolution.workspaceInRepoPath,
        currentSessionFilePaths: params.currentSessionFilePaths,
      });
      if (files.length === 0) {
        throw new Error("There are no changes available to commit.");
      }

      const diffQueries = getCommitMessageDiffQueries(files, includeUnstaged);
      const diffResults = await Promise.allSettled(
        diffQueries.map((query) =>
          repo.getDiff({
            workspacePath: params.workspacePath,
            path: query.path,
            sourceId: query.sourceId,
          }),
        ),
      );
      const diffs = diffResults.flatMap((result) =>
        result.status === "fulfilled" && (result.value.patch || result.value.summary)
          ? [result.value]
          : [],
      );

      return await options.commitMessageGenerator.generate({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        ...(params.locale ? { locale: params.locale } : {}),
        branchName: status.summary.branchName,
        files,
        diffs,
        ...(params.conversationContext ? { conversationContext: params.conversationContext } : {}),
      });
    },

    async commit(params) {
      const result = await repo.commit(params.workspacePath, params.message, params.paths, {
        stagedOnly: params.stagedOnly,
      });
      const status = await repo.getStatus(params.workspacePath);
      return {
        commitHash: result.commitHash,
        summary: status.summary,
      };
    },

    async push(params) {
      const result = await repo.push(params.workspacePath);
      return result;
    },

    async getIdentity(params) {
      return await repo.getIdentity(params.workspacePath);
    },

    async refresh(params) {
      const statusPromise = repo.getStatus(params.workspacePath);
      const identityPromise = params.includeIdentity
        ? repo.getIdentity(params.workspacePath)
        : Promise.resolve(null);
      const branchComparisonPromise = params.includeBranchComparison
        ? repo.getBranchComparison(params.workspacePath)
        : Promise.resolve(null);
      const [status, identity, branchComparisonSnapshot] = await Promise.all([
        statusPromise,
        identityPromise,
        branchComparisonPromise,
      ]);
      const branchComparison: GitBranchComparison | null = branchComparisonSnapshot
        ? {
            baseRef: branchComparisonSnapshot.baseRef,
            headRef: branchComparisonSnapshot.headRef,
            comparisonLabel: branchComparisonSnapshot.comparisonLabel,
            changes: branchComparisonSnapshot.changes
              .map((change) => toBranchComparisonChange(branchComparisonSnapshot, change))
              .filter((change): change is GitFileChange => Boolean(change)),
          }
        : null;

      // UI 的自动刷新原本会并发调用 summary、unstaged、staged 三个 RPC，
      // 每个 RPC 都重新执行一次 git status。agent 批量写文件时这会把 renderer 卡在
      // 重复的 Git I/O 和 RPC 日志上。refresh 在一次 status 快照里切出三份数据。
      return {
        summary: status.summary,
        identity,
        unstagedChanges: getChangesForSource(status, "unstaged"),
        stagedChanges: getChangesForSource(status, "staged"),
        branchComparison,
      };
    },
  };
}
