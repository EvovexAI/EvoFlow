const ARRAY_WILDCARD_SUFFIX = "[]";

export const DEFAULT_IMPORTED_CLAUDE_TASK_FILTER_PATHS = [
  "meta.mode",
  "meta.model",
  "meta.provider",
  "messages[].model",
] as const;

type MutableJsonObject = Record<string, unknown>;

function isMutableJsonObject(value: unknown): value is MutableJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deletePath(value: unknown, segments: readonly string[]): void {
  if (segments.length === 0) {
    return;
  }

  const [segment, ...rest] = segments;
  if (!segment) {
    return;
  }

  if (segment.endsWith(ARRAY_WILDCARD_SUFFIX)) {
    const key = segment.slice(0, -ARRAY_WILDCARD_SUFFIX.length);
    if (!isMutableJsonObject(value) || !Array.isArray(value[key])) {
      return;
    }

    for (const item of value[key]) {
      deletePath(item, rest);
    }
    return;
  }

  if (!isMutableJsonObject(value)) {
    return;
  }

  if (rest.length === 0) {
    delete value[segment];
    return;
  }

  deletePath(value[segment], rest);
}

export function filterImportedClaudeTaskFilePaths<T>(input: T, filterPaths: readonly string[]): T {
  const cloned = structuredClone(input) as T;
  for (const path of filterPaths) {
    deletePath(cloned, path.split("."));
  }
  return cloned;
}
