import { useEffect } from "react";
import type { IFileWatcherService } from "@zcode/services";
import { logger } from "@/logger.js";

const WATCH_DEBOUNCE_MS = 300;

/** workspacePath 可能是 Windows 路径；沿用它自己的分隔符拼子目录，别把 `/` 混进 `\\` 路径。 */
function savedWorkflowsDirectoryPath(workspacePath: string): string {
  const separator = workspacePath.includes("\\") && !workspacePath.includes("/") ? "\\" : "/";
  const trimmed = workspacePath.replace(/[\\/]+$/u, "");
  return `${trimmed}${separator}.zcode${separator}workflows`;
}

/**
 * 目录监听：对话里 SaveWorkflow 落盘后中枢自动更新。
 * 目录不存在时 watch 会失败——那是常态（大多数项目没保存过工作流），静默跳过，靠切标签 / 手动
 * 刷新补上。非递归：只看这一层（Linux 上递归 fs.watch 有既知问题）。服务实例变化（远程重连）时
 * effect 依赖变化会拆掉旧 watcher 重建，旧 host 的 id 不会泄漏。
 *
 * 项目组传 `workspacePath`（拼出 `<ws>/.zcode/workflows`）；全局组传 `directory`（协议 list 回的
 * 绝对目录，即 `~/.zcode/workflows`），二者择一——`directory` 优先。
 */
export function useSavedWorkflowsDirectoryWatch({
  fileWatcherService,
  workspacePath,
  directory,
  enabled,
  refresh,
}: {
  fileWatcherService: IFileWatcherService;
  workspacePath?: string | null | undefined;
  directory?: string | null | undefined;
  enabled: boolean;
  refresh: (options: { bypassCache?: boolean }) => Promise<void>;
}): void {
  const resolvedDirectory =
    directory ?? (workspacePath ? savedWorkflowsDirectoryPath(workspacePath) : null);
  useEffect(() => {
    if (!enabled || !resolvedDirectory) return;
    let disposed = false;
    let watchId: string | null = null;
    let subscription: { dispose: () => void } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const directoryPath = resolvedDirectory;
    void fileWatcherService
      .watch({ path: directoryPath })
      .then(({ id }) => {
        if (disposed) {
          void fileWatcherService.unwatch({ id });
          return;
        }
        watchId = id;
        subscription = fileWatcherService.onDynamicChange(id)(() => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            void refresh({ bypassCache: true });
          }, WATCH_DEBOUNCE_MS);
        });
      })
      .catch((error: unknown) => {
        logger.debug("[SavedWorkflows] 监听 .zcode/workflows 失败（目录可能尚不存在）", {
          path: directoryPath,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      subscription?.dispose();
      if (watchId) void fileWatcherService.unwatch({ id: watchId });
    };
  }, [enabled, fileWatcherService, refresh, resolvedDirectory]);
}
