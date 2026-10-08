import { ModelOptionMapError, type JsonObject, type JsonValue } from "./types.js";

export interface NamedJsonMergePatch {
  readonly option: string;
  readonly patch: JsonObject;
}

interface OwnedPath {
  readonly option: string;
  readonly path: readonly string[];
}

export function applyOrderedJsonMergePatches(
  body: JsonObject,
  patches: readonly NamedJsonMergePatch[],
): JsonObject {
  const ownedPaths: OwnedPath[] = [];
  let result = cloneJson(body) as JsonObject;
  for (const namedPatch of patches) {
    const paths = collectWrittenPaths(namedPatch.patch);
    for (const path of paths) {
      const conflict = ownedPaths.find((owned) => pathsOverlap(owned.path, path));
      if (conflict) {
        throw new ModelOptionMapError(
          `Model option maps write conflicting JSON path ${formatPath(path)}: ${conflict.option} and ${namedPatch.option}`,
        );
      }
      ownedPaths.push({ option: namedPatch.option, path });
    }
    result = mergeObject(result, namedPatch.patch);
  }
  return result;
}

function collectWrittenPaths(
  patch: JsonObject,
  prefix: readonly string[] = [],
): readonly string[][] {
  const paths: string[][] = [];
  for (const [key, value] of Object.entries(patch)) {
    const path = [...prefix, key];
    if (isJsonObject(value) && Object.keys(value).length > 0) {
      paths.push(...collectWrittenPaths(value, path));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

function pathsOverlap(left: readonly string[], right: readonly string[]): boolean {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function formatPath(path: readonly string[]): string {
  return path.length === 0 ? "$" : `$.${path.join(".")}`;
}

function mergeObject(target: JsonObject, patch: JsonObject): JsonObject {
  const result = cloneJson(target) as Record<string, JsonValue>;
  for (const [key, patchValue] of Object.entries(patch)) {
    if (patchValue === null) {
      delete result[key];
      continue;
    }
    if (isJsonObject(patchValue)) {
      const targetValue = result[key];
      result[key] = mergeObject(isJsonObject(targetValue) ? targetValue : {}, patchValue);
      continue;
    }
    result[key] = cloneJson(patchValue);
  }
  return result;
}

function cloneJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (!isJsonObject(value)) return value;
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [key, entry] of Object.entries(value)) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: cloneJson(entry),
      writable: true,
    });
  }
  return result;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
