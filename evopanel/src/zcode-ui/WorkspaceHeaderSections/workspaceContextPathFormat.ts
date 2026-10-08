export function formatWorkspaceContextPath(path: string, home?: string): string {
  if (!home) return path;
  const normalizedPath = path.replace(/\\/g, "/");
  const normalizedHome = home.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalizedHome) return path;
  if (normalizedPath === normalizedHome) return "~";
  return normalizedPath.startsWith(`${normalizedHome}/`)
    ? `~${normalizedPath.slice(normalizedHome.length)}`
    : path;
}
