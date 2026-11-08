// GoalStatusBadgeBridge — 主聊天头部的目标浅色标识。
//
// - 数据：共享 SessionDataLayer 的 snapshot.goal（必须复用 V4StreamRowsBridge 的
//   共享层，禁止自建 SessionDataLayer 开第二条 frames SSE）。
// - 渲染：objective 摘要 + 状态 + 累计工时（timeUsedSeconds，对齐 vendored
//   goalStateSchema）；无目标 / 非 v4 会话渲染 null。点击插入 /goal pause。
// - threadId：controller 钉住的 selectedThreadId 同步 hint 优先，异步解析收敛。
import { useEffect, useState, useSyncExternalStore } from "react";
import { getSharedV4SessionDataLayer } from "./V4StreamRowsBridge.js";
import { wsClient } from "../../lib/ws-client.js";

type GoalState = {
  objective: string;
  status: string;
  timeUsedSeconds: number;
  summaryTitle: string | null;
};

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m} 分 ${rest} 秒` : `${m} 分钟`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分钟`;
}

const STATUS_LABELS: Record<string, string> = {
  active: "推进中",
  verifying: "验证中",
  paused: "已暂停",
  verified: "已完成",
  notSatisfied: "待继续",
  failed: "验证失败",
};

const noopSubscribe = () => () => {};

export function GoalStatusBadgeBridge(props: { sessionKey: string }): React.JSX.Element | null {
  const { sessionKey } = props;
  const [threadId, setThreadId] = useState<string>("");
  const [lease, setLease] = useState<ReturnType<
    ReturnType<typeof getSharedV4SessionDataLayer>["acquire"]
  > | null>(null);

  useEffect(() => {
    let alive = true;
    const sk = String(sessionKey || "").trim();
    if (!sk) {
      setThreadId("");
      return;
    }
    // 同步 hint 先上（会话切换不闪旧徽标），异步解析收敛权威值。
    setThreadId(String(wsClient?.getSessionThreadId?.(sk) || "").trim());
    void wsClient
      ?.resolveSessionThreadId?.(sk)
      .then((tid: string | null | undefined) => {
        if (alive) setThreadId(String(tid || "").trim());
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [sessionKey]);

  useEffect(() => {
    if (!threadId) {
      setLease(null);
      return;
    }
    const layer = getSharedV4SessionDataLayer();
    let acquired: ReturnType<typeof layer.acquire> | null = null;
    try {
      acquired = layer.acquire(threadId);
      setLease(acquired);
    } catch {
      acquired = null;
    }
    return () => {
      acquired?.release();
      setLease(null);
    };
  }, [threadId]);

  const goal = useSyncExternalStore(
    lease ? lease.store.subscribe : noopSubscribe,
    () => (lease ? ((lease.store.getState().snapshot?.goal ?? null) as GoalState | null) : null),
  );

  if (!goal || !String(goal.objective || "").trim()) return null;
  const status = String(goal.status || "");
  const statusLabel = STATUS_LABELS[status] || status;
  // 终态后 activeRunStartedAtMs 已清零；显示累计工时而非"距开始"秒数。
  const timeLabel = formatDuration(Number(goal.timeUsedSeconds || 0));
  const summary = String(goal.summaryTitle || goal.objective || "").trim();
  const short = summary.length > 22 ? `${summary.slice(0, 22)}…` : summary;

  return (
    <span
      className="react-chat-header-goal-badge"
      data-goal-status={status}
      title={`目标：${String(goal.objective || "").trim()}\n状态：${statusLabel}\n累计工作：${timeLabel}`}
    >
      <span className="react-chat-header-goal-badge-label">目标 · {short}</span>
      <span className="react-chat-header-goal-badge-meta">
        {statusLabel} · {timeLabel}
      </span>
    </span>
  );
}
