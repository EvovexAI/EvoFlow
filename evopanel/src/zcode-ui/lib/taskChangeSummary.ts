import type {
  ZCodePersistedFileChange,
  ZCodeTaskChangeSummary,
  ZCodeTaskChangedFileSummary,
  ZCodeTaskMeta,
} from "@zcode/shared";
import { computeLineChangeStat } from "@zcode/shared";
import { getPathLeaf } from "@/lib/path.js";

interface TaskChangeSummaryIntl {
  formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
}

interface AggregatedFileChange {
  path: string;
  originalContent: string | null;
  finalContent: string;
  writeCount: number;
  lastTurnIndex: number;
}

function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

export function getTaskChangeSummary(
  task: Pick<ZCodeTaskMeta, "changeSummary"> | null | undefined,
): ZCodeTaskChangeSummary | null {
  if (!task?.changeSummary || task.changeSummary.files.length === 0) {
    return null;
  }

  return task.changeSummary;
}

function formatTaskChangeStats(
  summary: ZCodeTaskChangeSummary,
  intl: TaskChangeSummaryIntl,
): string {
  return intl.formatMessage(
    { id: "taskList.changeStats" },
    {
      added: String(summary.added),
      removed: String(summary.removed),
    },
  );
}

export function formatTaskTitleWithChanges(
  title: string,
  summary: ZCodeTaskChangeSummary | null,
  intl: TaskChangeSummaryIntl,
): string {
  if (!summary) {
    return title;
  }

  return `${title} (${formatTaskChangeStats(summary, intl)})`;
}

export function toWorkspaceRelativePath(workspacePath: string, filePath: string): string {
  const normalizedWorkspacePath = trimTrailingSeparators(workspacePath.replace(/\\/g, "/"));
  const normalizedFilePath = filePath.replace(/\\/g, "/");

  if (normalizedFilePath === normalizedWorkspacePath) {
    return getPathLeaf(filePath);
  }

  const exactPrefix = `${normalizedWorkspacePath}/`;
  if (normalizedFilePath.startsWith(exactPrefix)) {
    return normalizedFilePath.slice(exactPrefix.length) || getPathLeaf(filePath);
  }

  // Windows 路径在不同来源下大小写可能不一致，这里做一次只用于比较的降级匹配。
  const caseInsensitivePrefix = exactPrefix.toLowerCase();
  if (normalizedFilePath.toLowerCase().startsWith(caseInsensitivePrefix)) {
    return normalizedFilePath.slice(exactPrefix.length) || getPathLeaf(filePath);
  }

  return normalizedFilePath;
}

export function buildTaskChangeSummary(
  fileChanges: readonly ZCodePersistedFileChange[] | undefined,
): ZCodeTaskChangeSummary | null {
  if (!fileChanges || fileChanges.length === 0) {
    return null;
  }

  const changedFileMap = new Map<string, AggregatedFileChange>();

  for (const turn of fileChanges) {
    for (const snapshot of turn.snapshots) {
      const existing = changedFileMap.get(snapshot.path);
      if (existing) {
        existing.finalContent = snapshot.afterContent;
        existing.writeCount += snapshot.writeCount;
        existing.lastTurnIndex = turn.turnIndex;
        continue;
      }

      changedFileMap.set(snapshot.path, {
        path: snapshot.path,
        originalContent: snapshot.beforeContent,
        finalContent: snapshot.afterContent,
        writeCount: snapshot.writeCount,
        lastTurnIndex: turn.turnIndex,
      });
    }
  }

  if (changedFileMap.size === 0) {
    return null;
  }

  let added = 0;
  let removed = 0;
  const files: ZCodeTaskChangedFileSummary[] = Array.from(changedFileMap.values())
    .map((file) => {
      const fileStat = computeLineChangeStat(file.originalContent, file.finalContent);
      added += fileStat.added;
      removed += fileStat.removed;
      return {
        path: file.path,
        added: fileStat.added,
        removed: fileStat.removed,
        writeCount: file.writeCount,
        lastTurnIndex: file.lastTurnIndex,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    fileCount: files.length,
    added,
    removed,
    files,
  };
}

export function buildTurnChangeSummary(
  turn: ZCodePersistedFileChange | null | undefined,
): ZCodeTaskChangeSummary | null {
  if (!turn || turn.snapshots.length === 0) {
    return null;
  }

  // 调用方需要严格只显示当前轮的文件摘要。
  // 这里把单轮摘要计算抽成独立 helper，只从传入的当前轮快照重算，
  // 避免任何 task/session 级聚合误传进来时把历史轮次文件一起展示出来。
  const filesByPath = new Map<
    string,
    {
      beforeContent: string | null;
      afterContent: string;
      writeCount: number;
    }
  >();

  for (const snapshot of turn.snapshots) {
    const existing = filesByPath.get(snapshot.path);
    if (existing) {
      existing.afterContent = snapshot.afterContent;
      existing.writeCount += snapshot.writeCount;
      continue;
    }

    filesByPath.set(snapshot.path, {
      beforeContent: snapshot.beforeContent,
      afterContent: snapshot.afterContent,
      writeCount: snapshot.writeCount,
    });
  }

  let added = 0;
  let removed = 0;
  const files: ZCodeTaskChangedFileSummary[] = Array.from(filesByPath.entries())
    .map(([path, snapshot]) => {
      const fileStat = computeLineChangeStat(snapshot.beforeContent, snapshot.afterContent);
      added += fileStat.added;
      removed += fileStat.removed;
      return {
        path,
        added: fileStat.added,
        removed: fileStat.removed,
        writeCount: snapshot.writeCount,
        lastTurnIndex: turn.turnIndex,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    fileCount: files.length,
    added,
    removed,
    files,
  };
}

/**
 * 从 fileChanges 中按轮次构建 per-turn 文件变更摘要。
 * 用于在每条 assistant 消息下方显示该轮的文件改动。
 */
export function buildPerTurnChangeSummaries(
  fileChanges: readonly ZCodePersistedFileChange[] | undefined,
): Map<number, ZCodeTaskChangeSummary> {
  const result = new Map<number, ZCodeTaskChangeSummary>();
  if (!fileChanges || fileChanges.length === 0) {
    return result;
  }

  for (const turn of fileChanges) {
    const summary = buildTurnChangeSummary(turn);
    if (!summary) {
      continue;
    }

    result.set(turn.turnIndex, summary);
  }

  return result;
}
