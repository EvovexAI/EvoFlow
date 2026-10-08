import { createHash } from "node:crypto";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { generateTraceId } from "@zcode/shared";
import { deriveSessionTitle } from "#src/session/sessionTitle.js";
import type { ClaudeNativeImportedSessionSource } from "#src/session/claude-native/claudeNativeImportedSessionTypes.js";
import type { LegacyTaskSessionFile } from "#src/session/legacyTaskSessionFile.js";
import {
  DEFAULT_IMPORTED_CLAUDE_TASK_FILTER_PATHS,
  filterImportedClaudeTaskFilePaths,
} from "#src/session/claude-native/importedClaudeTaskFileFilter.js";

export function buildImportedClaudeTaskId(workspacePath: string, sessionId: string): string {
  const digest = createHash("sha256")
    .update(`claude:${workspacePath}:${sessionId}`)
    .digest("hex")
    .slice(0, 24);
  return `claude-import-${digest}`;
}

function deriveImportedTaskTitle(
  fallbackTitle: string | undefined,
  messages: ClaudeNativeImportedSessionSource["messages"],
): string {
  const explicitTitle = fallbackTitle?.trim();
  if (explicitTitle) {
    return explicitTitle;
  }

  const firstUserMessage = messages.find(
    (message) => message.role === "user" && message.content.trim().length > 0,
  );
  return firstUserMessage ? deriveSessionTitle(firstUserMessage.content, []) : "Imported session";
}

export function buildImportedClaudeTaskFile(
  source: ClaudeNativeImportedSessionSource,
  filterPaths: readonly string[] = DEFAULT_IMPORTED_CLAUDE_TASK_FILTER_PATHS,
  taskIdOverride?: string,
): LegacyTaskSessionFile {
  if (source.messages.length === 0) {
    throw new Error(`[claude-native] external session ${source.sessionId} 没有可导入的可见消息`);
  }

  const taskId =
    taskIdOverride ?? buildImportedClaudeTaskId(source.workspacePath, source.sessionId);
  const traceId = generateTraceId(taskId);
  const createdAt = Number.isFinite(source.createdAt) ? source.createdAt : source.updatedAt;
  const updatedAt = Number.isFinite(source.updatedAt) ? source.updatedAt : createdAt;

  const meta: ZCodeTaskMeta = {
    taskId,
    traceId,
    title: deriveImportedTaskTitle(source.title, source.messages),
    workspacePath: source.workspacePath,
    createdAt,
    updatedAt: Math.max(createdAt, updatedAt),
    mode: "build",
    migrationSource: "claudeCode",
    status: "completed",
    ...(source.model ? { model: source.model } : {}),
  };

  const taskFile: LegacyTaskSessionFile = {
    meta,
    messages: [...source.messages],
  };

  // Claude 原生 session 的 mode/model/provider 是来源端运行态，
  // 直接落入 ZCode snapshot 会在恢复时污染当前 workspace 的运行时选择。
  // 这里按显式 path 列表清洗，保留正文和 migrationSource 供列表识别迁移来源。
  return filterImportedClaudeTaskFilePaths(taskFile, filterPaths);
}
