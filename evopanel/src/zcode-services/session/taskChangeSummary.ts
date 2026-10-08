import type {
  ZCodePersistedFileChange,
  ZCodeTaskChangeSummary,
  ZCodeTaskChangedFileSummary,
  ZCodeTaskMeta,
} from "@zcode/shared";
import { computeLineChangeStat } from "@zcode/shared";

interface AggregatedFileChange {
  path: string;
  originalContent: string | null;
  finalContent: string;
  writeCount: number;
  lastTurnIndex: number;
}

/**
 * 按轮次分组构建文件变更摘要。
 * 每个轮次独立计算 diff，用于在每条 assistant 消息下方显示该轮的文件改动。
 */
export function buildPerTurnChangeSummaries(
  fileChanges: readonly ZCodePersistedFileChange[] | undefined,
): Map<number, ZCodeTaskChangeSummary> {
  const result = new Map<number, ZCodeTaskChangeSummary>();
  if (!fileChanges || fileChanges.length === 0) {
    return result;
  }

  for (const turn of fileChanges) {
    if (turn.snapshots.length === 0) {
      continue;
    }

    // Aggregate snapshots by path so that the same file edited multiple times
    // within one turn produces a single entry (original before → final after).
    const turnFileMap = new Map<
      string,
      { beforeContent: string | null; afterContent: string; writeCount: number }
    >();
    for (const snapshot of turn.snapshots) {
      const existing = turnFileMap.get(snapshot.path);
      if (existing) {
        existing.afterContent = snapshot.afterContent;
        existing.writeCount += snapshot.writeCount;
      } else {
        turnFileMap.set(snapshot.path, {
          beforeContent: snapshot.beforeContent,
          afterContent: snapshot.afterContent,
          writeCount: snapshot.writeCount,
        });
      }
    }

    let added = 0;
    let removed = 0;
    const files: ZCodeTaskChangedFileSummary[] = Array.from(turnFileMap.entries())
      .map(([path, file]) => {
        const fileStat = computeLineChangeStat(file.beforeContent, file.afterContent);
        added += fileStat.added;
        removed += fileStat.removed;
        return {
          path,
          added: fileStat.added,
          removed: fileStat.removed,
          writeCount: file.writeCount,
          lastTurnIndex: turn.turnIndex,
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path));

    result.set(turn.turnIndex, {
      fileCount: files.length,
      added,
      removed,
      files,
    });
  }

  return result;
}

export function buildTaskChangeSummary(
  fileChanges: readonly ZCodePersistedFileChange[] | undefined,
): ZCodeTaskChangeSummary | undefined {
  if (!fileChanges || fileChanges.length === 0) {
    return undefined;
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
    return undefined;
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
