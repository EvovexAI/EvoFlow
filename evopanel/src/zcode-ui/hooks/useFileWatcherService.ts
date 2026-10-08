/**
 * useFileWatcherService —— 文件系统监视 hooks
 *
 * 在 useReaddir 基础上增加 fs.watch 订阅。
 * 目录内容变更时自动 refresh，无需手动刷新。
 */
import { useState, useEffect, useCallback } from "react";
import type { FileEntry } from "@zcode/shared";
import type { IDisposable } from "@zcode/rpc";
import { useServices } from "./useServices.js";
import { logger } from "@/logger.js";

/**
 * 带文件系统监视的目录读取 hook
 *
 * 与 useReaddir 接口一致，但在挂载时自动 watch 目录，
 * 收到变更事件时自动 refresh。卸载时自动 unwatch。
 */
export function useWatchedReaddir(path: string) {
  const { fileService, fileWatcherService } = useServices();
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fileService.readdir({ path });
      setEntries(result);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  }, [fileService, path]);

  // 初始读取
  useEffect(() => {
    refresh();
  }, [refresh]);

  // 文件系统监视：挂载时 watch，卸载时 unwatch
  useEffect(() => {
    let cancelled = false;
    let watcherId: string | null = null;
    const disposables: IDisposable[] = [];

    // 用 ref 保存 refresh 引用，避免事件回调闭包过期
    const refreshRef = { current: refresh };

    fileWatcherService
      .watch({ path })
      .then(({ id }) => {
        if (cancelled) {
          // 组件已卸载，立即释放 watcher
          fileWatcherService.unwatch({ id });
          return;
        }
        watcherId = id;

        // 订阅变更事件，收到时自动刷新目录列表
        const sub = fileWatcherService.onDynamicChange(id)(() => {
          logger.info(`[FileWatcher] 目录变更，自动刷新 path=${path}`);
          refreshRef.current();
        });
        disposables.push(sub);
      })
      .catch((err) => {
        // watch 失败不影响基础功能（readdir 仍可用），仅记录日志
        if (!cancelled) {
          logger.warn(`[FileWatcher] 监视目录失败 path=${path}:`, err);
        }
      });

    return () => {
      cancelled = true;
      for (const d of disposables) d.dispose();
      if (watcherId) fileWatcherService.unwatch({ id: watcherId });
    };
  }, [fileWatcherService, path, refresh]);

  return { entries, loading, error, refresh };
}
