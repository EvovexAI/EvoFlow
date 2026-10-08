import type {
  GitBranchMutationResult,
  GitChangeKind,
  GitCommitGraphCommit,
  GitDiffQuery,
  GitDiffResult,
  GitIdentity,
  GitLocalBranchListResult,
  GitPushResult,
  GitRepositorySummary,
  GitWorkspaceRepositoryInfo,
} from "@zcode/shared";

export interface GitLineStat {
  added: number;
  removed: number;
  kind?: GitChangeKind;
  originalPath?: string | null;
}

export interface GitStatusEntry {
  path: string;
  originalPath: string | null;
  kind: GitChangeKind;
  x: string | null;
  y: string | null;
  isUntracked: boolean;
  isConflicted: boolean;
}

export interface GitBranchComparisonChange {
  path: string;
  originalPath: string | null;
  kind: GitChangeKind;
  added: number;
  removed: number;
}

export interface GitResolvedRepository {
  workspacePath: string;
  repoRoot: string;
  workspaceInRepoPath: string;
  autoRefreshWatchPaths: GitRepositorySummary["autoRefreshWatchPaths"];
  isGitAvailable: boolean;
  isRepository: boolean;
}

export interface GitStatusSnapshot {
  resolution: GitResolvedRepository;
  summary: GitRepositorySummary;
  entries: GitStatusEntry[];
  stagedStats: Map<string, GitLineStat>;
  unstagedStats: Map<string, GitLineStat>;
  untrackedStats: Map<string, GitLineStat>;
}

export interface GitBranchComparisonSnapshot {
  resolution: GitResolvedRepository;
  baseRef: string | null;
  headRef: string | null;
  comparisonLabel: string | null;
  changes: GitBranchComparisonChange[];
}

export interface GitCommitGraphSnapshot {
  resolution: GitResolvedRepository;
  commits: GitCommitGraphCommit[];
  hasMore: boolean;
}

export interface GitCliRepo {
  invalidate(workspacePath: string): void;
  resolveRepository(workspacePath: string): Promise<GitResolvedRepository>;
  getWorkspaceRepositoryInfo(workspacePath: string): Promise<GitWorkspaceRepositoryInfo>;
  getStatus(workspacePath: string): Promise<GitStatusSnapshot>;
  getCommitGraph(
    workspacePath: string,
    maxCount?: number,
    skip?: number,
  ): Promise<GitCommitGraphSnapshot>;
  getIgnoredPaths(workspacePath: string, paths: string[]): Promise<string[]>;
  listLocalBranches(workspacePath: string): Promise<GitLocalBranchListResult>;
  switchBranch(workspacePath: string, targetBranchName: string): Promise<GitBranchMutationResult>;
  createBranchAndSwitch(
    workspacePath: string,
    branchName: string,
    startPoint?: string,
  ): Promise<GitBranchMutationResult>;
  getDiff(params: GitDiffQuery): Promise<GitDiffResult>;
  getBranchComparison(workspacePath: string): Promise<GitBranchComparisonSnapshot>;
  stage(workspacePath: string, paths: string[]): Promise<void>;
  unstage(workspacePath: string, paths: string[]): Promise<void>;
  discard(workspacePath: string, paths: string[], staged: boolean): Promise<void>;
  commit(
    workspacePath: string,
    message: string,
    paths?: string[],
    options?: { stagedOnly?: boolean },
  ): Promise<{ commitHash: string }>;
  push(workspacePath: string): Promise<GitPushResult>;
  getIdentity(workspacePath: string): Promise<GitIdentity>;
}

export function createEmptySummary(resolution: GitResolvedRepository): GitRepositorySummary {
  return {
    workspacePath: resolution.workspacePath,
    repoRoot: resolution.repoRoot,
    workspaceInRepoPath: resolution.workspaceInRepoPath,
    autoRefreshWatchPaths: resolution.autoRefreshWatchPaths,
    branchName: null,
    trackingBranchName: null,
    headRefType: "branch",
    ahead: 0,
    behind: 0,
    isDirty: false,
    isGitAvailable: resolution.isGitAvailable,
    isRepository: resolution.isRepository,
  };
}
