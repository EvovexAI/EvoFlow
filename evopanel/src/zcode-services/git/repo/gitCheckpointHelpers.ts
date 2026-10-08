import { rm } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { GitCheckpointDiff, GitCheckpointFileDiff } from "@zcode/shared";
import { normalizeGitPath, toWorkspaceRelativeGitPath } from "../config.js";
import { getWorkspaceHash } from "../../paths.js";

interface GitCheckpointNameStatusEntry {
  kind: GitCheckpointFileDiff["kind"];
  path: string;
  originalPath: string | null;
}

interface GitTreeEntry {
  mode: string;
  type: string;
  objectId: string;
  path: string;
}

export function toAbsolutePath(repoRoot: string, repoRelativePath: string): string {
  return resolve(repoRoot, ...normalizeGitPath(repoRelativePath).split("/"));
}

export function getWorkspacePathspec(workspaceInRepoPath: string): string {
  return workspaceInRepoPath === "." ? "." : workspaceInRepoPath;
}

export function getCheckpointRefName(workspacePath: string, checkpointId: string): string {
  const workspaceHash = getWorkspaceHash(workspacePath);
  return `refs/zcode/checkpoints/${workspaceHash}/${checkpointId}`;
}

function mapNameStatusKind(status: string): GitCheckpointFileDiff["kind"] {
  const normalized = status[0] ?? "M";
  if (normalized === "A") {
    return "added";
  }
  if (normalized === "D") {
    return "deleted";
  }
  if (normalized === "R" || normalized === "C") {
    return "renamed";
  }
  return "modified";
}

export function parseNameStatus(stdout: string): GitCheckpointNameStatusEntry[] {
  const records = stdout.split("\0").filter((record) => record.length > 0);
  const entries: GitCheckpointNameStatusEntry[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const status = records[index]!;
    const kind = mapNameStatusKind(status);
    if (kind === "renamed") {
      const originalPath = records[index + 1] ?? null;
      const path = records[index + 2] ?? null;
      index += 2;
      if (!originalPath || !path) {
        continue;
      }
      entries.push({
        kind,
        originalPath: normalizeGitPath(originalPath),
        path: normalizeGitPath(path),
      });
      continue;
    }

    const path = records[index + 1] ?? null;
    index += 1;
    if (!path) {
      continue;
    }
    entries.push({
      kind,
      originalPath: null,
      path: normalizeGitPath(path),
    });
  }

  return entries;
}

export function parseNumstat(stdout: string): Map<string, { added: number; removed: number }> {
  const records = stdout.split("\0").filter((record) => record.length > 0);
  const stats = new Map<string, { added: number; removed: number }>();

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const fields = record.split("\t");
    if (fields.length < 3) {
      continue;
    }

    const added = fields[0] === "-" ? 0 : Number.parseInt(fields[0] ?? "0", 10) || 0;
    const removed = fields[1] === "-" ? 0 : Number.parseInt(fields[1] ?? "0", 10) || 0;
    const pathField = fields.slice(2).join("\t");
    if (pathField.length > 0) {
      stats.set(normalizeGitPath(pathField), { added, removed });
      continue;
    }

    const originalPath = records[index + 1] ?? "";
    const renamedPath = records[index + 2] ?? "";
    index += 2;
    if (!renamedPath) {
      continue;
    }
    stats.set(normalizeGitPath(renamedPath), { added, removed });
    if (originalPath) {
      stats.set(normalizeGitPath(originalPath), { added, removed });
    }
  }

  return stats;
}

export function parseLsTree(stdout: string): Map<string, GitTreeEntry> {
  const records = stdout.split("\0").filter((record) => record.length > 0);
  const entries = new Map<string, GitTreeEntry>();
  for (const record of records) {
    const tabIndex = record.indexOf("\t");
    if (tabIndex < 0) {
      continue;
    }
    const header = record.slice(0, tabIndex).split(" ");
    if (header.length < 3) {
      continue;
    }
    const path = normalizeGitPath(record.slice(tabIndex + 1));
    entries.set(path, {
      mode: header[0] ?? "100644",
      type: header[1] ?? "blob",
      objectId: header[2] ?? "",
      path,
    });
  }
  return entries;
}

export function mergeCheckpointDiff(params: {
  repoRoot: string;
  workspaceInRepoPath: string;
  fromCheckpointId: string;
  toCheckpointId: string;
  nameStatusEntries: GitCheckpointNameStatusEntry[];
  numstat: Map<string, { added: number; removed: number }>;
}): GitCheckpointDiff {
  const files: GitCheckpointFileDiff[] = params.nameStatusEntries.map((entry) => {
    const stat = params.numstat.get(entry.path) ??
      params.numstat.get(entry.originalPath ?? "") ?? {
        added: 0,
        removed: 0,
      };
    return {
      path: toAbsolutePath(params.repoRoot, entry.path),
      repoRelativePath: entry.path,
      workspaceRelativePath: toWorkspaceRelativeGitPath(entry.path, params.workspaceInRepoPath),
      originalPath: entry.originalPath ? toAbsolutePath(params.repoRoot, entry.originalPath) : null,
      kind: entry.kind,
      added: stat.added,
      removed: stat.removed,
    };
  });

  return {
    fromCheckpointId: params.fromCheckpointId,
    toCheckpointId: params.toCheckpointId,
    files,
  };
}

export function buildAffectedRepoPaths(files: GitCheckpointFileDiff[]): string[] {
  const values = new Set<string>();
  for (const file of files) {
    values.add(file.repoRelativePath);
    if (file.originalPath) {
      values.add(file.originalPath);
    }
  }
  return [...values];
}

export function buildCheckpointEnv(tempIndexPath: string): NodeJS.ProcessEnv {
  return {
    GIT_INDEX_FILE: tempIndexPath,
    GIT_AUTHOR_NAME: "ZCode Checkpoint",
    GIT_AUTHOR_EMAIL: "checkpoint@zcode.local",
    GIT_COMMITTER_NAME: "ZCode Checkpoint",
    GIT_COMMITTER_EMAIL: "checkpoint@zcode.local",
  };
}

export async function removeFileIfExists(path: string): Promise<void> {
  await rm(path, {
    force: true,
    recursive: true,
  });
}

function toRepoRelativePathFromAbsolute(repoRoot: string, absolutePath: string): string {
  return normalizeGitPath(absolutePath.replace(`${repoRoot}${sep}`, ""));
}

export function normalizeAffectedRepoPath(repoRoot: string, path: string): string {
  return normalizeGitPath(isAbsolute(path) ? toRepoRelativePathFromAbsolute(repoRoot, path) : path);
}
