import { useCallback, useEffect, useReducer, useRef } from "react";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

/**
 * 重建窗口上限。实测 agent start→ready 约 550-650ms，createSession 再数百 ms，5s 有充分余量。
 * 超时只解除门禁，不取消重建——迟到的 binding 仍会正常更新 effectiveSessionId 并唤醒附件重传。
 */
const DRAFT_RUNTIME_REBUILD_TIMEOUT_MS = 5000;

interface DraftRuntimeRebuildGateState {
  rebuilding: boolean;
  /** 换代发生时的预热会话 id；出现与之不同的非空 id 即视为重建完成。 */
  pendingFrom: string | null;
  /** 单调递增，仅用于让计时器 effect 在「重建中再次换代」时重新起算。 */
  epoch: number;
}

type DraftRuntimeRebuildGateEvent =
  | { type: "runtimeRestart"; prewarmSessionId: string | null }
  | { type: "prewarmSessionChanged"; prewarmSessionId: string | null }
  | { type: "rebuildTimeout" };

const DRAFT_RUNTIME_REBUILD_GATE_IDLE: DraftRuntimeRebuildGateState = {
  epoch: 0,
  pendingFrom: null,
  rebuilding: false,
};

function reduceDraftRuntimeRebuildGate(
  state: DraftRuntimeRebuildGateState,
  event: DraftRuntimeRebuildGateEvent,
): DraftRuntimeRebuildGateState {
  switch (event.type) {
    case "runtimeRestart":
      return {
        epoch: state.epoch + 1,
        pendingFrom: event.prewarmSessionId,
        rebuilding: true,
      };
    case "prewarmSessionChanged":
      if (!state.rebuilding) return state;
      // retire 到重建完成之间 binding 为 null，不能据此解除门禁。
      if (event.prewarmSessionId === null) return state;
      if (event.prewarmSessionId === state.pendingFrom) return state;
      return { epoch: state.epoch, pendingFrom: null, rebuilding: false };
    case "rebuildTimeout":
      if (!state.rebuilding) return state;
      return { ...state, rebuilding: false };
  }
}

interface DraftRuntimeRebuildGate {
  /** 预热会话正在重建；true 时必须禁止发送，否则附件会挂在已消失的会话上。 */
  rebuilding: boolean;
}

/**
 * CUA Helper 就绪、liveness 恢复等原因会回收 agent runtime（workspace-dispose），把草稿态
 * 尚未持久化的预热会话一并冲掉。此 hook 在 runtime 换代时递增 draftRuntimeInvalidationVersion
 * 触发重建，并在重建窗口内给出 rebuilding=true 供发送门禁使用。
 *
 * 换代信号优先取 onRuntimeLifecycle 的 unavailable：它在 dispose 当场到达。onRuntimeRestart
 * 只在新 agent 进程 spawn 时才发，而 agent 是懒启动——没人发请求就不 spawn，于是换代通知
 * 永不到达、预热会话永不重建，附件一直卡在 waitingSession，直到用户手动点一次发送才被踹活
 * （生产实测 helper ready 到重建间隔 2.3s/6.0s/26.3s，全等于用户点击时刻）。
 *
 * 正式会话态（sessionId !== null）不启用：那条路径由 CLI 的 cold-session-resume 负责。
 */
export function useDraftRuntimeRebuildGate(params: {
  /** 仅草稿态（sessionId === null）启用。 */
  enabled: boolean;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 当前预热会话 id；出现新的非空值即视为重建完成。 */
  prewarmSessionId: string | null;
  onRuntimeRestart?: (listener: () => void) => () => void;
  /** 承载 transport 暴露 runtime 存活态时优先用它，替代 onRuntimeRestart。 */
  onRuntimeLifecycle?: (listener: (state: "available" | "unavailable") => void) => () => void;
  timeoutMs?: number;
}): DraftRuntimeRebuildGate {
  const {
    enabled,
    onRuntimeLifecycle,
    onRuntimeRestart,
    prewarmSessionId,
    timeoutMs = DRAFT_RUNTIME_REBUILD_TIMEOUT_MS,
    workspaceIdentity,
    workspacePath,
  } = params;
  const [state, dispatch] = useReducer(
    reduceDraftRuntimeRebuildGate,
    DRAFT_RUNTIME_REBUILD_GATE_IDLE,
  );

  // enabled / prewarmSessionId 走 ref：若让 handleRuntimeRestart 依赖它们，每次会话 id 变化
  // 都会取消订阅再重订阅，而 transport 在 listeners 清空时会 dispose upstream——那个窗口里
  // 到达的换代事件会被丢掉。
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const prewarmSessionIdRef = useRef(prewarmSessionId);
  prewarmSessionIdRef.current = prewarmSessionId;

  const handleRuntimeRestart = useCallback(() => {
    if (!enabledRef.current) return;
    dispatch({ prewarmSessionId: prewarmSessionIdRef.current, type: "runtimeRestart" });
    useZCodeSessionStore.getState().invalidateDraftRuntime(workspacePath, workspaceIdentity);
  }, [workspaceIdentity, workspacePath]);

  useEffect(() => {
    // 二选一订阅：两条通道都订会让同一次换代被处理两次，白建一个预热会话、附件多传一遍。
    if (onRuntimeLifecycle) {
      return onRuntimeLifecycle((state) => {
        // available 不必处理：重建已由 unavailable 发起，门禁解除交给 prewarmSessionChanged。
        if (state === "unavailable") handleRuntimeRestart();
      });
    }
    if (!onRuntimeRestart) return;
    return onRuntimeRestart(handleRuntimeRestart);
  }, [handleRuntimeRestart, onRuntimeLifecycle, onRuntimeRestart]);

  useEffect(() => {
    dispatch({ prewarmSessionId, type: "prewarmSessionChanged" });
  }, [prewarmSessionId]);

  // 依赖 epoch 而非 rebuilding：重建中再次换代时 rebuilding 保持 true，
  // 只有 epoch 变化才能让计时器重新起算。
  useEffect(() => {
    if (!state.rebuilding) return;
    const timer = setTimeout(() => dispatch({ type: "rebuildTimeout" }), timeoutMs);
    return () => clearTimeout(timer);
  }, [state.epoch, state.rebuilding, timeoutMs]);

  return { rebuilding: state.rebuilding };
}
