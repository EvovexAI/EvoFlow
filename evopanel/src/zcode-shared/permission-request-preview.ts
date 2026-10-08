import type { ZCodePermissionRequest } from "./zcode-task-types-core.js";

export type PermissionRequestScope = "command" | "file" | "generic";

export interface PermissionRequestPreview {
  title: string;
  command: string | null;
  filePaths: string[];
  scope: PermissionRequestScope;
  fileChange: PermissionRequestFileChange | null;
  fileChanges: PermissionRequestFileChange[];
}

export interface PermissionRequestFileChange {
  path: string;
  type: "add" | "update";
}

const COMMAND_KEYS = new Set(["command", "cmd", "script", "shellcommand"]);
const ARGUMENT_KEYS = new Set(["args", "argv", "arguments"]);
const FILE_PATH_KEYS = new Set([
  "path",
  "paths",
  "file",
  // ZCode Agent edit 权限常把目标文件放在 file_path/filePath，漏掉会让权限预览只剩标题。
  "file_path",
  "filepath",
  "files",
  "filename",
  "filenames",
  "target",
  "targets",
  "location",
  "locations",
]);
const IGNORED_DIRECTORY_KEYS = new Set(["cwd", "directory", "workingdirectory"]);
const MAX_PERMISSION_FILE_PATHS = 6;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeInlineText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeBlockText(value: string): string {
  return value.trim().replace(/\r\n/g, "\n");
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (typeof item === "string") {
        return item.trim();
      }

      if (typeof item === "number" || typeof item === "boolean" || typeof item === "bigint") {
        return String(item);
      }

      return "";
    })
    .filter((item) => item.length > 0);
}

function readPermissionInputSource(rawSource: unknown): unknown {
  if (!isRecord(rawSource)) {
    return rawSource;
  }

  if ("rawInput" in rawSource && rawSource.rawInput !== undefined) {
    return rawSource.rawInput;
  }

  // ZCode protocol 的 requestPermission schema 使用 input 承载工具参数；
  // 只按旧 rawInput 读取会让 Write/Edit 这类结构化工具退回到通用 JSON 预览。
  return "input" in rawSource ? rawSource.input : rawSource;
}

function getCommandFromRecord(record: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(record)) {
    if (!COMMAND_KEYS.has(key.toLowerCase()) || typeof value !== "string") {
      continue;
    }

    const command = normalizeBlockText(value);
    if (command.length === 0) {
      continue;
    }

    for (const [argsKey, argsValue] of Object.entries(record)) {
      if (!ARGUMENT_KEYS.has(argsKey.toLowerCase())) {
        continue;
      }

      const args = getStringArray(argsValue);
      if (args.length > 0) {
        return `${command} ${args.join(" ")}`;
      }
    }

    return command;
  }

  return null;
}

function findFirstCommand(
  value: unknown,
  seen: Set<unknown> = new Set(),
  allowBareString = false,
): string | null {
  if (typeof value === "string") {
    if (!allowBareString) {
      return null;
    }

    const command = normalizeBlockText(value);
    return command.length > 0 ? command : null;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return null;
    }
    seen.add(value);

    for (const item of value) {
      const nestedCommand = findFirstCommand(item, seen);
      if (nestedCommand) {
        return nestedCommand;
      }
    }
    return null;
  }

  if (!isRecord(value) || seen.has(value)) {
    return null;
  }
  seen.add(value);

  const directCommand = getCommandFromRecord(value);
  if (directCommand) {
    return directCommand;
  }

  for (const key of ["rawInput", "input", "params", "toolCall"] as const) {
    if (!(key in value)) {
      continue;
    }

    const nestedCommand = findFirstCommand(
      value[key],
      seen,
      key === "rawInput" || key === "input" || key === "params",
    );
    if (nestedCommand) {
      return nestedCommand;
    }
  }

  for (const nestedValue of Object.values(value)) {
    if (!Array.isArray(nestedValue) && !isRecord(nestedValue)) {
      continue;
    }

    const nestedCommand = findFirstCommand(nestedValue, seen);
    if (nestedCommand) {
      return nestedCommand;
    }
  }

  return null;
}

