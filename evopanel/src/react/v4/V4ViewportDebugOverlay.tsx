/**
 * V4 视口调试浮层：跟当前可见对话面板同步，展示
 * 0) 当前运行状态：SSE 正在返回 / 运行中 / 停止；运行中且无 SSE 时打印轮询目标/方/间隔
 * 1) 视口内 turn 的画面摘要（DOM 文本）
 * 2) 对应投影原始 row（message 组成）
 * 3) 布局诊断（!EST72 / gap / host）
 *
 * 开启条件：调试模式（运维观测）开着，且 localStorage
 * `EVOFLOW_V4_VIEWPORT_OVERLAY` 不为 `'0'`（默认开）。
 * 顶栏问号菜单可切换；也可 `window.__evoflowViewportOverlay(true/false)`。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { useObsEnabled } from "../hooks/useObsEnabled.js";
import {
  getSessionRuntime,
  isLivePostStreamOpen,
  isTurnBusy,
} from "../lib/session-runtime-store.js";
import { isSessionExecuting } from "../lib/session-execution/queries.js";
import { isSessionHistoryWatchActive } from "../lib/session-reattach.js";
import { getV4TimelineBusy } from "./v4-timeline-busy-store.js";
import { getEvoflowV4Transport } from "./evoflowV4Transport.js";
import { getSharedV4SessionDataLayer } from "./V4StreamRowsBridge.js";
import {
  collectV4ChatLayoutDump,
  type V4ChatLayoutDump,
} from "./v4-chat-layout-dump.js";

/** 与 session-reattach.reattachRunningSessionIfNeeded 默认一致。 */
const HISTORY_WATCH_DEFAULT_POLL_SEC = 1.5;
/** 与 V4StreamRowsBridge CATCHUP_READY_SOFT_MS 一致。 */
const V4_SOFT_CATCHUP_POLL_SEC = 20;

export const V4_VIEWPORT_OVERLAY_LS_KEY = "EVOFLOW_V4_VIEWPORT_OVERLAY";
export const V4_VIEWPORT_OVERLAY_CHANGED = "evoflow-v4-viewport-overlay-changed";

type VisibleTurnProbe = {
  turnId: string;
  dataIndex: string | null;
  top: number;
  height: number;
  displayText: string;
  /** 与下一 turn 的 top 差；末条为 null */
  gapToNext: number | null;
  rawRows: Array<Record<string, unknown>>;
  /** 右栏有 turnHeader(origin=userInput) 却无 userInput → 左栏易被劈成两截 */
  orphanHeaderNoUser: boolean;
  hasUserInput: boolean;
  headerOrigin: string | null;
};

type PollLine = {
  /** (a) 被轮询的目标 */
  target: string;
  /** (b) 谁在轮询 */
  owner: string;
  /** (c) 间隔（秒） */
  intervalSec: number;
  active: boolean;
};

type RunStatusProbe = {
  /** 主状态文案：有 SSE 正在返回 / 运行中 / 停止 */
  label: string;
  mode: "sse" | "running" | "stopped";
  /** AG-UI 本轮 POST /runs/stream */
  aguiSseOpen: boolean;
  /** 页面级 V4 frames SSE（常驻通道，不等于本轮在推字） */
  v4FramesSseOpen: boolean;
  turnPhase: string;
  streamWireSource: string | null;
  historyWatchActive: boolean;
  v4TimelineBusy: boolean;
  executing: boolean;
  polls: PollLine[];
};

type OverlaySnapshot = {
  at: string;
  tid: string;
  title: string | null;
  sessionKey: string | null;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  layout: V4ChatLayoutDump | null;
  runStatus: RunStatusProbe;
  turns: VisibleTurnProbe[];
};

