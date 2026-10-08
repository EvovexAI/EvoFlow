import { isAbsolute, posix, relative, resolve, sep } from "node:path";

interface PluginSyncPathOptions {
  unsafePathLabel?: string;
}

export function normalizePluginSyncRelativePath(
  path: string,
  options: PluginSyncPathOptions = {},
): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/u, "").replace(/\/+$/u, "");
  if (
    !normalized ||
    isAbsolute(path) ||
    posix.isAbsolute(path) ||
    path.includes("\\") ||
    /^[a-zA-Z]:/u.test(path) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`${options.unsafePathLabel ?? "unsafe plugin sync path"}: ${path}`);
  }
  return normalized;
}

export function resolvePluginSyncPathWithin(
  targetRoot: string,
  path: string,
  options: PluginSyncPathOptions = {},
): string {
  const normalizedRoot = resolve(targetRoot);
  const normalizedPath = normalizePluginSyncRelativePath(path, options);
  const targetPath = resolve(normalizedRoot, ...normalizedPath.split("/"));
  const relativePath = relative(normalizedRoot, targetPath);
  if (
    relativePath === "" ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === ".." ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`${options.unsafePathLabel ?? "unsafe plugin sync path"}: ${path}`);
  }
  return targetPath;
}
