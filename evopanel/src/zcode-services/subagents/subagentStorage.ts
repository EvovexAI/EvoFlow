import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const HOME_PREFIX = "~/";

export interface SubagentStorageOptions {
  homeDir?: string;
}

export function resolveUserHomeDir(options?: SubagentStorageOptions): string {
  if (options?.homeDir && options.homeDir.trim().length > 0) {
    return options.homeDir;
  }
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

export async function resolveUserSubagentRoot(options?: SubagentStorageOptions): Promise<string> {
  return join(await resolveZCodeStorageRoot(options), "agents");
}

export function resolveWorkspaceSubagentRoot(workspacePath: string): string {
  return join(workspacePath, ".zcode", "agents");
}

export async function resolveSubagentStateFile(options?: SubagentStorageOptions): Promise<string> {
  return join(await resolveZCodeStorageRoot(options), "v2", "agents-state.json");
}

export async function resolveZCodeStorageRoot(options?: SubagentStorageOptions): Promise<string> {
  const config = await readUserCliConfig(options);
  const storage = isObjectRecord(config.storage) ? config.storage : {};
  const storageDir =
    typeof storage.dir === "string" && storage.dir.trim().length > 0
      ? storage.dir.trim()
      : "~/.zcode";
  return resolveConfigPath(storageDir, options);
}

export function resolveConfigPath(path: string, options?: SubagentStorageOptions): string {
  const expanded = path.startsWith(HOME_PREFIX)
    ? join(resolveUserHomeDir(options), path.slice(HOME_PREFIX.length))
    : path;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

async function readUserCliConfig(
  options?: SubagentStorageOptions,
): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(
      join(resolveUserHomeDir(options), ".zcode", "cli", "config.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as unknown;
    return isObjectRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