function collectRunStatusProbe(
  sessionKey: string | null,
  tid: string,
): RunStatusProbe {
  const sk = String(sessionKey || "").trim();
  const rt = sk ? getSessionRuntime(sk) : null;
  const aguiSseOpen = isLivePostStreamOpen(rt);
  let v4FramesSseOpen = false;
  try {
    v4FramesSseOpen = getEvoflowV4Transport().isFramesSseConnected();
  } catch {
    v4FramesSseOpen = false;
  }
  const turnBusy = isTurnBusy(rt);
  const historyWatchActive = sk ? isSessionHistoryWatchActive(sk) : false;
  const v4TimelineBusy = sk ? getV4TimelineBusy(sk) : false;
  const executing = sk
    ? isSessionExecuting(sk) || turnBusy || v4TimelineBusy || historyWatchActive
    : false;

  const polls: PollLine[] = [];
  if (!aguiSseOpen && executing) {
    polls.push({
      target:
        "execution/state + 会话历史（V4 时走 refreshEvoflowV4Session / catchup）",
      owner:
        "session-reattach history-watch（旁观续看 / useStreamResume 拉起）",
      intervalSec: HISTORY_WATCH_DEFAULT_POLL_SEC,
      active: historyWatchActive,
    });
    if (tid) {
      let storeLive = false;
      try {
        const st = getSharedV4SessionDataLayer().peekStore(tid)?.getState();
        storeLive = st?.status === "live";
      } catch {
        storeLive = false;
      }
      polls.push({
        target: "POST /api/v4/conversation/catchup（投影 soft reconcile）",
        owner: "V4StreamRowsBridge.refreshEvoflowV4Session",
        intervalSec: V4_SOFT_CATCHUP_POLL_SEC,
        active: storeLive || historyWatchActive || v4TimelineBusy,
      });
    }
  }

  let mode: RunStatusProbe["mode"] = "stopped";
  let label = "停止";
  if (aguiSseOpen) {
    mode = "sse";
    label = "有 SSE 正在返回";
  } else if (executing) {
    mode = "running";
    label = "运行中";
  }

  return {
    label,
    mode,
    aguiSseOpen,
    v4FramesSseOpen,
    turnPhase: rt?.turnPhase ?? "∅",
    streamWireSource: rt?.streamWireSource ?? null,
    historyWatchActive,
    v4TimelineBusy,
    executing,
    polls,
  };
}

