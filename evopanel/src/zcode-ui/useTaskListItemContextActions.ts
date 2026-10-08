import type { ZCodeProvider } from "@zcode/shared";
import { useCallback } from "react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useTaskNativeSessionLogFile } from "@/hooks/useTaskNativeSessionLogFile.js";
import { useTaskSessionFilePath } from "@/hooks/useTaskSessionFilePath.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import { logger } from "@/logger.js";

interface TaskPathState {
  loading: boolean;
  path: string | null;
  exists: boolean;
}

interface TaskListItemContextActionsResult {
  taskSessionFile: TaskPathState;
  taskNativeSessionLogFile: TaskPathState;
  fileManagerLabel: string;
  handleCopyText: (label: string, value: string | null) => Promise<void>;
  handleOpenTaskPathInFileManager: () => Promise<void>;
}

export function useTaskListItemContextActions({
  workspacePath,
  remoteSessionId,
  workspaceIdentity,
  taskId,
  provider,
  intl,
  loadTaskPaths = true,
}: {
  workspacePath: string;
  remoteSessionId?: string;
  workspaceIdentity?: string;
  taskId: string;
  provider?: ZCodeProvider;
  intl: {
    formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
  };
  loadTaskPaths?: boolean;
}): TaskListItemContextActionsResult {
  const platform = usePlatform();
  const workspaceOpenTarget = useWorkspaceOpenInEditorTarget({
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId: remoteSessionId,
  });
  const taskSessionFile = useTaskSessionFilePath(workspacePath, taskId, workspaceIdentity, {
    // task session/log 路径只用于右键菜单项；菜单未打开时不要在列表重排中批量触发 RPC。
    enabled: loadTaskPaths,
  });
  const taskNativeSessionLogFile = useTaskNativeSessionLogFile(
    workspacePath,
    taskId,
    provider ?? null,
    workspaceIdentity,
    { enabled: loadTaskPaths },
  );
  const handleCopyText = useCallback(async (label: string, value: string | null) => {
    if (!value) {
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      logger.info(`[TaskListItem] ${label} 已复制: ${value}`);
    } catch (error) {
      logger.warn("[TaskListItem] 复制文本失败", {
        label,
        value,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const handleOpenTaskPathInFileManager = useCallback(async () => {
    const hasRemoteWorkspaceScope = Boolean(
      remoteSessionId || workspaceIdentity?.trim() || workspaceOpenTarget.isRemoteWorkspace,
    );
    if (hasRemoteWorkspaceScope) {
      if (workspaceOpenTarget.remoteTarget?.kind !== "wsl") {
        // 远程项目路径不是宿主机路径。无法精确解析为 WSL 时必须失败关闭，
        // 避免 SSH/Docker 的 Linux 路径误落到原生 Windows、macOS 或 Linux 文件管理器。
        logger.warn("[TaskListItem] 远程 workspace 不支持本机文件管理器", {
          taskId,
          path: workspacePath,
          remoteKind: workspaceOpenTarget.remoteTarget?.kind ?? "unresolved",
        });
        return;
      }

      const result = await platform.openInEditor("explorer", workspacePath, {
        pathKind: "directory",
        remoteTarget: workspaceOpenTarget.remoteTarget,
        workspaceIdentity,
      });
      if (!result.success) {
        logger.warn("[TaskListItem] 打开 WSL workspace 路径失败", {
          taskId,
          path: workspacePath,
          error: result.error ?? "unknown-error",
        });
      }
      return;
    }

    const isMac = isMacLike();
    const isWindows = isWindowsLike();
    if (isMac || isWindows) {
      const editorId = isMac ? "finder" : "explorer";
      const result = await platform.openInEditor(editorId, workspacePath);
      if (result.success) {
        return;
      }
    }

    const result = await platform.openInFileManager(workspacePath);
    if (!result.success) {
      // Header / task 菜单里的“Open in Finder”语义应该是打开项目目录。
      // 之前这里误绑到了 task session 文件路径，菜单可用性也跟着 task 快照文件走，
      // 一旦 session 文件还没解析出来，用户会看到 Finder 入口莫名不可用。
      // 这里统一改成始终打开 workspacePath，让行为和“Copy path=项目路径”保持一致。
      logger.warn("[TaskListItem] 打开 workspace 路径失败", {
        taskId,
        path: workspacePath,
        error: result.error ?? "unknown-error",
      });
    }
  }, [
    platform,
    remoteSessionId,
    taskId,
    workspaceIdentity,
    workspaceOpenTarget.isRemoteWorkspace,
    workspaceOpenTarget.remoteTarget,
    workspacePath,
  ]);

  return {
    taskSessionFile,
    taskNativeSessionLogFile,
    fileManagerLabel: getFileManagerLabel(intl),
    handleCopyText,
    handleOpenTaskPathInFileManager,
  };
}

function isMacLike(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /mac/i.test(navigator.userAgent);
}

function isWindowsLike(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /windows/i.test(navigator.userAgent);
}

function getFileManagerLabel(intl: {
  formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
}) {
  if (isMacLike()) {
    return intl.formatMessage({ id: "appHeader.openInFinder" });
  }

  if (isWindowsLike()) {
    return intl.formatMessage({ id: "appHeader.openInFileExplorer" });
  }

  return intl.formatMessage({ id: "appHeader.openInFileManager" });
}
