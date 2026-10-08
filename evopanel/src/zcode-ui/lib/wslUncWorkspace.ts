const WSL_UNC_PATH_PATTERN = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)(?:[\\/](.*))?$/iu;

interface WslUncWorkspacePath {
  distro: string;
  linuxPath: string;
  originalPath: string;
}

export function parseWslUncWorkspacePath(path: string): WslUncWorkspacePath | null {
  const normalizedPath = path.trim();
  const match = normalizedPath.match(WSL_UNC_PATH_PATTERN);
  const distro = match?.[1]?.trim();
  if (!match || !distro) {
    return null;
  }

  const tail = (match[2] ?? "").replaceAll("\\", "/").replace(/^\/+/, "");
  return {
    distro,
    linuxPath: tail ? `/${tail}` : "/",
    originalPath: path,
  };
}