function clip(raw: unknown, max = 220): string {
  const s = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function readOverlayPref(): boolean {
  try {
    return localStorage.getItem(V4_VIEWPORT_OVERLAY_LS_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setV4ViewportOverlayEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(V4_VIEWPORT_OVERLAY_LS_KEY, enabled ? "1" : "0");
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(
      new CustomEvent(V4_VIEWPORT_OVERLAY_CHANGED, {
        detail: { enabled },
      }),
    );
  } catch {
    /* ignore */
  }
}

function summarizeRow(row: ConversationRow): Record<string, unknown> {
  const base: Record<string, unknown> = {
    kind: row.kind,
    rowId: row.rowId,
    turnId: row.turnId,
  };
  switch (row.kind) {
    case "userInput":
      return {
        ...base,
        origin: row.origin,
        text: clip(row.text, 280),
      };
    case "assistantText":
      return {
        ...base,
        state: row.state,
        text: clip(row.text, 360),
      };
    case "reasoning":
      return {
        ...base,
        state: row.state,
        text: clip(row.text, 200),
      };
    case "toolCall":
      return {
        ...base,
        toolName: row.toolName,
        status: row.status,
        inputText: clip(row.inputText, 160),
      };
    case "turnHeader":
      return {
        ...base,
        state: row.state,
        origin: row.origin,
        fileChanges: row.fileChanges,
      };
    case "timelineMarker":
      return {
        ...base,
        lane: row.lane,
        marker: row.marker,
      };
    case "artifact":
      return {
        ...base,
        displayName: row.displayName,
        artifactType: row.artifactType,
      };
    case "subagent":
      return {
        ...base,
        subagentType: row.subagentType,
        status: row.status,
        summaryText: clip(row.summaryText, 160),
      };
    default:
      return base;
  }
}

function findConversationScroll(host: Element): HTMLElement | null {
  const turn0 = host.querySelector("[data-v4-turn-unit]");
  let sc: HTMLElement | null = turn0
    ? (turn0.parentElement as HTMLElement | null)
    : null;
  while (sc && sc !== host) {
    const st = window.getComputedStyle(sc);
    if (
      (st.overflowY === "auto" || st.overflowY === "scroll") &&
      sc.scrollHeight > sc.clientHeight + 10
    ) {
      return sc;
    }
    sc = sc.parentElement;
  }
  return host.querySelector(
    "[data-v4-timeline-scroll], [data-conversation-scroll]",
  ) as HTMLElement | null;
}

function collectOverlaySnapshot(): OverlaySnapshot | null {
  if (typeof document === "undefined") return null;
  const host = document.querySelector(
    '[data-v4-chat-host-visible="1"]',
  ) as HTMLElement | null;
  if (!host) return null;
  const tid = String(host.getAttribute("data-v4-chat-host") || "").trim();
  const sessionKey =
    String(host.getAttribute("data-v4-chat-host-session-key") || "").trim() ||
    null;
  const layout = collectV4ChatLayoutDump();
  const title =
    layout?.hosts.find((h) => h.tid === tid)?.title ||
    layout?.activeTitle ||
    null;

  const sc = findConversationScroll(host);
  const scrollTop = sc ? Math.round(sc.scrollTop) : 0;
  const scrollHeight = sc ? Math.round(sc.scrollHeight) : 0;
  const clientHeight = sc ? Math.round(sc.clientHeight) : 0;
  const vpTop = sc ? sc.getBoundingClientRect().top : 0;
  const vpBottom = sc ? sc.getBoundingClientRect().bottom : window.innerHeight;

  const turnEls = Array.from(
    host.querySelectorAll("[data-v4-turn-unit]"),
  ) as HTMLElement[];
  const visibleEls = turnEls
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { el, r };
    })
    .filter(({ r }) => r.bottom > vpTop + 4 && r.top < vpBottom - 4)
    .sort((a, b) => a.r.top - b.r.top);

  let rawByTurn = new Map<string, ConversationRow[]>();
  if (tid) {
    try {
      const snap = getSharedV4SessionDataLayer()
        .peekStore(tid)
        ?.getState()?.snapshot;
      const windowRows = snap?.rows?.window ?? [];
      const map = new Map<string, ConversationRow[]>();
      for (const row of windowRows) {
        const turnId = String(row.turnId || "").trim();
        if (!turnId) continue;
        const list = map.get(turnId) ?? [];
        list.push(row);
        map.set(turnId, list);
      }
      rawByTurn = map;
    } catch {
      rawByTurn = new Map();
    }
  }

  const turns: VisibleTurnProbe[] = visibleEls.map(({ el, r }, i) => {
    const turnId = String(el.getAttribute("data-turn-id") || "").trim();
    const next = visibleEls[i + 1];
    const gapToNext = next ? Math.round(next.r.top - r.top) : null;
    const raw = turnId ? rawByTurn.get(turnId) ?? [] : [];
    const hasUserInput = raw.some((row) => row.kind === "userInput");
    const header = raw.find((row) => row.kind === "turnHeader");
    const headerOrigin =
      header && typeof (header as { origin?: unknown }).origin === "string"
        ? String((header as { origin: string }).origin)
        : null;
    const orphanHeaderNoUser =
      !!header && headerOrigin === "userInput" && !hasUserInput;
    return {
      turnId: turnId || `anon-${i}`,
      dataIndex: el.getAttribute("data-index"),
      top: Math.round(r.top),
      height: Math.round(r.height),
      displayText: clip(el.innerText || "", 320),
      gapToNext,
      rawRows: raw.map(summarizeRow),
      orphanHeaderNoUser,
      hasUserInput,
      headerOrigin,
    };
  });

  return {
    at: new Date().toISOString(),
    tid,
    title,
    sessionKey,
    scrollTop,
    scrollHeight,
    clientHeight,
    layout,
    runStatus: collectRunStatusProbe(sessionKey, tid),
    turns,
  };
}

const OVERLAY_WIDTH_PX = 920;
const OVERLAY_DEFAULT_BOTTOM_GAP = 88;
const OVERLAY_EDGE_PAD = 8;
/** 拖拽后标题条至少留在视口内的高度，避免拖飞后抓不到。 */
const OVERLAY_HEADER_MIN_VISIBLE_PX = 44;

const shellStyle: CSSProperties = {
  position: "fixed",
  width: `min(${OVERLAY_WIDTH_PX}px, calc(100vw - 32px))`,
  maxHeight: "min(72vh, 720px)",
  zIndex: 2147483000,
  display: "flex",
  flexDirection: "column",
  borderRadius: 12,
  border: "1px solid rgba(15, 23, 42, 0.22)",
  background: "rgba(15, 23, 42, 0.96)",
  color: "#e2e8f0",
  boxShadow: "0 16px 48px rgba(0,0,0,0.42)",
  fontFamily:
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  fontSize: 12,
  lineHeight: 1.45,
  overflow: "hidden",
  pointerEvents: "auto",
};

