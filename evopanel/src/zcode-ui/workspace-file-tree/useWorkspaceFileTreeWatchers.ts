import { useEffect, useRef } from "react";
import type { IFileWatcherService } from "@zcode/services";
import { logger } from "@/logger.js";
import type { WorkspaceFileTreeWatcherRegistration } from "@/workspace-file-tree/types.js";

export function useWorkspaceFileTreeWatchers({
  fileWatcherService,
  watchedDirectoryPaths,
  onDirectoryChange,
}: {
  fileWatcherService: IFileWatcherService;
  watchedDirectoryPaths: Set<string>;
  onDirectoryChange: (path: string) => void;
}) {
  const fileWatcherServiceRef = useRef(fileWatcherService);
  const watcherGenerationRef = useRef(0);
  const watchedDirectoryPathsRef = useRef<Set<string>>(new Set());
  const watcherRegistrationsRef = useRef<Map<string, WorkspaceFileTreeWatcherRegistration>>(
    new Map(),
  );
  const pendingWatcherDirectoryPathsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const releaseWatcherRegistration = (
      directoryPath: string,
      registration: WorkspaceFileTreeWatcherRegistration,
    ) => {
      registration.subscription.dispose();
      void registration.unwatch().catch((error) => {
        logger.warn("[WorkspaceFileTree] 停止监听目录失败", {
          path: directoryPath,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };

    if (fileWatcherServiceRef.current !== fileWatcherService) {
      watcherGenerationRef.current += 1;
      for (const [directoryPath, registration] of watcherRegistrationsRef.current) {
        releaseWatcherRegistration(directoryPath, registration);
      }
      watcherRegistrationsRef.current = new Map();
      pendingWatcherDirectoryPathsRef.current = new Set();
      fileWatcherServiceRef.current = fileWatcherService;
    }

    watchedDirectoryPathsRef.current = watchedDirectoryPaths;

    for (const [directoryPath, registration] of watcherRegistrationsRef.current) {
      if (!watchedDirectoryPaths.has(directoryPath)) {
        watcherRegistrationsRef.current.delete(directoryPath);
        releaseWatcherRegistration(directoryPath, registration);
      }
    }

    for (const directoryPath of watchedDirectoryPaths) {
      if (
        watcherRegistrationsRef.current.has(directoryPath) ||
        pendingWatcherDirectoryPathsRef.current.has(directoryPath)
      ) {
        continue;
      }

      pendingWatcherDirectoryPathsRef.current.add(directoryPath);
      const watcherGeneration = watcherGenerationRef.current;
      void fileWatcherService
        .watch({ path: directoryPath })
        .then(({ id }) => {
          pendingWatcherDirectoryPathsRef.current.delete(directoryPath);
          if (
            watcherGeneration !== watcherGenerationRef.current ||
            !watchedDirectoryPathsRef.current.has(directoryPath)
          ) {
            void fileWatcherService.unwatch({ id });
            return;
          }

          const subscription = fileWatcherService.onDynamicChange(id)((event) => {
            onDirectoryChange(event.dirPath);
          });
          watcherRegistrationsRef.current.set(directoryPath, {
            id,
            subscription,
            unwatch: () => fileWatcherService.unwatch({ id }),
          });
        })
        .catch((error) => {
          pendingWatcherDirectoryPathsRef.current.delete(directoryPath);
          logger.warn("[WorkspaceFileTree] 监听目录失败", {
            path: directoryPath,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    return undefined;
  }, [fileWatcherService, onDirectoryChange, watchedDirectoryPaths]);

  useEffect(
    () => () => {
      watcherGenerationRef.current += 1;
      pendingWatcherDirectoryPathsRef.current = new Set();
      for (const [directoryPath, registration] of watcherRegistrationsRef.current) {
        registration.subscription.dispose();
        void registration.unwatch().catch((error) => {
          logger.warn("[WorkspaceFileTree] 停止监听目录失败", {
            path: directoryPath,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      watcherRegistrationsRef.current = new Map();
      watchedDirectoryPathsRef.current = new Set();
    },
    [],
  );
}
