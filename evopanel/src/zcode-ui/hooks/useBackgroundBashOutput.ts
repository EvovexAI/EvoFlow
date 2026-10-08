import { useCallback, useEffect, useRef, useState } from "react";
import type { BackgroundBashOutput, BackgroundBashOutputResult } from "@zcode/shared";
import { useZCodeAgentService } from "@/hooks/useZCodeAgentService.js";
import { ensureAgentV4ConnectionHandshake } from "@/v4/agentV4ConnectionHandshake.js";
import { logger } from "@/logger.js";

interface BackgroundBashOutputTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
  workId: string;
}

export function useBackgroundBashOutput(target: BackgroundBashOutputTarget, visible: boolean) {
  const { workspacePath, workspaceIdentity, remoteSessionId, sessionId, workId } = target;
  const service = useZCodeAgentService(workspacePath, remoteSessionId, workspaceIdentity);
  const [latest, setLatest] = useState<BackgroundBashOutput | null>(null);
  const [frozen, setFrozen] = useState<BackgroundBashOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const inFlight = useRef<Promise<BackgroundBashOutputResult> | null>(null);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    setLatest(null);
    setFrozen(null);
    setError(null);
  }, [workspacePath, workspaceIdentity, remoteSessionId, sessionId, workId]);

  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      // 隐藏后重新打开时，旧请求仍可能在途；等其结束，但绝不应用旧响应。
      if (inFlight.current) await inFlight.current.catch(() => undefined);
      if (disposed) return;
      const request = (async () => {
        await ensureAgentV4ConnectionHandshake(service);
        return service.backgroundBashOutputV4({
          workspacePath,
          workspaceIdentity,
          remoteSessionId,
          sessionId,
          workId,
        });
      })();
      inFlight.current = request;
      try {
        const result = await request;
        if (disposed) return;
        if (result.kind !== "output") {
          setError(result.kind);
          return;
        }
        setLatest(result);
        setError(null);
        if (result.status === "running") timer = setTimeout(() => void poll(), 1000);
      } catch (cause) {
        if (!disposed) {
          logger.debug("Background Bash output query failed", { workId, cause });
          setError("query_failed");
        }
      } finally {
        if (inFlight.current === request) inFlight.current = null;
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [
    service,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    sessionId,
    workId,
    visible,
    revision,
  ]);

  return {
    latest,
    display: frozen ?? latest,
    error,
    refresh,
    following: frozen === null,
    pause: () => setFrozen((current) => current ?? latest),
    resume: () => {
      setFrozen(null);
      refresh();
    },
  };
}
