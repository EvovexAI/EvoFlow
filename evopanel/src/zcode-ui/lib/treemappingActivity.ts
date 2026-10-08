/* eslint-disable max-lines -- Treemapping v1 的 tool call 解析规则需要集中保持优先级一致，避免 UI 和测试分散维护后产生识别差异。 */
import type { TaskChatMessage, TaskChatToolCall } from "@/lib/taskChatMessageTypes.js";
import { getPathLeaf, isAbsoluteFilePath } from "@/lib/path.js";
import { readRawToolCallFileSummaries } from "@/ToolCallBlocks/fileSummaries.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";

export type TreemappingFileKind = "viewed" | "written" | "modified" | "deleted";
export type TreemappingEventAction = "view" | "write" | "modify" | "delete";

export interface TreemappingActivityEvent {
  toolCallId: string;
  toolName: string;
  action: TreemappingEventAction;
  path: string;
  target: "file" | "directory";
  added: number;
  removed: number;
  timestamp: number;
  pending: boolean;
}

export interface TreemappingFileActivity {
  path: string;
  kind: TreemappingFileKind;
  added: number;
  removed: number;
  views: number;
  pendingToolCallIds: string[];
  lastTouchedAt: number;
  events: TreemappingActivityEvent[];
}

export interface TreemappingDirectoryActivity {
  path: string;
  views: number;
  lastTouchedAt: number;
  events: TreemappingActivityEvent[];
}

export interface TreemappingActivityModel {
  files: TreemappingFileActivity[];
  directories: TreemappingDirectoryActivity[];
  runningWithoutPathCount: number;
}

const ACTIVE_TOOL_CALL_STATUSES = new Set(["pending", "in_progress"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(value: unknown, keys: readonly string[]): string | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return undefined;
}

function readNumberField(value: unknown, keys: readonly string[]): number | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return Math.max(0, Math.round(candidate));
    }
  }

  return undefined;
}

function normalizePath(path: string, workspacePath: string): string | null {
  const decodedPath = path.trim().replace(/\\/g, "/");
  if (!decodedPath || decodedPath.includes("\n")) {
    return null;
  }

  const normalizedWorkspace = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalizedWorkspace && decodedPath.startsWith(`${normalizedWorkspace}/`)) {
    return decodedPath.slice(normalizedWorkspace.length + 1);
  }

  if (isAbsoluteFilePath(decodedPath)) {
    return decodedPath.replace(/^\/+/, "");
  }

  return decodedPath.replace(/^\.?\//, "");
}

function normalizeDirectoryPath(path: string, workspacePath: string): string | null {
  const normalizedPath = normalizePath(path, workspacePath);
  return normalizedPath?.replace(/\/+$/, "") || null;
}

function getToolName(toolCall: TaskChatToolCall): string {
  const identity = resolveToolCallIdentity(toolCall);
  return (identity.toolName ?? toolCall.title?.trim()) || toolCall.kind || "tool";
}