function pushUniquePath(paths: string[], value: string) {
  const normalizedPath = normalizeInlineText(value);
  if (!normalizedPath || paths.includes(normalizedPath)) {
    return;
  }

  paths.push(normalizedPath);
}

function extractPathsFromCandidate(value: unknown, paths: string[], seen: Set<unknown>): void {
  if (paths.length >= MAX_PERMISSION_FILE_PATHS) {
    return;
  }

  if (typeof value === "string") {
    pushUniquePath(paths, value);
    return;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    for (const item of value) {
      extractPathsFromCandidate(item, paths, seen);
      if (paths.length >= MAX_PERMISSION_FILE_PATHS) {
        return;
      }
    }
    return;
  }

  if (!isRecord(value) || seen.has(value)) {
    return;
  }
  seen.add(value);

  if (typeof value.path === "string") {
    pushUniquePath(paths, value.path);
    if (paths.length >= MAX_PERMISSION_FILE_PATHS) {
      return;
    }
  }

  for (const nestedValue of Object.values(value)) {
    extractPathsFromCandidate(nestedValue, paths, seen);
    if (paths.length >= MAX_PERMISSION_FILE_PATHS) {
      return;
    }
  }
}

function collectFilePaths(value: unknown, paths: string[], seen: Set<unknown> = new Set()): void {
  if (paths.length >= MAX_PERMISSION_FILE_PATHS) {
    return;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    for (const item of value) {
      collectFilePaths(item, paths, seen);
      if (paths.length >= MAX_PERMISSION_FILE_PATHS) {
        return;
      }
    }
    return;
  }

  if (!isRecord(value) || seen.has(value)) {
    return;
  }
  seen.add(value);

  for (const [key, candidate] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();

    if (IGNORED_DIRECTORY_KEYS.has(normalizedKey)) {
      continue;
    }

    if (FILE_PATH_KEYS.has(normalizedKey)) {
      extractPathsFromCandidate(candidate, paths, seen);
      if (paths.length >= MAX_PERMISSION_FILE_PATHS) {
        return;
      }
      continue;
    }

    if (!Array.isArray(candidate) && !isRecord(candidate)) {
      continue;
    }

    collectFilePaths(candidate, paths, seen);
    if (paths.length >= MAX_PERMISSION_FILE_PATHS) {
      return;
    }
  }
}

function collectFileChanges(
  value: unknown,
  changes: PermissionRequestFileChange[],
  seen: Set<unknown> = new Set(),
): void {
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    for (const item of value) {
      collectFileChanges(item, changes, seen);
    }
    return;
  }

  if (!isRecord(value) || seen.has(value)) {
    return;
  }
  seen.add(value);

  if (isRecord(value.changes)) {
    for (const [path, change] of Object.entries(value.changes)) {
      if (!isRecord(change)) {
        continue;
      }

      if (change.type !== "add" && change.type !== "update") {
        continue;
      }

      if (changes.some((item) => item.path === path && item.type === change.type)) {
        continue;
      }

      changes.push({
        path,
        type: change.type,
      });
    }
  }

  for (const nestedValue of Object.values(value)) {
    if (!Array.isArray(nestedValue) && !isRecord(nestedValue)) {
      continue;
    }

    collectFileChanges(nestedValue, changes, seen);
  }
}

export function getPermissionRequestPreview(
  request: Pick<ZCodePermissionRequest, "title" | "description" | "kind" | "raw">,
): PermissionRequestPreview {
  const rawSource = request.raw;
  const filePaths: string[] = [];

  collectFilePaths(rawSource, filePaths);

  const title =
    normalizeInlineText(request.title ?? request.description ?? request.kind) || "permission";
  const command = findFirstCommand(readPermissionInputSource(rawSource), new Set(), true);
  const fileChanges: PermissionRequestFileChange[] = [];
  collectFileChanges(rawSource, fileChanges);
  const fileChange = fileChanges.length === 1 ? fileChanges[0]! : null;
  const scope: PermissionRequestScope = command
    ? "command"
    : filePaths.length > 0
      ? "file"
      : "generic";

  return {
    title,
    command,
    filePaths,
    scope,
    fileChange,
    fileChanges,
  };
}