function defaultOverlayPos(): { left: number; top: number } {
  if (typeof window === "undefined") return { left: 16, top: 120 };
  const width = Math.min(OVERLAY_WIDTH_PX, window.innerWidth - 32);
  const height = Math.min(window.innerHeight * 0.72, 720);
  return {
    left: Math.max(OVERLAY_EDGE_PAD, window.innerWidth - width - 16),
    top: Math.max(
      OVERLAY_EDGE_PAD,
      window.innerHeight - height - OVERLAY_DEFAULT_BOTTOM_GAP,
    ),
  };
}

function clampOverlayPos(
  left: number,
  top: number,
  panelWidth: number,
  panelHeight: number,
): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxLeft = Math.max(OVERLAY_EDGE_PAD, vw - panelWidth - OVERLAY_EDGE_PAD);
  const maxTop = Math.max(
    OVERLAY_EDGE_PAD,
    vh - Math.min(panelHeight, OVERLAY_HEADER_MIN_VISIBLE_PX) - OVERLAY_EDGE_PAD,
  );
  return {
    left: Math.min(Math.max(OVERLAY_EDGE_PAD, left), maxLeft),
    top: Math.min(Math.max(OVERLAY_EDGE_PAD, top), maxTop),
  };
}

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 14px",
  borderBottom: "1px solid rgba(148,163,184,0.28)",
  background: "rgba(30, 41, 59, 0.98)",
  cursor: "move",
  userSelect: "none",
  flexShrink: 0,
};

const bodyStyle: CSSProperties = {
  overflow: "auto",
  padding: "10px 12px 14px",
  flex: 1,
  minHeight: 0,
};

const colHeadStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  padding: "4px 0 8px",
};

const paneStyle: CSSProperties = {
  minWidth: 0,
  minHeight: 88,
  maxHeight: 220,
  overflow: "auto",
  padding: 10,
  borderRadius: 8,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  fontSize: 11,
  lineHeight: 1.4,
};

function problemBadge(
  layout: V4ChatLayoutDump | null,
  turns?: VisibleTurnProbe[] | null,
): string {
  const parts: string[] = [];
  if (layout) {
    if (layout.hosts.some((h) => h.visibleAttr === "1" && h.estimateStuck)) {
      parts.push("!EST72");
    }
    if (layout.stackedHostCount > 0) parts.push("!STACK");
    if (layout.composer?.drifted) parts.push("!COMPOSER_DRIFT");
  }
  if (turns?.some((t) => t.orphanHeaderNoUser)) {
    parts.push("!NO_USER");
  }
  return parts.join(" ");
}

