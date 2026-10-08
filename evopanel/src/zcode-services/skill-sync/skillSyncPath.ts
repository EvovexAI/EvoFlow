import { isAbsolute, posix, relative, resolve, sep } from "node:path";

interface SkillSyncPathOptions {
  unsafePathLabel?: string;
}

export function normalizeSkillSyncRelativePath(
  path: string,
  options: SkillSyncPathOptions = {},
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
    throw new Error(`${options.unsafePathLabel ?? "unsafe skill sync path"}: ${path}`);
  }
  return normalized;
}

export function resolveSkillSyncPathWithin(
  targetRoot: string,
  path: string,
  options: SkillSyncPathOptions = {},
): string {
  const normalizedRoot = resolve(targetRoot);
  const normalizedPath = normalizeSkillSyncRelativePath(path, options);
  const targetPath = resolve(normalizedRoot, ...normalizedPath.split("/"));
  const relativePath = relative(normalizedRoot, targetPath);
  if (
    relativePath === "" ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === ".." ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`${options.unsafePathLabel ?? "unsafe skill sync path"}: ${path}`);
  }
  return targetPath;
}
