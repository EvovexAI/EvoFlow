/**
 * 清理计划：给定类别与候选文件列表，决定哪些能删。纯函数，删除动作由 adapters 执行。
 */
import {
  classifyStoragePath,
  getStorageCategoryCleanability,
  isProtectedStoragePath,
  type StorageCatalogContext,
} from "./storageCatalog.js";
import type { StorageCategoryId } from "@zcode/shared";

export interface StorageCleanCandidate {
  relativePath: string;
  bytes: number;
  mtimeMs: number;
}

interface StorageCleanPlan {
  targets: StorageCleanCandidate[];
  skippedCount: number;
}

/** 子代理产物：会话目录 24 小时内有更新就整个跳过，避免删掉进行中 subagent 的 transcript。 */
const SUBAGENT_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function planStorageClean(params: {
  categoryId: StorageCategoryId;
  candidates: StorageCleanCandidate[];
  context: StorageCatalogContext;
  now: number;
}): StorageCleanPlan {
  const { categoryId, candidates, context, now } = params;
  if (getStorageCategoryCleanability(categoryId) === "none") {
    return { targets: [], skippedCount: candidates.length };
  }
  // 候选来自按前缀枚举，可能混入其他类别（如 cli/plugins 下的 cache）；只保留分类一致且未受保护的。
  const owned = candidates.filter(
    (candidate) =>
      classifyStoragePath(candidate.relativePath, context).categoryId === categoryId &&
      !isProtectedStoragePath(candidate.relativePath),
  );
  let targets = owned;
  if (categoryId === "logs") {
    targets = owned.filter((candidate) => !isSameLocalDay(candidate.mtimeMs, now));
  } else if (categoryId === "subagentTranscripts") {
    // 活动判定如果只看 owned（已按类别过滤，只剩 transcript.jsonl），会漏掉同目录下
    // 刚写入的 metadata/output 文件，把进行中 subagent 的 transcript 判成不活跃。这里用全部候选算活动时间。
    targets = filterInactiveSessionDirs(owned, candidates, now);
  }
  return { targets, skippedCount: candidates.length - targets.length };
}

function isSameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** 会话目录 = 前三段（cli/agents/sess_x）；任一文件在活动窗口内则整组跳过。 */
function filterInactiveSessionDirs(
  targets: StorageCleanCandidate[],
  allCandidates: StorageCleanCandidate[],
  now: number,
): StorageCleanCandidate[] {
  const latestBySession = new Map<string, number>();
  const sessionKey = (path: string) => path.split("/").slice(0, 3).join("/");
  for (const candidate of allCandidates) {
    const key = sessionKey(candidate.relativePath);
    latestBySession.set(key, Math.max(latestBySession.get(key) ?? 0, candidate.mtimeMs));
  }
  return targets.filter(
    (candidate) =>
      now - (latestBySession.get(sessionKey(candidate.relativePath)) ?? 0) >
      SUBAGENT_ACTIVE_WINDOW_MS,
  );
}
