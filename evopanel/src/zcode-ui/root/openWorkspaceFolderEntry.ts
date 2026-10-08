import { logger } from "@/logger.js";

export async function openFolderFromWorkspaceEntry({
  selectDirectory,
  openDirectoryBrowser,
  preferDirectoryBrowser = false,
  onSelectProject,
}: {
  selectDirectory?: () => Promise<string | null>;
  openDirectoryBrowser?: () => void;
  preferDirectoryBrowser?: boolean;
  onSelectProject: (path: string) => void;
}) {
  if (preferDirectoryBrowser) {
    if (!openDirectoryBrowser) {
      logger.warn("[openWorkspaceFolderEntry] directory browser preferred but unavailable");
      return;
    }
    // Web/server 根节点没有系统目录选择框，继续调用 selectDirectory 只会返回 null。
    // 这里显式切到服务端目录浏览器，确保用户选择的是目标 host 上的路径。
    logger.info("[openWorkspaceFolderEntry] opening service directory browser...");
    openDirectoryBrowser();
    return;
  }

  if (!selectDirectory) {
    return;
  }

  logger.info("[openWorkspaceFolderEntry] calling selectDirectory...");
  try {
    const dir = await selectDirectory();
    logger.info("[openWorkspaceFolderEntry] selectDirectory returned:", dir);
    if (dir) {
      onSelectProject(dir);
    } else {
      logger.info("[openWorkspaceFolderEntry] user cancelled or dir is null");
    }
  } catch (err) {
    logger.error("[openWorkspaceFolderEntry] selectDirectory threw:", err);
  }
}
