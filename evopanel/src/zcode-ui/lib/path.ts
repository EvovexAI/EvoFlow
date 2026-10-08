const WINDOWS_ABSOLUTE_PATH_RE = /^[a-zA-Z]:[\\/]/;
const UNC_PATH_RE = /^\\\\/;
const URI_ESCAPE_RE = /%[0-9A-Fa-f]{2}/;

export function getPathLeaf(path: string): string {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalizedPath.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

export function getContainingDirectoryPath(path: string): string | null {
  const trimmedPath = path.trim().replace(/[\\/]+$/, "");
  if (!trimmedPath) {
    return null;
  }

  const lastSeparatorIndex = Math.max(trimmedPath.lastIndexOf("/"), trimmedPath.lastIndexOf("\\"));

  if (lastSeparatorIndex < 0) {
    return null;
  }

  if (lastSeparatorIndex === 0) {
    return trimmedPath[0] ?? null;
  }

  const parentPath = trimmedPath.slice(0, lastSeparatorIndex);
  if (/^[A-Za-z]:$/.test(parentPath)) {
    return `${parentPath}${trimmedPath[lastSeparatorIndex] ?? "\\"}`;
  }

  return parentPath || null;
}

export function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith("/") || WINDOWS_ABSOLUTE_PATH_RE.test(path) || UNC_PATH_RE.test(path);
}

export function decodeFilePathUriEscapes(path: string): string {
  if (!URI_ESCAPE_RE.test(path)) {
    return path;
  }

  try {
    // markdown/tool 输出里的本地文件路径可能已经按 URI 编码，
    // 例如 workspace 名里的空格会变成 %20。这里用 decodeURI 只还原路径文本，
    // 保留 %2F 这类分隔符转义，避免把文件名内容误拆成新的路径层级。
    return decodeURI(path);
  } catch {
    return path;
  }
}

export function joinFilePath(basePath: string, childPath: string): string {
  if (!childPath) {
    return basePath;
  }

  if (isAbsoluteFilePath(childPath)) {
    return childPath;
  }

  const separator = basePath.includes("\\") && !basePath.includes("/") ? "\\" : "/";
  const normalizedBasePath = basePath.replace(/[\\/]+$/, "");
  const normalizedChildPath = childPath.replace(/^[\\/]+/, "");
  return `${normalizedBasePath}${separator}${normalizedChildPath}`;
}

// encodeURI 不转义 # 和 ?，但它们在 URL 里是 fragment/query 分隔符。
// 文件名包含 # 时（如 index#v2.html）生成的 file URL 会被下游 URL 解析截断 pathname
// （只剩 /E:/dir/index），shell 打开必然失败。这里在 encodeURI 之后补转义。
function encodeUriPathForFileUrl(value: string): string {
  return encodeURI(value).replace(/#/g, "%23").replace(/\?/g, "%3F");
}

export function toFileUrl(path: string): string {
  const normalizedPath = path.replace(/\\/g, "/");

  if (WINDOWS_ABSOLUTE_PATH_RE.test(path)) {
    return `file:///${encodeUriPathForFileUrl(normalizedPath)}`;
  }

  if (normalizedPath.startsWith("/")) {
    return `file://${encodeUriPathForFileUrl(normalizedPath)}`;
  }

  if (UNC_PATH_RE.test(path)) {
    return `file:${encodeUriPathForFileUrl(normalizedPath)}`;
  }

  return encodeUriPathForFileUrl(normalizedPath);
}
