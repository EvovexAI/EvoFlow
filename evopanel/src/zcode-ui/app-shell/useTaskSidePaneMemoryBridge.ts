import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitChangeSourceId } from "@zcode/shared";
import {
  buildTaskSidePaneMemoryKey,
  readTaskSidePaneMemoryState,
  saveTaskSidePaneMemoryState,
} from "@/lib/taskSidePaneMemory.js";

export function useTaskSidePaneMemoryBridge({
  activeTaskId,
  gitSelectedSourceId,
  setGitSelectedSourceId,
  workspaceAbsPath,
  workspaceIdentity,
}: {
  activeTaskId: string | null;
  gitSelectedSourceId: GitChangeSourceId;
  setGitSelectedSourceId: (value: GitChangeSourceId) => void;
  workspaceAbsPath: string;
  workspaceIdentity?: string;
}) {
  const memoryKey = useMemo(
    () =>
      buildTaskSidePaneMemoryKey({
        workspacePath: workspaceAbsPath,
        workspaceIdentity,
        taskId: activeTaskId,
      }),
    [activeTaskId, workspaceAbsPath, workspaceIdentity],
  );
  const activeGitSourceMemoryKeyRef = useRef<string | null>(memoryKey);
  const [browserRestoreUrls, setBrowserRestoreUrls] = useState(() => {
    const restored = readTaskSidePaneMemoryState(memoryKey);
    return restored.browserUrl
      ? { browser: restored.browserUrl, ...restored.browserUrls }
      : restored.browserUrls;
  });
  const latestGitSourceRef = useRef(gitSelectedSourceId);
  latestGitSourceRef.current = gitSelectedSourceId;

  useEffect(() => {
    const previousKey = activeGitSourceMemoryKeyRef.current;
    if (previousKey === memoryKey) {
      return;
    }

    // Git pane 的 source 和 Browser URL 都属于 workspace 级 side pane UI 状态。
    // 切换 workspace 前先写回旧 key，再恢复新 key，避免 Review/Browser tab 回来后重置。
    // 同一 workspace 内切换 task 时，这里会继续复用同一个 key，不再把内容误判成另一份状态。
    saveTaskSidePaneMemoryState(previousKey, {
      activeGitSourceId: latestGitSourceRef.current,
    });
    const restored = readTaskSidePaneMemoryState(memoryKey);
    activeGitSourceMemoryKeyRef.current = memoryKey;
    setGitSelectedSourceId(restored.activeGitSourceId);
    setBrowserRestoreUrls(
      restored.browserUrl
        ? { browser: restored.browserUrl, ...restored.browserUrls }
        : restored.browserUrls,
    );
  }, [memoryKey, setGitSelectedSourceId]);

  useEffect(() => {
    return () => {
      saveTaskSidePaneMemoryState(activeGitSourceMemoryKeyRef.current, {
        activeGitSourceId: latestGitSourceRef.current,
      });
    };
  }, []);

  const handleBrowserUrlChange = useCallback(
    (tabId: string, url: string) => {
      setBrowserRestoreUrls((current) => ({
        ...current,
        [tabId]: url,
      }));
      saveTaskSidePaneMemoryState(memoryKey, {
        browserUrls: {
          ...readTaskSidePaneMemoryState(memoryKey).browserUrls,
          [tabId]: url,
        },
      });
    },
    [memoryKey],
  );

  return {
    browserRestoreUrls,
    handleBrowserUrlChange,
  };
}
