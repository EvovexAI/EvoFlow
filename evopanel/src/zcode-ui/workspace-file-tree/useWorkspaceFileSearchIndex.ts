import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceFileEntry } from "@zcode/shared";
import {
  packWorkspaceFileEntries,
  unpackWorkspaceFileEntries,
} from "@zcode/shared/workspaceFileEntriesCodec";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { fetchWorkspaceFileEntriesPacked } from "@/workspace-file-search/fetchWorkspaceFileEntries.js";
import { useWorkspaceFileSearchFilterEntries } from "@/workspace-file-search/useWorkspaceFileSearchFilter.js";

interface WorkspaceFileSearchIndexState {
  entries: WorkspaceFileEntry[];
  loading: boolean;
  loaded: boolean;
  error: Error | null;
  refresh: () => void;
}

export function useWorkspaceFileSearchIndex({
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  enabled,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  enabled: boolean;
}): WorkspaceFileSearchIndexState {
  const { fileService } = useWorkspaceServices(
    workspacePath,
    workspaceRemoteSessionId,
    workspaceIdentity,
  );
  // packed 直存（Host 返回列式字符串）：树渲染用 useMemo unpack，搜索态直透 worker。
  const [packed, setPacked] = useState("");
  const entries = useMemo<WorkspaceFileEntry[]>(
    () => unpackWorkspaceFileEntries(packed, workspacePath),
    [packed, workspacePath],
  );
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const requestVersionRef = useRef(0);
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    setPacked("");
    setLoading(false);
    setLoaded(false);
    setError(null);
    requestVersionRef.current += 1;
  }, [workspaceIdentity, workspacePath, workspaceRemoteSessionId]);

  const refresh = useCallback(() => {
    setRefreshVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const currentVersion = requestVersionRef.current + 1;
    requestVersionRef.current = currentVersion;
    setLoading(true);
    setError(null);

    void fetchWorkspaceFileEntriesPacked(fileService, workspacePath)
      .then((result) => {
        if (requestVersionRef.current !== currentVersion) {
          return;
        }
        setPacked(result);
        setLoaded(true);
      })
      .catch((nextError) => {
        if (requestVersionRef.current !== currentVersion) {
          return;
        }
        setError(nextError instanceof Error ? nextError : new Error(String(nextError)));
      })
      .finally(() => {
        if (requestVersionRef.current === currentVersion) {
          setLoading(false);
        }
      });
  }, [enabled, fileService, refreshVersion, workspacePath]);

  return {
    entries,
    loading,
    loaded,
    error,
    refresh,
  };
}

export function useWorkspaceFileSearchResults({
  entries,
  query,
  workspacePath,
}: {
  entries: WorkspaceFileEntry[];
  query: string;
  workspacePath: string;
}): WorkspaceFileEntry[] {
  // 打分在 Web Worker 执行（与 @ 文件候选共用同一过滤语义与降级路径）。
  // 入参是树已解包的 entries（渲染复用），这里重新 pack 一次（~31ms@37 万）
  // 交给 worker——避免调用方为搜索单独维护一份 packed 状态。
  // requireQuery: true 保持"空 query 不出结果"的文件树搜索行为。
  const packed = useMemo(() => packWorkspaceFileEntries(entries), [entries]);
  const { items } = useWorkspaceFileSearchFilterEntries(
    packed,
    query,
    { requireQuery: true },
    workspacePath,
  );
  return items;
}
