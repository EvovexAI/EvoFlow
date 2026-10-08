import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, dirname, join, resolve as resolvePath } from "node:path";
import { getRuntimeToolRuntime, type RuntimeToolId } from "@zcode/shared";

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveExistingPath(candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    if (existsSync(candidate) && isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveCommandOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const pathEnv = env.PATH;
  if (!pathEnv) {
    return null;
  }

  const windowsPathExt =
    process.platform === "win32"
      ? (env.PATHEXT?.split(";").filter(Boolean) ?? [".EXE", ".CMD", ".BAT", ".COM"])
      : [""];
  const extensions = process.platform === "win32" && !command.includes(".") ? windowsPathExt : [""];

  for (const pathEntry of pathEnv.split(delimiter)) {
    if (!pathEntry) {
      continue;
    }

    for (const extension of extensions) {
      const candidate = join(pathEntry, `${command}${extension}`);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function resolvePlatformScopedBundledToolRoots(moduleDir?: string): Array<string | null> {
  const platformKey = `${process.platform}-${process.arch}`;
  return [
    resolvePath(process.cwd(), "bundled-tools", platformKey),
    resolvePath(process.cwd(), "packages", "desktop", "bundled-tools", platformKey),
    resolvePath(process.cwd(), "..", "desktop", "bundled-tools", platformKey),
    moduleDir
      ? resolvePath(moduleDir, "..", "..", "..", "desktop", "bundled-tools", platformKey)
      : null,
    moduleDir ? resolvePath(moduleDir, "..", "..", "desktop", "bundled-tools", platformKey) : null,
  ];
}

export function prependPathEntries(
  currentPath: string | undefined,
  entries: readonly string[],
): string {
  const normalizedCurrent = currentPath?.split(delimiter).filter(Boolean) ?? [];
  return joinUniquePathEntries([...entries, ...normalizedCurrent]);
}

export function appendPathEntries(
  currentPath: string | undefined,
  entries: readonly string[],
): string {
  const normalizedCurrent = currentPath?.split(delimiter).filter(Boolean) ?? [];
  return joinUniquePathEntries([...normalizedCurrent, ...entries]);
}

function joinUniquePathEntries(entries: readonly string[]): string {
  const nextEntries: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!entry || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    nextEntries.push(entry);
  }

  return nextEntries.join(delimiter);
}

function findRuntimeToolBinary(
  toolId: RuntimeToolId,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const runtime = getRuntimeToolRuntime(toolId);
  const entrySegments = runtime.resolveEntrySegments(process.platform);
  const envPath = env[runtime.binaryEnvVar]?.trim();
  if (envPath && existsSync(envPath) && isExecutableFile(envPath)) {
    return envPath;
  }

  const resourcesPath =
    typeof (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath === "string"
      ? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
      : null;
  const runtimeRoot = env.ZCODE_SERVER_RUNTIME_ROOT?.trim();
  const moduleDir: string | undefined = import.meta.dirname;
  const candidate = resolveExistingPath([
    runtimeRoot
      ? resolvePath(runtimeRoot, "tools", runtime.bundledResourceDir, ...entrySegments)
      : null,
    resourcesPath
      ? resolvePath(resourcesPath, "tools", runtime.bundledResourceDir, ...entrySegments)
      : null,
    ...resolvePlatformScopedBundledToolRoots(moduleDir).map((root) =>
      root ? resolvePath(root, runtime.bundledResourceDir, ...entrySegments) : null,
    ),
  ]);

  if (candidate) {
    return candidate;
  }

  const binaryName = entrySegments[entrySegments.length - 1];
  if (!binaryName) {
    return null;
  }

  return resolveCommandOnPath(binaryName.replace(/\.exe$/i, ""), env);
}

export function buildRuntimeToolEnvPatch(
  toolIds: readonly RuntimeToolId[],
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const envPatch: Record<string, string> = {};
  const pathEntries: string[] = [];

  for (const toolId of toolIds) {
    const runtime = getRuntimeToolRuntime(toolId);
    const binaryPath = findRuntimeToolBinary(toolId, baseEnv);
    if (!binaryPath) {
      continue;
    }

    envPatch[runtime.binaryEnvVar] = binaryPath;
    pathEntries.push(dirname(binaryPath));
  }

  if (pathEntries.length > 0) {
    envPatch.PATH = appendPathEntries(baseEnv.PATH, pathEntries);
  }

  return envPatch;
}
