import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkflowRunWorkspaceNode } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

/**
 * 一个 workflow run 的脚本 transcript 清单。
 *
 * ```
 * 活投影 run.lastEventSequence 抬升 ──┐（刷新信号：每个节点事件都会抬它）
 *                                    ├─▶ workflowRunWorkspace({sessionId, runId}) ─▶ nodes[]
 * tab 打开 / 切 run ─────────────────┘
 * ```
 *
 * 清单**不带正文**，重查便宜；正文在 `useWorkflowRunNodeResult` 里按需取。信号抬升后
 * 合并 250 ms 再查：一次 `world.run` 结算前后有 queued / dispatched / settled 三个事件，
 * 逐个重查只是把同一份清单读三遍。
 */

const REFRESH_DEBOUNCE_MS = 250;

interface WorkflowRunWorkspaceState {
  nodes: readonly WorkflowRunWorkspaceNode[];
  /** 至少成功读过一次（占位与落点都等它）。 */
  loaded: boolean;
  loading: boolean;
  /** 清单被网关截尾（超过 maxNodes）。 */
  truncated: boolean;
  /** 会话不支持工作区查询（老 CLI）。 */
  unavailable: boolean;
  error: string | null;
}

/** 能力缺席的判据同产物 hook：跨 JSON-RPC 之后只剩 message 可靠。 */
function isWorkflowRunWorkspaceCapabilityMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("capabilityUnsupported") || message.includes("WorkspaceNodes");
}

export function useWorkflowRunWorkspace(options: {
  sessionId: string;
  runId: string;
  /** 刷新信号：活投影里该 run 的 `lastEventSequence`；run 不在投影里时缺席（只查一次）。 */
  refreshSignal?: number;
  enabled?: boolean;
}): WorkflowRunWorkspaceState {
  const { workflowRunWorkspace } = useV4Conversation();
  const [nodes, setNodes] = useState<readonly WorkflowRunWorkspaceNode[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 请求版本号：切 run / 切会话后的迟到响应必须被丢弃。
  const requestVersionRef = useRef(0);

  const { runId, sessionId } = options;
  const enabled = options.enabled !== false && sessionId.length > 0 && runId.length > 0;

  const fetchNodes = useCallback(async () => {
    const requestVersion = ++requestVersionRef.current;
    setLoading(true);
    try {
      const result = await workflowRunWorkspace({ sessionId, runId });
      if (requestVersion !== requestVersionRef.current) return;
      setNodes(result.nodes);
      setTruncated(result.truncated === true);
      setUnavailable(false);
      setError(null);
      setLoaded(true);
      setLoading(false);
    } catch (caught) {
      if (requestVersion !== requestVersionRef.current) return;
      setLoading(false);
      if (isWorkflowRunWorkspaceCapabilityMissing(caught)) {
        setUnavailable(true);
        setLoaded(true);
        return;
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      logger.warn("[workflow-workspace] 读取工作区清单失败", { error: message, runId, sessionId });
      setError(message);
    }
  }, [runId, sessionId, workflowRunWorkspace]);

  // 切 run / 切会话：先丢掉旧清单再重查。
  useEffect(() => {
    requestVersionRef.current += 1;
    setNodes([]);
    setLoaded(false);
    setTruncated(false);
    setUnavailable(false);
    setError(null);
    if (!enabled) {
      setLoading(false);
      return;
    }
    void fetchNodes();
  }, [enabled, fetchNodes]);

  // 信号抬升：合并后重查。首次挂载那一拍由上面的 effect 负责，这里跳过 undefined。
  const signal = options.refreshSignal;
  const lastSignalRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!enabled || signal === undefined) return;
    if (lastSignalRef.current === undefined) {
      lastSignalRef.current = signal;
      return;
    }
    if (signal <= lastSignalRef.current) return;
    lastSignalRef.current = signal;
    const timer = window.setTimeout(() => {
      void fetchNodes();
    }, REFRESH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, fetchNodes, signal]);

  return useMemo(
    () => ({ nodes, loaded, loading, truncated, unavailable, error }),
    [error, loaded, loading, nodes, truncated, unavailable],
  );
}
