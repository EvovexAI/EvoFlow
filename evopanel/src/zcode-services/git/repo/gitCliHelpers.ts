/* eslint-disable max-lines */
import { access, open, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  GitBranchMutationIssue,
  GitChangeKind,
  GitDiffResult,
  GitHeadRefType,
} from "@zcode/shared";
import {
  GIT_UNTRACKED_STAT_CHUNK_BYTES,
  GIT_UNTRACKED_STAT_CONCURRENCY,
  GIT_UNTRACKED_STAT_MAX_BYTES,
  normalizeGitPath,
} from "#src/git/config.js";
import type { GitCommandExecutionResult } from "../providers/gitCommandProvider.js";
import type { GitLineStat, GitResolvedRepository, GitStatusEntry } from "./gitCliTypes.js";

function toResultMessage(result: GitCommandExecutionResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exitCode=${result.exitCode ?? "null"}`;
}

function toNormalizedLines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""));
}

function extractIndentedPaths(lines: string[], headerPattern: RegExp): string[] {
  const headerIndex = lines.findIndex((line) => headerPattern.test(line.toLowerCase()));
  if (headerIndex < 0) {
    return [];
  }

  const paths: string[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }

    if (!/^\s+/.test(line)) {
      break;
    }

    const value = line.trim();
    if (value.length > 0) {
      paths.push(normalizeGitPath(value));
    }
  }

  return paths;
}

export function toInvalidBranchNameIssue(detail?: string | null): GitBranchMutationIssue {
  return {
    code: "invalid-branch-name",
    message: "Branch name is invalid.",
    detail: detail?.trim() || null,
  };
}

export function parseGitBranchMutationIssues(
  result: GitCommandExecutionResult,
): GitBranchMutationIssue[] {
  const detail = result.stderr.trim() || result.stdout.trim() || null;
  const lines = toNormalizedLines(detail ?? "");
  const normalizedDetail = detail?.toLowerCase() ?? "";

  // 分支切换是否被阻塞，最终以 Git 原生命令的真实报错为准。
  // 这里集中把常见 stderr 归一成稳定 issue code，避免 UI 直接依赖易变的原始文案。

  const trackedOverwritePaths = extractIndentedPaths(
    lines,
    /your local changes to the following files would be overwritten by (checkout|switch)/,
  );
  if (trackedOverwritePaths.length > 0) {
    return [
      {
        code: "tracked-changes-would-be-overwritten",
        message: "Tracked changes would be overwritten by switching branches.",
        paths: trackedOverwritePaths,
        detail,
      },
    ];
  }

  const untrackedOverwritePaths = extractIndentedPaths(
    lines,
    /the following untracked working tree files would be overwritten by (checkout|switch)/,
  );
  if (untrackedOverwritePaths.length > 0) {
    return [
      {
        code: "untracked-changes-would-be-overwritten",
        message: "Untracked files would be overwritten by switching branches.",
        paths: untrackedOverwritePaths,
        detail,
      },
    ];
  }

  if (normalizedDetail.includes("already exists")) {
    return [
      {
        code: "branch-already-exists",
        message: "Branch already exists.",
        detail,
      },
    ];
  }

  if (normalizedDetail.includes("invalid reference:")) {
    return [
      {
        code: "target-branch-not-found",
        message: "Target branch was not found.",
        detail,
      },
    ];
  }

  if (normalizedDetail.includes("is already used by worktree at")) {
    return [
      {
        code: "branch-in-other-worktree",
        message: "Branch is already checked out in another worktree.",
        detail,
      },
    ];
  }

  if (normalizedDetail.includes("resolve your current index first")) {
    return [
      {
        code: "conflicts-present",
        message: "Repository still has unresolved conflicts.",
        detail,
      },
    ];
  }

  if (
    /cannot switch branch while (merging|rebasing|cherry-picking|reverting|bisecting)/.test(
      normalizedDetail,
    ) ||
    normalizedDetail.includes("you have not concluded your merge") ||
    normalizedDetail.includes("rebase in progress")
  ) {
    return [
      {
        code: "operation-in-progress",
        message: "Another Git operation is still in progress.",
        detail,
      },
    ];
  }

  return [
    {
      code: "unknown",
      message: "Git could not complete the branch operation.",
      detail,
    },
  ];
}

export function ensureGitCommandSucceeded(
  label: string,
  result: GitCommandExecutionResult,
  allowedExitCodes: number[] = [0],
): GitCommandExecutionResult {
  if (result.timedOut) {
    // timeout 阈值和进程清理总耗时不是一回事；日志里同时保留两者，
    // 避免把“15s 触发超时、随后等待清理”的场景误读成真正配置了更长超时。
    const timeoutMs = result.timeoutMs ?? result.durationMs;
    const details = [`elapsed=${result.durationMs}ms`];
    if (result.timeoutElapsedMs !== undefined) {
      details.push(`killAt=${result.timeoutElapsedMs}ms`);
    }
    if (result.timeoutCloseDelayMs !== undefined) {
      details.push(`cleanup=${result.timeoutCloseDelayMs}ms`);
    }
    if (result.forceKillAttempted) {
      details.push("forceKill=true");
    }
    if (result.orphaned) {
      details.push("orphaned=true");
    }
    throw new Error(`${label} timed out after ${timeoutMs}ms (${details.join(", ")})`);
  }

  if (result.outputTruncated) {
    throw new Error(`${label} output exceeded limit`);
  }

  if (allowedExitCodes.includes(result.exitCode ?? Number.NaN)) {
    return result;
  }

  throw new Error(`${label} failed: ${toResultMessage(result)}`);
}

export function isNotRepositoryResult(result: GitCommandExecutionResult): boolean {
  const stderr = result.stderr.toLowerCase();
  return stderr.includes("not a git repository") || stderr.includes("outside repository");
}

export function isMissingWorkingDirectoryResult(result: GitCommandExecutionResult): boolean {
  const stderr = result.stderr.toLowerCase();
  return (
    (result.exitCode === -2 && stderr.includes("enoent")) ||
    stderr.includes("unable to read current working directory") ||
    stderr.includes("no such file or directory")
  );
}

function inferKindFromStatusCode(statusCode: string): GitChangeKind {
  if (statusCode === "A" || statusCode === "?") {
    return "added";
  }

  if (statusCode === "D") {
    return "deleted";
  }

  if (statusCode === "R" || statusCode === "C") {
    return "renamed";
  }

  return "modified";
}

function parseBranchAheadBehind(value: string): { ahead: number; behind: number } {
  const aheadMatch = value.match(/\+(\d+)/);
  const behindMatch = value.match(/-(\d+)/);
  return {
    ahead: aheadMatch ? Number.parseInt(aheadMatch[1]!, 10) : 0,
    behind: behindMatch ? Number.parseInt(behindMatch[1]!, 10) : 0,
  };
}

export function parseStatusPorcelain(stdout: string): {
  branchName: string | null;
  trackingBranchName: string | null;
  headRefType: GitHeadRefType;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
} {
  const records = stdout.split("\0").filter((record) => record.length > 0);
  const entries: GitStatusEntry[] = [];
  let branchName: string | null = null;
  let trackingBranchName: string | null = null;
  let headRefType: GitHeadRefType = "branch";
  let ahead = 0;
  let behind = 0;

  // `git status --porcelain=v2 -z` 的价值在于格式稳定，不受本地语言影响。
  // 这里集中做一次解析，把 branch/header/rename/unmerged 等低层细节都挡在 repo 层里。
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.startsWith("# ")) {
      if (record.startsWith("# branch.head ")) {
        const head = record.slice("# branch.head ".length);
        if (head === "(detached)") {
          branchName = null;
          headRefType = "detached";
        } else {
          branchName = head;
          headRefType = "branch";
        }
      } else if (record.startsWith("# branch.upstream ")) {
        trackingBranchName = record.slice("# branch.upstream ".length);
      } else if (record.startsWith("# branch.ab ")) {
        const parsed = parseBranchAheadBehind(record.slice("# branch.ab ".length));
        ahead = parsed.ahead;
        behind = parsed.behind;
      }
      continue;
    }

    if (record.startsWith("? ")) {
      entries.push({
        path: normalizeGitPath(record.slice(2)),
        originalPath: null,
        kind: "added",
        x: null,
        y: "?",
        isUntracked: true,
        isConflicted: false,
      });
      continue;
    }

    if (record.startsWith("1 ")) {
      const match = record.match(/^1 ([^ ]{2}) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.+)$/);
      if (!match) {
        continue;
      }

      const xy = match[1]!;
      entries.push({
        path: normalizeGitPath(match[2]!),
        originalPath: null,
        kind: inferKindFromStatusCode(xy[0] !== "." ? xy[0]! : xy[1]!),
        x: xy[0]!,
        y: xy[1]!,
        isUntracked: false,
        isConflicted: false,
      });
      continue;
    }

    if (record.startsWith("2 ")) {
      const match = record.match(/^2 ([^ ]{2}) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.+)$/);
      if (!match) {
        continue;
      }

      const originalPath = records[index + 1] ?? null;
      index += 1;
      entries.push({
        path: normalizeGitPath(match[2]!),
        originalPath: originalPath ? normalizeGitPath(originalPath) : null,
        kind: "renamed",
        x: match[1]![0]!,
        y: match[1]![1]!,
        isUntracked: false,
        isConflicted: false,
      });
      continue;
    }

    if (!record.startsWith("u ")) {
      continue;
    }

    const match = record.match(
      /^u ([^ ]{2}) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.+)$/,
    );
    if (!match) {
      continue;
    }

    entries.push({
      path: normalizeGitPath(match[2]!),
      originalPath: null,
      kind: "modified",
      x: match[1]![0]!,
      y: match[1]![1]!,
      isUntracked: false,
      isConflicted: true,
    });
  }

  return { branchName, trackingBranchName, headRefType, ahead, behind, entries };
}

function parseNumstatValue(value: string): number {
  if (value === "-") {
    return 0;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function inferKindFromNumstat(stat: GitLineStat): GitChangeKind {
  if (stat.kind) {
    return stat.kind;
  }

  if (stat.added > 0 && stat.removed === 0) {
    return "added";
  }

  if (stat.removed > 0 && stat.added === 0) {
    return "deleted";
  }

  return "modified";
}

export function parseNumstat(stdout: string): Map<string, GitLineStat> {
  const records = stdout.split("\0");
  const stats = new Map<string, GitLineStat>();

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) {
      continue;
    }

    const fields = record.split("\t");
    if (fields.length < 3) {
      continue;
    }

    const added = parseNumstatValue(fields[0]!);
    const removed = parseNumstatValue(fields[1]!);
    const pathField = fields.slice(2).join("\t");
    if (pathField.length > 0) {
      stats.set(normalizeGitPath(pathField), { added, removed });
      continue;
    }

    const originalPath = records[index + 1] ?? "";
    const renamedPath = records[index + 2] ?? "";
    index += 2;
    if (renamedPath.length === 0) {
      continue;
    }

    stats.set(normalizeGitPath(renamedPath), {
      added,
      removed,
      kind: "renamed",
      originalPath: normalizeGitPath(originalPath),
    });
  }

  return stats;
}

async function countUntrackedFileLines(absolutePath: string, buffer: Buffer): Promise<number> {
  const info = await stat(absolutePath);
  if (!info.isFile() || info.size > GIT_UNTRACKED_STAT_MAX_BYTES) return 0;

  const file = await open(absolutePath, "r");
  try {
    let totalBytes = 0;
    let newlines = 0;
    let lastByte = 10;
    while (totalBytes <= GIT_UNTRACKED_STAT_MAX_BYTES) {
      // 文件可能在 stat 后增长；实际读取也必须受预算约束，额外一字节只用于识别越界。
      const length = Math.min(buffer.length, GIT_UNTRACKED_STAT_MAX_BYTES + 1 - totalBytes);
      const { bytesRead } = await file.read(buffer, 0, length, null);
      if (bytesRead === 0) return newlines + (lastByte === 10 ? 0 : 1);
      totalBytes += bytesRead;
      if (totalBytes > GIT_UNTRACKED_STAT_MAX_BYTES) return 0;
      for (let index = 0; index < bytesRead; index++) {
        if (buffer[index] === 0) return 0;
        if (buffer[index] === 10) newlines++;
      }
      lastByte = buffer[bytesRead - 1]!;
    }
    return 0;
  } finally {
    await file.close();
  }
}

export async function buildUntrackedStats(
  repoRoot: string,
  entries: GitStatusEntry[],
): Promise<Map<string, GitLineStat>> {
  const stats = new Map<string, GitLineStat>();
  const untrackedEntries = entries.filter((entry) => entry.isUntracked);
  let nextIndex = 0;
  // 并发 readFile 全部未跟踪文件、读取后才识别二进制会让 Host 瞬间分配数 GiB。
  // 固定 worker 各复用一个小缓冲，逐文件限量读取；大文件仍保留变更条目，只跳过行数统计。
  const worker = async () => {
    const buffer = Buffer.allocUnsafe(GIT_UNTRACKED_STAT_CHUNK_BYTES);
    while (nextIndex < untrackedEntries.length) {
      const entry = untrackedEntries[nextIndex++]!;
      const absolutePath = resolve(repoRoot, ...entry.path.split("/"));
      try {
        stats.set(entry.path, {
          added: await countUntrackedFileLines(absolutePath, buffer),
          removed: 0,
        });
      } catch {
        stats.set(entry.path, { added: 0, removed: 0 });
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(GIT_UNTRACKED_STAT_CONCURRENCY, untrackedEntries.length) },
      worker,
    ),
  );

  return stats;
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function splitUntrackedText(content: string): {
  lines: string[];
  hasTrailingNewline: boolean;
} {
  const normalizedContent = content.replace(/\r\n/g, "\n");
  if (normalizedContent.length === 0) {
    return {
      lines: [],
      hasTrailingNewline: false,
    };
  }

  const hasTrailingNewline = normalizedContent.endsWith("\n");
  const lines = normalizedContent.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }

  return {
    lines,
    hasTrailingNewline,
  };
}

export async function buildUntrackedTextDiffResult(
  absolutePath: string,
  repoRelativePath: string,
  maxPreviewBytes: number,
): Promise<GitDiffResult | null> {
  try {
    const content = await readFile(absolutePath);

    // 未跟踪文件的 patch 不能依赖 `git diff --no-index` 生成。
    // 这类 patch 在 Windows 上会带入平台相关头部，而 `@pierre/diffs` 对某些 `diff --git`
    // 头部格式本身也有兼容问题，最终会在 UI 展开时直接抛异常。
    // 这里统一退回最稳定的 unified diff 形态，只保留单文件预览真正需要的 `---/+++ / @@` 信息。
    if (content.includes(0)) {
      return {
        path: absolutePath,
        availability: "binary",
        patch: null,
        beforeContent: null,
        afterContent: null,
        summary: "Binary diff is not previewable.",
      };
    }

    if (content.byteLength > maxPreviewBytes) {
      return {
        path: absolutePath,
        availability: "truncated",
        patch: null,
        beforeContent: null,
        afterContent: null,
        summary: "Git diff output exceeded the preview limit.",
      };
    }

    const normalizedPath = normalizeGitPath(repoRelativePath);
    const { lines, hasTrailingNewline } = splitUntrackedText(content.toString("utf-8"));
    const patchLines = ["--- /dev/null", `+++ b/${normalizedPath}`];

    if (lines.length > 0) {
      patchLines.push(`@@ -0,0 +1,${lines.length} @@`);
      patchLines.push(...lines.map((line) => `+${line}`));
      if (!hasTrailingNewline) {
        patchLines.push("\\ No newline at end of file");
      }
    }

    return {
      path: absolutePath,
      availability: "patch",
      patch: `${patchLines.join("\n")}\n`,
      beforeContent: "",
      afterContent: content.toString("utf-8"),
      summary: null,
    };
  } catch {
    return null;
  }
}

function isBinaryDiff(stdout: string): boolean {
  return stdout.includes("GIT binary patch") || stdout.includes("Binary files ");
}

export function toDiffResult(
  path: string,
  result: GitCommandExecutionResult,
  options?: {
    allowedExitCodes?: number[];
    emptySummary?: string;
    binarySummary?: string;
  },
): GitDiffResult {
  if (result.timedOut) {
    return {
      path,
      availability: "unavailable",
      patch: null,
      beforeContent: null,
      afterContent: null,
      summary: "Git diff command timed out.",
    };
  }

  if (result.outputTruncated) {
    return {
      path,
      availability: "truncated",
      patch: null,
      beforeContent: null,
      afterContent: null,
      summary: "Git diff output exceeded the preview limit.",
    };
  }

  const allowedExitCodes = options?.allowedExitCodes ?? [0];
  if (!allowedExitCodes.includes(result.exitCode ?? Number.NaN)) {
    return {
      path,
      availability: "unavailable",
      patch: null,
      beforeContent: null,
      afterContent: null,
      summary: toResultMessage(result),
    };
  }

  if (!result.stdout.trim()) {
    return {
      path,
      availability: "unavailable",
      patch: null,
      beforeContent: null,
      afterContent: null,
      summary: options?.emptySummary ?? "No diff output available.",
    };
  }

  if (isBinaryDiff(result.stdout)) {
    return {
      path,
      availability: "binary",
      patch: null,
      beforeContent: null,
      afterContent: null,
      summary: options?.binarySummary ?? "Binary diff is not previewable.",
    };
  }

  return {
    path,
    availability: "patch",
    patch: result.stdout,
    beforeContent: null,
    afterContent: null,
    summary: null,
  };
}

export function parseGitConfigValue(result: GitCommandExecutionResult): {
  scope: string | null;
  source: string | null;
  value: string | null;
} {
  if (result.exitCode === 1) {
    return { scope: null, source: null, value: null };
  }

  ensureGitCommandSucceeded("git config", result);
  const line = result.stdout.replace(/\r?\n$/, "");
  const parts = line.split("\t");
  if (parts.length < 3) {
    return { scope: null, source: null, value: line || null };
  }

  return {
    scope: parts[0] ?? null,
    source: parts[1] ?? null,
    value: parts.slice(2).join("\t") || null,
  };
}

export async function normalizeInputPath(
  resolution: GitResolvedRepository,
  path: string,
): Promise<string> {
  const rawAbsolutePath = isAbsolute(path)
    ? path
    : resolve(resolution.workspacePath, path.split("/").join(sep));
  const absolutePath = await realpath(rawAbsolutePath).catch(() => rawAbsolutePath);
  const repoRelativePath = normalizeGitPath(relative(resolution.repoRoot, absolutePath));
  if (
    repoRelativePath.length === 0 ||
    repoRelativePath === "." ||
    repoRelativePath === ".." ||
    repoRelativePath.startsWith("../")
  ) {
    throw new Error(`Path is outside repository scope: ${path}`);
  }

  return repoRelativePath;
}

export function ensureRepositoryAvailable(
  resolution: GitResolvedRepository,
  label: string,
): GitResolvedRepository {
  if (!resolution.isGitAvailable) {
    throw new Error(`Cannot ${label}: Git binary is not available`);
  }

  if (!resolution.isRepository) {
    throw new Error(`Cannot ${label}: workspace is not inside a Git repository`);
  }

  return resolution;
}
