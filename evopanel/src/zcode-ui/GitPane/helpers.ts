import type { GitChangeSourceId, GitDiffResult } from "@zcode/shared";
import { getFiletypeFromFileName } from "@pierre/diffs";
import {
  getPatchPreviewLineContent,
  getPlainTextPatchContentLines,
  getPlainTextPatchFallbackLines,
  parseTruncatedMarkerOmittedLineCount,
} from "@/lib/patchDiffPreview.js";

const MAX_RICH_DIFF_FULL_CONTENT_CHAR_COUNT = 180_000;
const MAX_RICH_DIFF_FULL_CONTENT_LINE_COUNT = 1_200;

type GitPaneDiffPreviewPlan =
  | {
      kind: "rich";
    }
  | {
      kind: "patch";
    }
  | {
      kind: "plain-text";
      lines: string[];
    };

export function getSourceMessageId(sourceId: GitChangeSourceId): string {
  switch (sourceId) {
    case "unstaged":
      return "git.source.unstaged";
    case "staged":
      return "git.source.staged";
    case "branch":
      return "git.source.branch";
    case "last-turn":
      return "git.source.lastTurn";
    default:
      return "git.source.unstaged";
  }
}

export function getDiffFallbackMessageId(availability: GitDiffResult["availability"]): string {
  switch (availability) {
    case "binary":
      return "git.diff.binaryTitle";
    case "truncated":
      return "git.diff.truncatedTitle";
    default:
      return "git.diff.unavailableTitle";
  }
}

export function getDiffCacheKey(sourceId: GitChangeSourceId, path: string): string {
  return `${sourceId}:${path}`;
}

export function getGitPaneDiffFindContent(diff: GitDiffResult | null): string | null {
  if (diff?.availability !== "patch") {
    return null;
  }

  if (diff.beforeContent !== null && diff.afterContent !== null) {
    return `${diff.beforeContent}\n${diff.afterContent}`;
  }

  if (diff.patch) {
    const previewPlan = getGitPaneDiffPreviewPlan(diff);
    const visibleLines =
      previewPlan.kind === "plain-text"
        ? previewPlan.lines
        : getPlainTextPatchContentLines(diff.patch);

    // 全文内容降级后若直接搜索原始 patch，Git 文件头、index 和 hunk 头会
    // 产生预览中不存在的伪命中。查找必须复用实际可见行，并剥掉不会显示的 diff marker。
    return visibleLines
      .filter((line) => parseTruncatedMarkerOmittedLineCount(line) === null)
      .map(getPatchPreviewLineContent)
      .join("\n");
  }

  if (diff.beforeContent === null && diff.afterContent === null) {
    return null;
  }

  return `${diff.beforeContent ?? ""}\n${diff.afterContent ?? ""}`;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }

  return String(error);
}

function countLogicalLines(content: string | null): number {
  if (!content) {
    return 0;
  }

  let lineCount = content.endsWith("\n") ? 0 : 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) {
      lineCount += 1;
    }
  }

  return lineCount;
}

function shouldRenderPatchOnlyGitDiffPreview(diff: GitDiffResult): boolean {
  if (diff.availability !== "patch" || !diff.patch) {
    return false;
  }

  // Repo 全文读取失败时 patch 仍然有效，但缺失的一侧不能再补成空文件交给
  // MultiFileDiff。把“不完整内容对”并入既有 patch 安全预检，避免整文件误判为增删。
  if (diff.beforeContent === null || diff.afterContent === null) {
    return true;
  }

  const fullContentCharCount = (diff.beforeContent?.length ?? 0) + (diff.afterContent?.length ?? 0);
  if (fullContentCharCount > MAX_RICH_DIFF_FULL_CONTENT_CHAR_COUNT) {
    return true;
  }

  const fullContentLineCount = Math.max(
    countLogicalLines(diff.beforeContent),
    countLogicalLines(diff.afterContent),
  );

  return fullContentLineCount > MAX_RICH_DIFF_FULL_CONTENT_LINE_COUNT;
}

export function getGitPaneDiffPreviewPlan(diff: GitDiffResult | null): GitPaneDiffPreviewPlan {
  if (diff?.availability !== "patch" || !diff.patch) {
    return { kind: "rich" };
  }

  const reviewFallbackLines = shouldRenderPlainTextDiffPreview(diff.patch);
  if (reviewFallbackLines) {
    return {
      kind: "plain-text",
      lines: reviewFallbackLines,
    };
  }

  if (!shouldRenderPatchOnlyGitDiffPreview(diff)) {
    return { kind: "rich" };
  }

  const fullPatchFallbackLines = getPlainTextPatchFallbackLines(diff.patch);
  if (fullPatchFallbackLines) {
    return {
      kind: "plain-text",
      lines: fullPatchFallbackLines,
    };
  }

  // Review 面板展开大文件时，MultiFileDiff 会在 React render 阶段同步比较
  // before/after 整文件，并在初始高亮前构建整文件 plain AST。大文件只需要先看变更 hunk，
  // 因此超阈值时改走 PatchDiff，保留异步高亮 worker，同时避开整文件主线程开销。
  return { kind: "patch" };
}

function shouldRenderPlainTextDiffPreview(patch: string): string[] | null {
  const fallbackLines = getPlainTextPatchFallbackLines(patch);
  if (!fallbackLines) {
    return null;
  }

  const lines = patch.split(/\r?\n/);
  const isCreatedOrDeletedPatch =
    lines.some((line) => line === "--- /dev/null") ||
    lines.some((line) => line === "+++ /dev/null");
  if (!isCreatedOrDeletedPatch) {
    return fallbackLines;
  }

  const patchFileName = getPatchContentFileName(lines);
  if (!patchFileName) {
    return null;
  }

  // review 面板只该把纯文本新增/删除文件降级成轻量 preview。
  // 底层通用 fallback 为了避免文件变更展开空白，会覆盖 JSON 等结构化文件；
  // 这里重新按文件类型收口，避免结构化文件绕过 PatchDiff 的语义化渲染路径。
  return getFiletypeFromFileName(patchFileName) === "text" ? fallbackLines : null;
}

function getPatchContentFileName(lines: readonly string[]): string | null {
  for (const line of lines) {
    if (!line.startsWith("--- ") && !line.startsWith("+++ ")) {
      continue;
    }

    const fileName = line.slice(4).trim();
    if (!fileName || fileName === "/dev/null") {
      continue;
    }

    return fileName;
  }

  return null;
}
