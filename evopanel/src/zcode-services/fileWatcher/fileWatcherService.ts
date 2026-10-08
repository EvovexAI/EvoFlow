import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { Emitter, Event, type Event as RpcEvent } from "@zcode/rpc";
import type { FileWatchEvent } from "@zcode/shared";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import type { IFileWatcherService } from "./fileWatcher.js";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

/** 防抖时间（ms）——批量文件变更（如 git checkout）时避免频繁刷新 */
const DEBOUNCE_MS = 150;

interface WatcherInstance {
  path: string;
  watcher: FSWatcher;
  changeEmitter: Emitter<FileWatchEvent>;
  /** 防抖定时器 */
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** 同一防抖窗口只含一个明确路径时才透传，避免过滤掉同批次里的目标文件事件 */
  pendingChangedPaths: Set<string>;
  hasUnknownChangedPath: boolean;
}

function resolveFileWatchChangedPath(
  watchedDirectoryPath: string,
  fileName: string | Buffer | null,
): string | undefined {
  if (fileName === null) {
    return undefined;
  }
  const normalizedFileName = fileName.toString().trim();
  return normalizedFileName ? resolve(watchedDirectoryPath, normalizedFileName) : undefined;
}

export function createFileWatcherService(options?: {
  logger?: ServiceLogger;
}): IFileWatcherService {
  const log = options?.logger ?? createServiceLogger("file-watcher");
  const watchers = new Map<string, WatcherInstance>();
  let nextId = 0;
  // 内存诊断计数器：客户端断连不回收 watcher 时
  // 这里会只增不减。
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("fileWatcher", () => ({
    open: watchers.size,
  }));

  function cleanup(id: string): void {
    const w = watchers.get(id);
    if (!w) return;
    if (w.debounceTimer) clearTimeout(w.debounceTimer);
    w.watcher.close();
    w.changeEmitter.dispose();
    watchers.delete(id);
  }

  return {
    async watch(params: { path: string; recursive?: boolean }): Promise<{ id: string }> {
      const id = String(nextId++);
      const changeEmitter = new Emitter<FileWatchEvent>();
      const recursive = params.recursive ?? false;

      let fsWatcher: FSWatcher;
      try {
        // 默认非递归监视单个目录；Git 状态这类工作区级信号会显式打开 recursive。
        fsWatcher = watch(params.path, { recursive }, (_eventType, fileName) => {
          const instance = watchers.get(id);
          if (!instance) return;

          const changedPath = resolveFileWatchChangedPath(instance.path, fileName);
          if (changedPath) {
            instance.pendingChangedPaths.add(changedPath);
          } else {
            instance.hasUnknownChangedPath = true;
          }

          // 防抖：连续变更只触发一次刷新
          if (instance.debounceTimer) clearTimeout(instance.debounceTimer);
          instance.debounceTimer = setTimeout(() => {
            instance.debounceTimer = null;
            const onlyChangedPath =
              !instance.hasUnknownChangedPath && instance.pendingChangedPaths.size === 1
                ? instance.pendingChangedPaths.values().next().value
                : undefined;
            instance.pendingChangedPaths.clear();
            instance.hasUnknownChangedPath = false;
            instance.changeEmitter.fire({
              dirPath: instance.path,
              ...(onlyChangedPath ? { changedPath: onlyChangedPath } : {}),
            });
          }, DEBOUNCE_MS);
        });
      } catch (error) {
        changeEmitter.dispose();
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`无法监视目录 '${params.path}': ${message}`);
      }

      // 监视目录被删除/重命名时，发送最终事件并清理
      fsWatcher.on("error", (error) => {
        const instance = watchers.get(id);
        if (instance) {
          log.warn(undefined, "文件监听器异常，清理 watcher", {
            id,
            path: instance.path,
            error: error instanceof Error ? error.message : String(error),
          });
          instance.changeEmitter.fire({ dirPath: instance.path });
          cleanup(id);
        }
      });

      watchers.set(id, {
        path: params.path,
        watcher: fsWatcher,
        changeEmitter,
        debounceTimer: null,
        pendingChangedPaths: new Set(),
        hasUnknownChangedPath: false,
      });

      return { id };
    },

    async unwatch(params: { id: string }): Promise<void> {
      cleanup(params.id);
    },

    disposeAll(): void {
      memoryDiagnostics.dispose();
      const ids = Array.from(watchers.keys());
      for (const id of ids) {
        cleanup(id);
      }
    },

    onDynamicChange(id: string): RpcEvent<FileWatchEvent> {
      const watcher = watchers.get(id);
      if (!watcher) {
        // watch() 成功返回后，renderer 订阅 onDynamicChange 前，底层 fs.watch
        // 仍可能因目录删除/重命名/平台 watcher 错误触发 cleanup。stale watcher id
        // 是可恢复状态，不能 throw 到 RPC 事件订阅链路导致 host 进程退出。
        log.warn(undefined, "忽略已失效的文件监听订阅", { id });
        return Event.None;
      }
      return watcher.changeEmitter.event;
    },
  };
}
