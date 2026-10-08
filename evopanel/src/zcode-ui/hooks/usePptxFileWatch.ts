import { useEffect, useState } from "react";
import type { IDisposable } from "@zcode/rpc";
import type { IFileWatcherService } from "@zcode/services";
import type { FileWatchEvent } from "@zcode/shared";
import { logger } from "@/logger.js";
import { getContainingDirectoryPath } from "@/lib/path.js";

interface PptxFileWatchSnapshot {
  filePath: string | null;
  fileWatcherService: IFileWatcherService | null;
  ready: boolean;
  reloadGeneration: number;
}

function normalizeFileWatchPathForCompare(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

function shouldReloadPptxPreviewForWatchEvent(event: FileWatchEvent, filePath: string): boolean {
  if (!event.changedPath) {
    return true;
  }
  return (
    normalizeFileWatchPathForCompare(event.changedPath) ===
    normalizeFileWatchPathForCompare(filePath)
  );
}

export function usePptxFileWatch({
  filePath,
  fileWatcherService,
}: {
  filePath: string | null;
  fileWatcherService: IFileWatcherService;
}): { ready: boolean; reloadGeneration: number } {
  const [snapshot, setSnapshot] = useState<PptxFileWatchSnapshot>({
    filePath: null,
    fileWatcherService: null,
    ready: false,
    reloadGeneration: 0,
  });

  useEffect(() => {
    let cancelled = false;
    let watcherId: string | null = null;
    let subscription: IDisposable | null = null;

    setSnapshot({
      filePath,
      fileWatcherService,
      ready: false,
      reloadGeneration: 0,
    });
    if (!filePath) {
      return () => {
        cancelled = true;
      };
    }

    const directoryPath = getContainingDirectoryPath(filePath);
    if (!directoryPath) {
      setSnapshot({
        filePath,
        fileWatcherService,
        ready: true,
        reloadGeneration: 0,
      });
      return () => {
        cancelled = true;
      };
    }

    void fileWatcherService
      .watch({ path: directoryPath })
      .then(({ id }) => {
        if (cancelled) {
          void fileWatcherService.unwatch({ id });
          return;
        }
        watcherId = id;
        subscription = fileWatcherService.onDynamicChange(id)((event) => {
          if (!shouldReloadPptxPreviewForWatchEvent(event, filePath)) {
            return;
          }
          logger.debug("[PptxFileWatch] 源文件发生变化，刷新已打开预览", {
            path: filePath,
            changedPath: event.changedPath,
          });
          setSnapshot((current) =>
            current.filePath === filePath && current.fileWatcherService === fileWatcherService
              ? {
                  ...current,
                  ready: true,
                  reloadGeneration: current.reloadGeneration + 1,
                }
              : current,
          );
        });
        setSnapshot((current) =>
          current.filePath === filePath && current.fileWatcherService === fileWatcherService
            ? { ...current, ready: true }
            : current,
        );
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        // 文件监听只负责自动刷新；注册失败时仍允许首次读取和手动重新打开文件。
        logger.warn("[PptxFileWatch] 监听 PPTX 所在目录失败", {
          path: filePath,
          directoryPath,
          error: error instanceof Error ? error.message : String(error),
        });
        setSnapshot((current) =>
          current.filePath === filePath && current.fileWatcherService === fileWatcherService
            ? { ...current, ready: true }
            : current,
        );
      });

    return () => {
      cancelled = true;
      subscription?.dispose();
      if (watcherId) {
        void fileWatcherService.unwatch({ id: watcherId }).catch((error: unknown) => {
          logger.warn("[PptxFileWatch] 停止监听 PPTX 所在目录失败", {
            path: filePath,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    };
  }, [filePath, fileWatcherService]);

  // 远程重连或 Host 替换会在 source path 不变时切换 workspace service。
  // ready 必须属于当前 watcher service，不能在 effect 清理前复用旧 service 的订阅状态。
  return snapshot.filePath === filePath && snapshot.fileWatcherService === fileWatcherService
    ? {
        ready: snapshot.ready,
        reloadGeneration: snapshot.reloadGeneration,
      }
    : { ready: false, reloadGeneration: 0 };
}