export function V4ViewportDebugOverlay() {
  const { enabled: obsEnabled } = useObsEnabled();
  const [prefOn, setPrefOn] = useState(readOverlayPref);
  const [minimized, setMinimized] = useState(false);
  const [snapshot, setSnapshot] = useState<OverlaySnapshot | null>(null);
  const [expandedTurn, setExpandedTurn] = useState<string | null>(null);
  const [pos, setPos] = useState(defaultOverlayPos);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    originLeft: number;
    originTop: number;
  } | null>(null);

  useEffect(() => {
    const onPref = (ev: Event) => {
      const detail = (ev as CustomEvent<{ enabled?: boolean }>).detail;
      if (typeof detail?.enabled === "boolean") {
        setPrefOn(detail.enabled);
      } else {
        setPrefOn(readOverlayPref());
      }
    };
    window.addEventListener(V4_VIEWPORT_OVERLAY_CHANGED, onPref);
    return () => window.removeEventListener(V4_VIEWPORT_OVERLAY_CHANGED, onPref);
  }, []);

  // 退役「本机运行监控」：浮层在时清掉旧 HUD，避免调试模式叠两块。
  useEffect(() => {
    void import("../../lib/perf-hud-overlay.js")
      .then((m) => {
        m.hidePerfHud?.({ userDismissed: true });
        m.syncPerfHudWithObsEnabled?.(false);
      })
      .catch(() => {
        /* optional */
      });
  }, []);

  useEffect(() => {
    const w = window as Window & {
      __evoflowViewportOverlay?: (enabled?: boolean) => boolean;
      __evoflowViewportDebugSnapshot?: () => OverlaySnapshot | null;
    };
    w.__evoflowViewportOverlay = (enabled?: boolean) => {
      if (typeof enabled === "boolean") {
        setV4ViewportOverlayEnabled(enabled);
        return enabled;
      }
      return readOverlayPref();
    };
    w.__evoflowViewportDebugSnapshot = () => collectOverlaySnapshot();
    return () => {
      delete w.__evoflowViewportOverlay;
      delete w.__evoflowViewportDebugSnapshot;
    };
  }, []);

  const refresh = useCallback(() => {
    setSnapshot(collectOverlaySnapshot());
  }, []);

  const active = obsEnabled && prefOn;

  useEffect(() => {
    if (!active) {
      setSnapshot(null);
      return;
    }
    refresh();
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        refresh();
      });
    };
    const host = document.querySelector('[data-v4-chat-host-visible="1"]');
    const sc = host ? findConversationScroll(host) : null;
    sc?.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const timer = window.setInterval(schedule, 700);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      sc?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.clearInterval(timer);
    };
  }, [active, refresh, snapshot?.tid]);

  const clampToViewport = useCallback((left: number, top: number) => {
    const el = panelRef.current;
    const width = el?.offsetWidth || Math.min(OVERLAY_WIDTH_PX, window.innerWidth - 32);
    const height = el?.offsetHeight || Math.min(window.innerHeight * 0.72, 720);
    return clampOverlayPos(left, top, width, height);
  }, []);

  useEffect(() => {
    if (!active) return;
    const onResize = () => {
      setPos((prev) => clampToViewport(prev.left, prev.top));
    };
    window.addEventListener("resize", onResize);
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, [active, clampToViewport]);

  const onPointerDownHeader = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button")) return;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originLeft: pos.left,
      originTop: pos.top,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMoveHeader = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setPos(
      clampToViewport(
        d.originLeft + (e.clientX - d.startX),
        d.originTop + (e.clientY - d.startY),
      ),
    );
  };
  const onPointerUpHeader = () => {
    dragRef.current = null;
  };
  const resetPos = () => setPos(defaultOverlayPos());

  const problems = useMemo(
    () => problemBadge(snapshot?.layout ?? null, snapshot?.turns ?? null),
    [snapshot],
  );
  const visibleHost = snapshot?.layout?.hosts.find((h) => h.visibleAttr === "1");

  if (!active || typeof document === "undefined") return null;

  const panel = (
    <div
      ref={panelRef}
      data-v4-viewport-debug-overlay="true"
      style={{
        ...shellStyle,
        left: pos.left,
        top: pos.top,
        right: "auto",
        bottom: "auto",
        maxHeight: minimized ? undefined : shellStyle.maxHeight,
        height: minimized ? "auto" : undefined,
      }}
    >
      <div
        style={headerStyle}
        onPointerDown={onPointerDownHeader}
        onPointerMove={onPointerMoveHeader}
        onPointerUp={onPointerUpHeader}
        onPointerCancel={onPointerUpHeader}
      >
        <strong style={{ fontSize: 12, color: "#f8fafc" }}>视口调试</strong>
        {problems ? (
          <span style={{ color: "#fbbf24", fontWeight: 700 }}>{problems}</span>
        ) : (
          <span style={{ color: "#86efac" }}>OK</span>
        )}
        <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          <button
            type="button"
            style={btnStyle}
            onClick={() => refresh()}
            title="立即刷新"
          >
            刷新
          </button>
          <button
            type="button"
            style={btnStyle}
            onClick={resetPos}
            title="拖飞了点这个：回到右下角"
          >
            复位
          </button>
          <button
            type="button"
            style={btnStyle}
            onClick={() => setMinimized((v) => !v)}
          >
            {minimized ? "展开" : "收起"}
          </button>
          <button
            type="button"
            style={btnStyle}
            onClick={() => setV4ViewportOverlayEnabled(false)}
            title="关闭浮层（调试模式仍开着；问号菜单可再开）"
          >
            ×
          </button>
        </span>
      </div>
      {!minimized ? (
        <div style={bodyStyle}>
          {!snapshot ? (
            <div style={{ color: "#94a3b8" }}>等待可见对话…</div>
          ) : (
            <>
              <div
                style={{
                  marginBottom: 10,
                  padding: "8px 10px",
                  borderRadius: 8,
                  background: "rgba(51,65,85,0.45)",
                  color: "#cbd5e1",
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                  fontSize: 11,
                }}
              >
                <div>
                  当前对话{" "}
                  <b style={{ color: "#f8fafc" }}>
                    「{snapshot.title || snapshot.tid.slice(0, 8)}」
                  </b>
                  <span style={{ color: "#94a3b8" }}>
                    {" "}
                    · tid={snapshot.tid.slice(0, 8)}
                    {snapshot.sessionKey
                      ? ` · sk=${snapshot.sessionKey.slice(0, 12)}`
                      : ""}
                  </span>
                </div>
                <div style={{ marginTop: 6 }}>
                  运行状态{" "}
                  <b
                    style={{
                      color:
                        snapshot.runStatus.mode === "sse"
                          ? "#67e8f9"
                          : snapshot.runStatus.mode === "running"
                            ? "#fbbf24"
                            : "#86efac",
                    }}
                  >
                    {snapshot.runStatus.label}
                  </b>
                  <span style={{ color: "#94a3b8" }}>
                    {" "}
                    · phase={snapshot.runStatus.turnPhase}
                    {snapshot.runStatus.streamWireSource
                      ? ` · wire=${snapshot.runStatus.streamWireSource}`
                      : " · wire=∅"}
                    {snapshot.runStatus.v4FramesSseOpen
                      ? " · V4 frames SSE 已连接"
                      : " · V4 frames SSE 未连"}
                  </span>
                </div>
                {snapshot.runStatus.mode === "sse" ? (
                  <div style={{ marginTop: 4, color: "#a5f3fc" }}>
                    本轮 AG-UI POST /runs/stream 仍开着（浏览器持有 live SSE）
                  </div>
                ) : null}
                {snapshot.runStatus.mode === "running" ? (
                  <div style={{ marginTop: 4 }}>
                    {snapshot.runStatus.polls.length === 0 ? (
                      <div style={{ color: "#fde68a" }}>
                        运行中、无本机 SSE；当前未检测到 history-watch / catchup
                        轮询（可能刚启动或只靠 V4 推送残留 busy）
                      </div>
                    ) : (
                      snapshot.runStatus.polls.map((p, i) => (
                        <div
                          key={`${p.owner}:${i}`}
                          style={{
                            marginTop: i === 0 ? 2 : 6,
                            padding: "6px 8px",
                            borderRadius: 6,
                            background: p.active
                              ? "rgba(180, 83, 9, 0.28)"
                              : "rgba(30, 41, 59, 0.65)",
                            color: p.active ? "#fde68a" : "#94a3b8",
                          }}
                        >
                          <div>
                            轮询 {p.active ? "● 进行中" : "○ 未启动"} · 每{" "}
                            <b style={{ color: "#fff" }}>{p.intervalSec}s</b>
                          </div>
                          <div style={{ marginTop: 2 }}>
                            (a) 被轮询：{p.target}
                          </div>
                          <div>(b) 轮询方：{p.owner}</div>
                          <div>(c) 间隔：{p.intervalSec} 秒</div>
                        </div>
                      ))
                    )}
                    <div style={{ marginTop: 4, color: "#64748b" }}>
                      historyWatch=
                      {snapshot.runStatus.historyWatchActive ? "1" : "0"} ·
                      v4Busy=
                      {snapshot.runStatus.v4TimelineBusy ? "1" : "0"} ·
                      executing=
                      {snapshot.runStatus.executing ? "1" : "0"}
                    </div>
                  </div>
                ) : null}
                <div style={{ marginTop: 4 }}>
                  scroll={snapshot.scrollTop}/{snapshot.scrollHeight} · gap=
                  {visibleHost?.medianGap ?? "∅"}
                  {visibleHost?.estimateStuck ? " !EST72" : ""} · 视口内 turn=
                  {snapshot.turns.length}
                  <span style={{ color: "#94a3b8" }}>
                    {" "}
                    · 左=界面看到的字 · 右=投影原始 row
                  </span>
                </div>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 10,
                  marginBottom: 8,
                  position: "sticky",
                  top: 0,
                  zIndex: 1,
                  background: "rgba(15,23,42,0.96)",
                  paddingBottom: 4,
                }}
              >
                <div style={{ ...colHeadStyle, color: "#86efac" }}>
                  左侧 · 界面内容（DOM 画面）
                </div>
                <div style={{ ...colHeadStyle, color: "#c4b5fd" }}>
                  右侧 · 原始数据（message / row）
                </div>
              </div>

              {snapshot.turns.length === 0 ? (
                <div style={{ color: "#fbbf24" }}>
                  视口内没有 turn（大片空白时常见：滚动位置与虚拟窗口对不上）
                </div>
              ) : null}

              {snapshot.turns.map((t) => {
                const open = expandedTurn === t.turnId;
                const gapWarn =
                  t.gapToNext != null &&
                  t.gapToNext <= 80 &&
                  t.height > 120;
                const rawSummary =
                  t.rawRows.length === 0
                    ? "（投影窗口无此 turn）"
                    : t.rawRows
                        .map((r) => {
                          const kind = String(r.kind || "?");
                          if (typeof r.toolName === "string") {
                            return `${kind}  ${r.toolName}${
                              r.status ? ` [${r.status}]` : ""
                            }`;
                          }
                          if (typeof r.text === "string" && r.text) {
                            return `${kind}  ${clip(r.text, 100)}`;
                          }
                          if (typeof r.origin === "string") {
                            return `${kind}  origin=${r.origin}`;
                          }
                          if (typeof r.state === "string") {
                            return `${kind}  state=${r.state}`;
                          }
                          return kind;
                        })
                        .join("\n");
                return (
                  <div
                    key={`${t.turnId}:${t.dataIndex}`}
                    style={{
                      border: gapWarn
                        ? "1px solid rgba(251,191,36,0.55)"
                        : "1px solid rgba(148,163,184,0.22)",
                      borderRadius: 10,
                      marginBottom: 10,
                      overflow: "hidden",
                      background: gapWarn
                        ? "rgba(180, 83, 9, 0.18)"
                        : "rgba(15,23,42,0.35)",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedTurn((cur) =>
                          cur === t.turnId ? null : t.turnId,
                        )
                      }
                      style={{
                        all: "unset",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        width: "100%",
                        boxSizing: "border-box",
                        padding: "8px 12px",
                        background: "rgba(30,41,59,0.85)",
                        color: "#93c5fd",
                        fontFamily:
                          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                        fontSize: 11,
                      }}
                    >
                      <span>
                        #{t.dataIndex ?? "∅"} · turn={t.turnId.slice(0, 8)} · h=
                        {t.height}
                        {t.gapToNext != null
                          ? ` · gap→${t.gapToNext}${gapWarn ? " ⚠叠" : ""}`
                          : ""}
                      </span>
                      <span style={{ marginLeft: "auto", color: "#94a3b8" }}>
                        {open ? "收起 JSON ▲" : "展开 JSON ▼"}
                      </span>
                    </button>

                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: 0,
                        borderTop: "1px solid rgba(148,163,184,0.18)",
                      }}
                    >
                      <div
                        style={{
                          ...paneStyle,
                          borderRight: "1px solid rgba(148,163,184,0.22)",
                          background: "rgba(6, 78, 59, 0.22)",
                          color: "#d1fae5",
                        }}
                      >
                        {t.displayText || "（界面无文字）"}
                      </div>
                      <div
                        style={{
                          ...paneStyle,
                          background: "rgba(76, 29, 149, 0.22)",
                          color: "#ede9fe",
                        }}
                      >
                        {rawSummary}
                      </div>
                    </div>

                    {open ? (
                      <pre
                        style={{
                          margin: 0,
                          padding: 12,
                          borderTop: "1px solid rgba(148,163,184,0.18)",
                          background: "rgba(2,6,23,0.88)",
                          color: "#f1f5f9",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          maxHeight: 280,
                          overflow: "auto",
                          fontFamily:
                            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                          fontSize: 11,
                        }}
                      >
                        {JSON.stringify(
                          {
                            turnId: t.turnId,
                            layout: {
                              top: t.top,
                              height: t.height,
                              gapToNext: t.gapToNext,
                            },
                            displayText: t.displayText,
                            rows: t.rawRows,
                          },
                          null,
                          2,
                        )}
                      </pre>
                    ) : null}
                  </div>
                );
              })}
            </>
          )}
        </div>
      ) : null}
    </div>
  );

  return createPortal(panel, document.body);
}

const btnStyle: CSSProperties = {
  appearance: "none",
  border: "1px solid rgba(148,163,184,0.35)",
  background: "rgba(51,65,85,0.9)",
  color: "#f8fafc",
  borderRadius: 6,
  padding: "2px 8px",
  fontSize: 11,
  cursor: "pointer",
};

export default V4ViewportDebugOverlay;
