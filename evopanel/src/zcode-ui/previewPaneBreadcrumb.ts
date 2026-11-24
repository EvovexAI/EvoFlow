/** PreviewPane 面包屑路径重建（与 UI 解耦，便于单测）。 */

export function normalizeBreadcrumbPathSegments(path: string): string[] {
  return path.replace(/\\/g, "/").split("/").filter(Boolean);
}

/**
 * 面包屑文件夹段 → 绝对目录路径。
 * - under-workspace：root 段 = workspacePath；parentSegments[i] = root + 前 i+1 段
 * - 绝对路径回退：按完整 path 段重建
 */
export function resolveCodeViewerBreadcrumbFolderPath(input: {
  sourcePath?: string | null;
  workspacePath?: string | null;
  /** ``root`` 或 parent 段下标 ``0..n-1`` */
  target: "root" | number;
}): string | null {
  const sourcePath = String(input.sourcePath || "")
    .replace(/\\/g, "/")
    .trim();
  const workspacePath = String(input.workspacePath || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .trim();
  if (!sourcePath) return null;

  if (
    workspacePath &&
    (sourcePath === workspacePath || sourcePath.startsWith(`${workspacePath}/`))
  ) {
    if (input.target === "root") return workspacePath;
    const relativePath =
      sourcePath === workspacePath ? "" : sourcePath.slice(workspacePath.length + 1);
    const parents = normalizeBreadcrumbPathSegments(relativePath).slice(0, -1);
    const idx = input.target;
    if (typeof idx !== "number" || idx < 0 || idx >= parents.length) return null;
    return `${workspacePath}/${parents.slice(0, idx + 1).join("/")}`;
  }

  const segments = normalizeBreadcrumbPathSegments(sourcePath);
  if (sourcePath.startsWith("/")) {
    // POSIX：rootLabel="/"，parentSegments = 全部父段（含文件名前）
    if (input.target === "root") return "/";
    const parents = segments.slice(0, -1);
    const idx = input.target;
    if (typeof idx !== "number" || idx < 0 || idx >= parents.length) return null;
    return `/${parents.slice(0, idx + 1).join("/")}`;
  }
  // Windows ``D:/a/b/c.txt``：rootLabel=D:，parentSegments=a,b
  if (input.target === "root") return segments[0] ?? null;
  const parents = segments.slice(1, -1);
  const idx = input.target;
  if (typeof idx !== "number" || idx < 0 || idx >= parents.length) return null;
  return `${segments[0]}/${parents.slice(0, idx + 1).join("/")}`;
}