function getSemanticText(toolCall: TaskChatToolCall): string {
  const raw = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  const rawInput = raw && isPlainRecord(raw.rawInput) ? raw.rawInput : null;
  const rawTitle = raw && typeof raw.title === "string" ? raw.title : "";
  const rawKind = raw && typeof raw.kind === "string" ? raw.kind : "";
  const inputAction = readStringField(toolCall.input, [
    "action",
    "operation",
    "mode",
    "kind",
    "title",
  ]);
  const rawInputAction = readStringField(rawInput, [
    "action",
    "operation",
    "mode",
    "kind",
    "title",
  ]);
  return [toolCall.kind, toolCall.title, rawKind, rawTitle, inputAction, rawInputAction]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function getMutationSemanticText(toolCall: TaskChatToolCall): string {
  const raw = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  const rawInput = raw && isPlainRecord(raw.rawInput) ? raw.rawInput : null;
  const rawKind = raw && typeof raw.kind === "string" ? raw.kind : "";
  const inputAction = readStringField(toolCall.input, ["action", "operation", "mode", "kind"]);
  const rawInputAction = readStringField(rawInput, ["action", "operation", "mode", "kind"]);
  return [toolCall.kind, rawKind, inputAction, rawInputAction]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function inferReadAction(toolCall: TaskChatToolCall): "file" | "directory" | "search" | null {
  const identity = resolveToolCallIdentity(toolCall);
  if (identity.family === "file-read") {
    return "file";
  }
  if (identity.family === "search") {
    return identity.toolName === "Glob" ? "directory" : "search";
  }

  const semanticText = getSemanticText(toolCall);
  if (/\b(ls|list|readdir|tree)\b/.test(semanticText)) {
    return "directory";
  }
  if (/\b(search|grep|rg|ripgrep|find|glob)\b/.test(semanticText)) {
    return "search";
  }
  if (/\b(read|view|open|cat|head|tail)\b/.test(semanticText)) {
    return "file";
  }
  return null;
}

function readPathCandidates(value: unknown): string[] {
  if (!isPlainRecord(value)) {
    return [];
  }

  const paths = new Set<string>();
  const directPath = readStringField(value, [
    "path",
    "filePath",
    "file_path",
    "targetPath",
    "target_path",
    "sourcePath",
    "source_path",
    "oldPath",
    "old_path",
    "newPath",
    "new_path",
    "filename",
    "file",
    "directory",
    "dir",
    "cwd",
  ]);
  if (directPath) {
    paths.add(directPath);
  }

  for (const key of ["paths", "files", "filePaths", "file_paths", "matches", "results"] as const) {
    const candidate = value[key];
    if (!Array.isArray(candidate)) {
      continue;
    }
    for (const item of candidate) {
      if (typeof item === "string" && item.trim()) {
        paths.add(item);
      } else {
        const nestedPath = readStringField(item, [
          "path",
          "filePath",
          "file_path",
          "filename",
          "file",
        ]);
        if (nestedPath) {
          paths.add(nestedPath);
        }
      }
    }
  }

  return [...paths];
}

function readToolCallPathCandidates(toolCall: TaskChatToolCall): string[] {
  const raw = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  const rawInput = raw && isPlainRecord(raw.rawInput) ? raw.rawInput : null;
  const rawOutput = raw && isPlainRecord(raw.rawOutput) ? raw.rawOutput : null;
  return [
    ...readPathCandidates(toolCall.input),
    ...readPathCandidates(toolCall.output),
    ...readPathCandidates(rawInput),
    ...readPathCandidates(rawOutput),
    ...readPathCandidates(raw),
  ];
}

function readSearchResultPathCandidates(toolCall: TaskChatToolCall): string[] {
  const raw = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  const rawOutput = raw && isPlainRecord(raw.rawOutput) ? raw.rawOutput : null;
  return [...readPathCandidates(toolCall.output), ...readPathCandidates(rawOutput)];
}

function readSearchScopePathCandidates(toolCall: TaskChatToolCall): string[] {
  const raw = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  const rawInput = raw && isPlainRecord(raw.rawInput) ? raw.rawInput : null;
  return [...readPathCandidates(toolCall.input), ...readPathCandidates(rawInput)];
}

function readStructuredChangeStats(value: unknown): {
  added: number;
  removed: number;
} {
  const added = readNumberField(value, ["added", "additions", "insertions", "linesAdded"]) ?? 0;
  const removed = readNumberField(value, ["removed", "deletions", "deleted", "linesRemoved"]) ?? 0;
  return { added, removed };
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (isPlainRecord(value)) {
    return value;
  }

  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mapRawContentTypeToAction(type: string | undefined): TreemappingEventAction | null {
  switch (type?.trim().toLowerCase()) {
    case "create":
    case "add":
    case "write":
      return "write";
    case "delete":
    case "remove":
    case "removed":
      return "delete";
    case "update":
    case "edit":
    case "modify":
      return "modify";
    default:
      return null;
  }
}

function readRawOutputContentAction(toolCall: TaskChatToolCall): TreemappingEventAction | null {
  const raw = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  const rawOutput = raw && isPlainRecord(raw.rawOutput) ? raw.rawOutput : null;
  const output = isPlainRecord(toolCall.output) ? toolCall.output : null;

  for (const source of [rawOutput, output]) {
    const content = parseJsonRecord(source?.content);
    const action = mapRawContentTypeToAction(
      typeof content?.type === "string" ? content.type : undefined,
    );
    if (action) {
      return action;
    }
  }

  return null;
}

function inferMutationAction(toolCall: TaskChatToolCall): TreemappingEventAction | null {
  const identity = resolveToolCallIdentity(toolCall);
  if (identity.family === "file-write") {
    return identity.toolName === "Write" ? "write" : "modify";
  }

  const semanticText = getMutationSemanticText(toolCall);
  if (/\b(delete|remove|unlink|rm)\b/.test(semanticText)) {
    return "delete";
  }
  if (/\b(create|write)\b/.test(semanticText)) {
    return "write";
  }
  if (/\b(edit|multiedit|patch|replace|update|apply_patch)\b/.test(semanticText)) {
    return "modify";
  }
  return null;
}

function addDirectoryEvent(
  directories: Map<string, TreemappingDirectoryActivity>,
  event: TreemappingActivityEvent,
) {
  const existing = directories.get(event.path);
  if (existing) {
    existing.views += event.action === "view" ? 1 : 0;
    existing.lastTouchedAt = Math.max(existing.lastTouchedAt, event.timestamp);
    existing.events.push(event);
    return;
  }

  directories.set(event.path, {
    path: event.path,
    views: event.action === "view" ? 1 : 0,
    lastTouchedAt: event.timestamp,
    events: [event],
  });
}

function mergeKind(current: TreemappingFileKind, next: TreemappingFileKind): TreemappingFileKind {
  const priority: Record<TreemappingFileKind, number> = {
    deleted: 4,
    written: 3,
    modified: 2,
    viewed: 1,
  };
  return priority[next] > priority[current] ? next : current;
}

function addFileEvent(
  files: Map<string, TreemappingFileActivity>,
  event: TreemappingActivityEvent,
) {
  const kind: TreemappingFileKind =
    event.action === "write"
      ? "written"
      : event.action === "modify"
        ? "modified"
        : event.action === "delete"
          ? "deleted"
          : "viewed";
  const existing = files.get(event.path);
  if (existing) {
    existing.kind = mergeKind(existing.kind, kind);
    existing.added += event.added;
    existing.removed += event.removed;
    existing.views += event.action === "view" ? 1 : 0;
    existing.lastTouchedAt = Math.max(existing.lastTouchedAt, event.timestamp);
    existing.events.push(event);
    if (event.pending && !existing.pendingToolCallIds.includes(event.toolCallId)) {
      existing.pendingToolCallIds.push(event.toolCallId);
    }
    return;
  }

  files.set(event.path, {
    path: event.path,
    kind,
    added: event.added,
    removed: event.removed,
    views: event.action === "view" ? 1 : 0,
    pendingToolCallIds: event.pending ? [event.toolCallId] : [],
    lastTouchedAt: event.timestamp,
    events: [event],
  });
}

function collectWritableEvents(
  toolCall: TaskChatToolCall,
  workspacePath: string,
): TreemappingActivityEvent[] {
  const pending = ACTIVE_TOOL_CALL_STATUSES.has(toolCall.status);
  const timestamp = toolCall.startedAt ?? Date.now();
  const toolName = getToolName(toolCall);
  const rawOutputContentAction = readRawOutputContentAction(toolCall);
  return readRawToolCallFileSummaries(toolCall.raw, {
    toolName: toolCall.toolName,
    kind: toolCall.kind,
    input: toolCall.input,
    output: toolCall.output,
    raw: toolCall.raw,
  })
    .map((summary) => {
      const path = normalizePath(summary.path, workspacePath);
      if (!path) {
        return null;
      }
      const action: TreemappingEventAction =
        rawOutputContentAction ??
        (summary.actionLabel === "Deleted"
          ? "delete"
          : // ZCode agent 会返回 kind=edit/title=Write/rawOutput.content.type=update。
            // title 只是展示文案，不能作为写入兜底；这里只信任结构化变更类型，避免 edit 被误染成 write。
            summary.actionLabel === "Created" || summary.operationKind === "write"
            ? "write"
            : summary.operationKind === "delete"
              ? "delete"
              : "modify");
      return {
        toolCallId: toolCall.toolId,
        toolName,
        action,
        path,
        target: "file" as const,
        added: summary.changeStat?.added ?? (action === "write" ? 1 : 0),
        removed: summary.changeStat?.removed ?? (action === "delete" ? 1 : 0),
        timestamp,
        pending,
      };
    })
    .filter((event): event is Exclude<typeof event, null> => event !== null);
}

function collectReadEvents(
  toolCall: TaskChatToolCall,
  workspacePath: string,
): TreemappingActivityEvent[] {
  const readAction = inferReadAction(toolCall);
  if (!readAction) {
    return [];
  }

  const pending = ACTIVE_TOOL_CALL_STATUSES.has(toolCall.status);
  const timestamp = toolCall.startedAt ?? Date.now();
  const toolName = getToolName(toolCall);
  const rawPaths =
    readAction === "search"
      ? readSearchResultPathCandidates(toolCall)
      : readToolCallPathCandidates(toolCall);
  const target =
    readAction === "directory"
      ? "directory"
      : readAction === "search" && rawPaths.length === 0
        ? "directory"
        : "file";
  const paths = new Set(
    (rawPaths.length > 0 ? rawPaths : readSearchScopePathCandidates(toolCall))
      .map((path) =>
        target === "directory"
          ? normalizeDirectoryPath(path, workspacePath)
          : normalizePath(path, workspacePath),
      )
      .filter((path): path is string => Boolean(path)),
  );

  return [...paths].map((path) => ({
    toolCallId: toolCall.toolId,
    toolName,
    action: "view" as const,
    path,
    target,
    added: 0,
    removed: 0,
    timestamp,
    pending,
  }));
}

function collectStructuredExecEvents(
  toolCall: TaskChatToolCall,
  workspacePath: string,
): TreemappingActivityEvent[] {
  const raw = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  const rawOutput = raw && isPlainRecord(raw.rawOutput) ? raw.rawOutput : null;
  const sources = [toolCall.output, rawOutput, raw].filter(isPlainRecord);
  const events: TreemappingActivityEvent[] = [];
  const pending = ACTIVE_TOOL_CALL_STATUSES.has(toolCall.status);
  const timestamp = toolCall.startedAt ?? Date.now();
  const toolName = getToolName(toolCall);

  for (const source of sources) {
    const changes = isPlainRecord(source.changes) ? source.changes : null;
    if (!changes) {
      continue;
    }

    for (const [rawPath, change] of Object.entries(changes)) {
      const path = normalizePath(rawPath, workspacePath);
      if (!path || !isPlainRecord(change)) {
        continue;
      }
      const changeType = typeof change.type === "string" ? change.type : "";
      const stats = readStructuredChangeStats(change);
      events.push({
        toolCallId: toolCall.toolId,
        toolName,
        action: changeType === "add" ? "write" : changeType === "delete" ? "delete" : "modify",
        path,
        target: "file",
        added: stats.added,
        removed: stats.removed,
        timestamp,
        pending,
      });
    }
  }

  return events;
}

function collectFallbackMutationEvents(
  toolCall: TaskChatToolCall,
  workspacePath: string,
): TreemappingActivityEvent[] {
  const action = inferMutationAction(toolCall);
  if (!action) {
    return [];
  }

  const pending = ACTIVE_TOOL_CALL_STATUSES.has(toolCall.status);
  const timestamp = toolCall.startedAt ?? Date.now();
  const toolName = getToolName(toolCall);
  const paths = new Set(
    readToolCallPathCandidates(toolCall)
      .map((path) => normalizePath(path, workspacePath))
      .filter((path): path is string => Boolean(path)),
  );

  return [...paths].map((path) => ({
    toolCallId: toolCall.toolId,
    toolName,
    action,
    path,
    target: "file" as const,
    added: action === "write" ? 1 : 0,
    removed: action === "delete" ? 1 : 0,
    timestamp,
    pending,
  }));
}

export function buildTreemappingActivityModel(
  message: TaskChatMessage | null,
  workspacePath: string,
): TreemappingActivityModel {
  const files = new Map<string, TreemappingFileActivity>();
  const directories = new Map<string, TreemappingDirectoryActivity>();
  let runningWithoutPathCount = 0;

  for (const toolCall of message?.toolCalls ?? []) {
    const writableEvents = collectWritableEvents(toolCall, workspacePath);
    const events = [
      ...writableEvents,
      ...(writableEvents.length === 0 ? collectStructuredExecEvents(toolCall, workspacePath) : []),
      ...(writableEvents.length === 0
        ? collectFallbackMutationEvents(toolCall, workspacePath)
        : []),
      ...collectReadEvents(toolCall, workspacePath),
    ];

    if (events.length === 0 && ACTIVE_TOOL_CALL_STATUSES.has(toolCall.status)) {
      runningWithoutPathCount += 1;
      continue;
    }

    for (const event of events) {
      if (event.target === "directory") {
        addDirectoryEvent(directories, event);
      } else {
        addFileEvent(files, event);
      }
    }
  }

  return {
    files: [...files.values()].sort((left, right) => left.path.localeCompare(right.path)),
    directories: [...directories.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    runningWithoutPathCount,
  };
}
