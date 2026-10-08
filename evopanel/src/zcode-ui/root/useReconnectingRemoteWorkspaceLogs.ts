import { useCallback, useEffect, useRef, useState } from "react";
import type { IPlatformService } from "@zcode/shared";
import {
  appendRemoteConnectionRuntimeLog,
  normalizeRemoteConnectionLogMessage,
  type RemoteConnectionLogEntry,
} from "@/hooks/useRemoteConnectionLogs.js";
import { resolveRemoteWorkspaceReconnectLogWorkspaceKeys } from "@/root/reconnectingRemoteWorkspaceLogs.js";

const RECONNECT_RUNTIME_LOG_LIMIT = 50;

export function useReconnectingRemoteWorkspaceLogs({
  platform,
  reconnectingWorkspaceKeys,
  resolveWorkspaceTargetByKey,
  resolveWorkspaceRequestIdByKey,
}: {
  platform: IPlatformService;
  reconnectingWorkspaceKeys: string[];
  resolveWorkspaceTargetByKey: (
    workspaceKey: string,
  ) => import("@zcode/shared").RemoteWorkspaceSessionEntry["target"] | null;
  resolveWorkspaceRequestIdByKey?: (workspaceKey: string) => string | null;
}) {
  const reconnectingWorkspaceKeysRef = useRef<string[]>([]);
  const [logsByWorkspaceKey, setLogsByWorkspaceKey] = useState<
    Record<string, RemoteConnectionLogEntry[]>
  >({});

  useEffect(() => {
    reconnectingWorkspaceKeysRef.current = reconnectingWorkspaceKeys;
    const reconnectingWorkspaceKeySet = new Set(reconnectingWorkspaceKeys);
    setLogsByWorkspaceKey((current) => {
      const nextEntries = Object.entries(current).filter(([workspaceKey]) =>
        reconnectingWorkspaceKeySet.has(workspaceKey),
      );
      if (nextEntries.length === Object.keys(current).length) {
        return current;
      }
      return Object.fromEntries(nextEntries);
    });
  }, [reconnectingWorkspaceKeys]);

  useEffect(() => {
    const unsubscribe = platform.onRemoteConnectionLog((entry) => {
      const normalizedMessage = normalizeRemoteConnectionLogMessage(entry.message);
      if (!normalizedMessage) {
        return;
      }

      const reconnectingKeys = reconnectingWorkspaceKeysRef.current;
      if (reconnectingKeys.length === 0) {
        return;
      }

      const reconnectingEntries = reconnectingKeys.flatMap((workspaceKey) => {
        const target = resolveWorkspaceTargetByKey(workspaceKey);
        return target
          ? [
              {
                workspaceKey,
                requestId: resolveWorkspaceRequestIdByKey?.(workspaceKey) ?? undefined,
                target,
              },
            ]
          : [];
      });

      const matchedWorkspaceKeys = resolveRemoteWorkspaceReconnectLogWorkspaceKeys({
        runtimeLabel: entry.label,
        runtimeRequestId: entry.requestId,
        reconnectingEntries,
      });
      if (matchedWorkspaceKeys.length === 0) {
        return;
      }

      setLogsByWorkspaceKey((current) => {
        let next = current;
        for (const workspaceKey of matchedWorkspaceKeys) {
          const currentLogs = next[workspaceKey] ?? [];
          const nextLogs = appendRemoteConnectionRuntimeLog(currentLogs, {
            id: `${entry.label}-${entry.timestamp}-${currentLogs.length}`,
            level: entry.level,
            message: normalizedMessage,
            timestamp: entry.timestamp,
          }).slice(-RECONNECT_RUNTIME_LOG_LIMIT);
          if (next === current) {
            next = { ...current };
          }
          next[workspaceKey] = nextLogs;
        }
        return next;
      });
    });

    return unsubscribe;
  }, [platform, resolveWorkspaceRequestIdByKey, resolveWorkspaceTargetByKey]);

  const resetLogsForWorkspaceKey = useCallback((workspaceKey: string) => {
    setLogsByWorkspaceKey((current) => ({
      ...current,
      [workspaceKey]: [],
    }));
  }, []);

  return {
    logsByWorkspaceKey,
    resetLogsForWorkspaceKey,
  };
}
