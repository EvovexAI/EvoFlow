/**
 * V4 视口调试浮层：紧凑状态条 + 分页
 * - 运行：SSE / 轮询 / settled
 * - 消息：投影窗已显示/全序行数、用户气泡、loadOlder 预取带（≤2×视口）
 * - 流式：AG-UI / V4 原始 JSON（一行一条，贴底跟最新）
 * - 接口：页面相关 HTTP（subscribe / messages / catchup…）入参出参表
 * - 视口：DOM ↔ 投影 row
 * 布局诊断（!EST72 / gap / !HISTORY_TOP）仍在状态条。
 *
 * 开启条件：调试模式（运维观测）开着，且 localStorage
 * `EVOFLOW_V4_VIEWPORT_OVERLAY` 不为 `'0'`（默认开）。
 * 顶栏问号菜单可切换；也可 `window.__evoflowViewportOverlay(true/false)`。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
import {
  clearViewportStreamTap,
  listViewportStreamTapEntries,
  subscribeViewportStreamTap,
  type ViewportStreamTapEntry,
} from "./v4-viewport-stream-tap.js";
import {
  clearViewportApiTap,
  listViewportApiTapEntries,
  subscribeViewportApiTap,
  type ViewportApiTapEntry,
  type ViewportApiTapFamily,
} from "./v4-viewport-api-tap.js";
import {
  hasOlderRows,
} from "@zcode/ui/v4/conversationProjectionStore.js";
import {
  historyPrefetchTriggerPx,
  shouldTriggerLoadOlder,
} from "@zcode/ui/v4/timelineScrollAnchor.js";

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
  /**
   * 有用户气泡 + 轮已完成，却无 assistantText/reasoning/toolCall。
   * 常见于中途 RUN_FINISHED 后迟到 TEXT 写成空 turnId 孤儿（或空流收尾）。
   */
  emptyAssistantCompleted: boolean;
  headerState: string | null;
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
  /** 钉住「运行中」的原因，便于对照 phase=idle 仍 executing=1 */
  execWhy: string;
  uiTurnSettled: boolean;
  polls: PollLine[];
};

/** 投影窗口 / 上拉 loadOlder 诊断（对应「总数 vs 已显示」与预取触发带）。 */
type HistoryLoadProbe = {
  /** 服务端全序行数（snapshot.rows.totalCount） */
  totalCount: number | null;
  /** 客户端当前窗口行数 */
  windowCount: number;
  /** 窗口内 realUser 气泡数 */
  windowUserCount: number;
  /** 窗口内 turnHeader 数（约等于轮次数） */
  windowTurnCount: number;
  firstRowId: number | null;
  windowFirstRowId: number | null;
  windowLastRowId: number | null;
  hasOlder: boolean;
  loadingOlder: boolean;
  /** 进入预取带的 scrollTop 上限（约 2×视口，且 ≥64） */
  triggerPx: number;
  /** 是否已滚进预取带 */
  inPrefetchZone: boolean;
  /** 此刻是否应触发 loadOlder */
  wouldTrigger: boolean;
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
  history: HistoryLoadProbe;
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
  const listExecuting = sk ? isSessionExecuting(sk) : false;
  const executing =
    listExecuting || turnBusy || v4TimelineBusy || historyWatchActive;

  const why: string[] = [];
  if (aguiSseOpen) why.push("aguiWire");
  if (turnBusy) why.push(`turnPhase=${rt?.turnPhase || "?"}`);
  if (v4TimelineBusy) why.push("v4TimelineBusy");
  if (historyWatchActive) why.push("historyWatch");
  if (listExecuting && !turnBusy && !v4TimelineBusy && !historyWatchActive) {
    why.push("isSessionExecuting");
  }
  if (rt?.uiTurnSettled) why.push("settled");

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
      // store status=live 只表示 frames 已订阅，不等于「正在为运行态 soft catchup」
      polls.push({
        target: "POST /api/v4/conversation/catchup（投影 soft reconcile）",
        owner: "V4StreamRowsBridge.refreshEvoflowV4Session",
        intervalSec: V4_SOFT_CATCHUP_POLL_SEC,
        active: historyWatchActive || v4TimelineBusy,
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
    execWhy: why.join(",") || "∅",
    uiTurnSettled: !!rt?.uiTurnSettled,
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

function emptyHistoryProbe(clientHeight: number): HistoryLoadProbe {
  const triggerPx = historyPrefetchTriggerPx(clientHeight);
  return {
    totalCount: null,
    windowCount: 0,
    windowUserCount: 0,
    windowTurnCount: 0,
    firstRowId: null,
    windowFirstRowId: null,
    windowLastRowId: null,
    hasOlder: false,
    loadingOlder: false,
    triggerPx,
    inPrefetchZone: false,
    wouldTrigger: false,
  };
}

function collectHistoryLoadProbe(
  tid: string,
  scrollTop: number,
  clientHeight: number,
): HistoryLoadProbe {
  const triggerPx = historyPrefetchTriggerPx(clientHeight);
  const inPrefetchZone = scrollTop <= triggerPx;
  const base = emptyHistoryProbe(clientHeight);
  if (!tid) {
    return { ...base, inPrefetchZone, wouldTrigger: false };
  }
  try {
    const store = getSharedV4SessionDataLayer().peekStore(tid);
    const state = store?.getState();
    const snap = state?.snapshot ?? null;
    const windowRows = snap?.rows?.window ?? [];
    const loadingOlder = !!state?.loadingOlder;
    const hasOlder = hasOlderRows(snap);
    const wouldTrigger = shouldTriggerLoadOlder({
      scrollTop,
      canLoadOlder: hasOlder,
      loadingOlder,
      triggerPx,
    });
    let windowUserCount = 0;
    let windowTurnCount = 0;
    for (const row of windowRows) {
      if (row.kind === "turnHeader") windowTurnCount += 1;
      if (
        row.kind === "userInput" &&
        (row as { origin?: string }).origin === "realUser"
      ) {
        windowUserCount += 1;
      }
    }
    const total =
      typeof snap?.rows?.totalCount === "number" ? snap.rows.totalCount : null;
    const firstRowId =
      typeof snap?.rows?.firstRowId === "number" ? snap.rows.firstRowId : null;
    return {
      totalCount: total,
      windowCount: windowRows.length,
      windowUserCount,
      windowTurnCount,
      firstRowId,
      windowFirstRowId: windowRows[0]?.rowId ?? null,
      windowLastRowId: windowRows.at(-1)?.rowId ?? null,
      hasOlder,
      loadingOlder,
      triggerPx,
      inPrefetchZone,
      wouldTrigger,
    };
  } catch {
    return { ...base, inPrefetchZone, wouldTrigger: false };
  }
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
    const headerState =
      header && typeof (header as { state?: unknown }).state === "string"
        ? String((header as { state: string }).state)
        : null;
    const orphanHeaderNoUser =
      !!header && headerOrigin === "userInput" && !hasUserInput;
    const hasAssistantLike = raw.some((row) => {
      const k = String(row.kind || "");
      return (
        k === "assistantText" ||
        k === "reasoning" ||
        k === "toolCall" ||
        k === "subagent"
      );
    });
    const emptyAssistantCompleted =
      hasUserInput &&
      !hasAssistantLike &&
      !!headerState &&
      (headerState.startsWith("completed") || headerState === "failed");
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
      emptyAssistantCompleted,
      headerState,
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
    history: collectHistoryLoadProbe(tid, scrollTop, clientHeight),
    turns,
  };
}

const OVERLAY_WIDTH_PX = 920;
const OVERLAY_DEFAULT_BOTTOM_GAP = 88;
const OVERLAY_EDGE_PAD = 8;
/** 拖拽后标题条至少留在视口内的高度，避免拖飞后抓不到。 */
const OVERLAY_HEADER_MIN_VISIBLE_PX = 44;
const OVERLAY_TAB_LS_KEY = "EVOFLOW_V4_VIEWPORT_OVERLAY_TAB";

type OverlayTab = "status" | "stream" | "api" | "viewport";
type ApiFamilyFilter = "all" | ViewportApiTapFamily;

function readOverlayTab(): OverlayTab {
  try {
    const v = localStorage.getItem(OVERLAY_TAB_LS_KEY);
    if (v === "status" || v === "stream" || v === "api" || v === "viewport") {
      return v;
    }
  } catch {
    /* ignore */
  }
  return "stream";
}

function writeOverlayTab(tab: OverlayTab): void {
  try {
    localStorage.setItem(OVERLAY_TAB_LS_KEY, tab);
  } catch {
    /* ignore */
  }
}

const shellStyle: CSSProperties = {
  position: "fixed",
  width: `min(${OVERLAY_WIDTH_PX}px, calc(100vw - 32px))`,
  maxHeight: "min(78vh, 780px)",
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
  lineHeight: 1.35,
  overflow: "hidden",
  pointerEvents: "auto",
};

function defaultOverlayPos(): { left: number; top: number } {
  if (typeof window === "undefined") return { left: 16, top: 120 };
  const width = Math.min(OVERLAY_WIDTH_PX, window.innerWidth - 32);
  const height = Math.min(window.innerHeight * 0.78, 780);
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
  overflow: "hidden",
  padding: "6px 10px 10px",
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const mono: CSSProperties = {
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
};

const tabBtnBase: CSSProperties = {
  appearance: "none",
  border: "1px solid transparent",
  background: "transparent",
  color: "#94a3b8",
  borderRadius: 6,
  padding: "3px 10px",
  fontSize: 11,
  cursor: "pointer",
  fontWeight: 600,
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

/** 复制给 Agent 排查用的诊断包：布局 + 运行态 + 视口 turn + 最近流式帧 + 接口。 */
function buildOverlayDiagnosticText(opts: {
  tab: OverlayTab;
  snapshot: OverlaySnapshot | null;
  streamEntries: ViewportStreamTapEntry[];
  apiEntries: ViewportApiTapEntry[];
  problems: string;
}): string {
  const { tab, snapshot, streamEntries, apiEntries, problems } = opts;
  const lines: string[] = [];
  lines.push("## EvoFlow V4 视口调试诊断");
  lines.push(`- 复制时间: ${new Date().toISOString()}`);
  lines.push(`- 当前页签: ${tab}`);
  lines.push(`- 问题标记: ${problems || "OK"}`);
  if (!snapshot) {
    lines.push("- 快照: （无可见对话）");
    return lines.join("\n");
  }

  lines.push("");
  lines.push("### 会话");
  lines.push(`- title: ${snapshot.title || "∅"}`);
  lines.push(`- tid: ${snapshot.tid}`);
  lines.push(`- sessionKey: ${snapshot.sessionKey || "∅"}`);
  lines.push(
    `- scroll: top=${snapshot.scrollTop} height=${snapshot.scrollHeight} client=${snapshot.clientHeight}`,
  );

  const h = snapshot.history;
  lines.push("");
  lines.push("### 消息 / 投影窗口");
  lines.push(
    `- rows: 已显示 ${h.windowCount} / 全序 ${h.totalCount ?? "∅"}（user气泡=${h.windowUserCount} turns=${h.windowTurnCount}）`,
  );
  lines.push(
    `- rowId: first=${h.firstRowId ?? "∅"} window=${h.windowFirstRowId ?? "∅"}…${h.windowLastRowId ?? "∅"}`,
  );
  lines.push(
    `- loadOlder: hasOlder=${h.hasOlder ? 1 : 0} loading=${h.loadingOlder ? 1 : 0} triggerPx=${h.triggerPx} inZone=${h.inPrefetchZone ? 1 : 0} wouldTrigger=${h.wouldTrigger ? 1 : 0}`,
  );
  lines.push(
    `- 预取规则: scrollTop ≤ max(64, 2×clientHeight) 才自动 loadOlder；不是一上滚就拉`,
  );

  const rs = snapshot.runStatus;
  lines.push("");
  lines.push("### 运行状态");
  lines.push(`- label: ${rs.label} (mode=${rs.mode})`);
  lines.push(
    `- phase=${rs.turnPhase} wire=${rs.streamWireSource || "∅"} frames=${rs.v4FramesSseOpen ? "connected" : "down"} settled=${rs.uiTurnSettled ? 1 : 0} executing=${rs.executing ? 1 : 0}`,
  );
  lines.push(`- why: ${rs.execWhy || "∅"}`);
  lines.push(
    `- historyWatch=${rs.historyWatchActive ? 1 : 0} v4Busy=${rs.v4TimelineBusy ? 1 : 0}`,
  );
  for (const p of rs.polls) {
    lines.push(
      `- poll ${p.active ? "ACTIVE" : "idle"} every ${p.intervalSec}s | ${p.owner} | ${p.target}`,
    );
  }

  const host = snapshot.layout?.hosts.find((h) => h.visibleAttr === "1");
  lines.push("");
  lines.push("### 布局（左栏 DOM / virtualizer）");
  if (host) {
    lines.push(
      `- host visible v=${host.visibleAttr} focused=${host.focusedAttr} display=${host.display} vis=${host.visibility}`,
    );
    lines.push(
      `- turns=${host.turnCount} uniqueTops=${host.uniqueTops} medianGap=${host.medianGap ?? "∅"} stacked=${host.stacked ? 1 : 0} estimateStuck=${host.estimateStuck ? 1 : 0}`,
    );
  } else {
    lines.push("- （无 visible host）");
  }
  if (snapshot.layout) {
    lines.push(
      `- stackedHostCount=${snapshot.layout.stackedHostCount} composerDrift=${snapshot.layout.composer?.drifted ? 1 : 0}`,
    );
  }

  lines.push("");
  lines.push("### 视口内 turn（左=DOM 字 / 右=投影 row）");
  if (snapshot.turns.length === 0) {
    lines.push("- （视口无 turn）");
  } else {
    for (const t of snapshot.turns) {
      lines.push(
        `- #${t.dataIndex ?? "∅"} turn=${t.turnId.slice(0, 12)} h=${t.height} gap→${t.gapToNext ?? "∅"}${t.orphanHeaderNoUser ? " !NO_USER" : ""}${t.emptyAssistantCompleted ? " !EMPTY_ASSISTANT" : ""}${t.headerState ? ` state=${t.headerState}` : ""}`,
      );
      lines.push(`  DOM: ${clip(t.displayText, 280) || "（空）"}`);
      const rowBrief =
        t.rawRows.length === 0
          ? "（投影无此 turn）"
          : t.rawRows
              .map((r) => {
                const kind = String(r.kind || "?");
                if (typeof r.toolName === "string") {
                  return `${kind}:${r.toolName}${r.status ? `[${r.status}]` : ""}`;
                }
                if (typeof r.text === "string" && r.text) {
                  return `${kind}:${clip(r.text, 100)}`;
                }
                if (typeof r.origin === "string") {
                  return `${kind}:origin=${r.origin}`;
                }
                if (typeof r.state === "string") {
                  return `${kind}:state=${r.state}`;
                }
                return kind;
              })
              .join(" | ");
      lines.push(`  ROW: ${rowBrief}`);
    }
  }

  const recent = streamEntries.slice(-12);
  lines.push("");
  lines.push(
    `### 最近流式帧（${recent.length}/${streamEntries.length}，含裁剪后 JSON）`,
  );
  if (recent.length === 0) {
    lines.push("- （无）");
  } else {
    for (const e of recent) {
      lines.push(`- #${e.id} ${new Date(e.atMs).toISOString()} ${e.headline}`);
      lines.push("```json");
      lines.push(e.jsonText);
      lines.push("```");
    }
  }

  const recentApi = apiEntries.slice(-10);
  lines.push("");
  lines.push(
    `### 最近页面接口（${recentApi.length}/${apiEntries.length}，入参/出参已裁剪）`,
  );
  if (recentApi.length === 0) {
    lines.push("- （无）");
  } else {
    for (const e of recentApi) {
      lines.push(
        `- #${e.id} ${new Date(e.atMs).toISOString()} ${e.method} ${e.label} ${e.status} ${e.durationMs}ms ${e.ok ? "ok" : "FAIL"}`,
      );
      lines.push(`  path: ${e.path}${e.query ? `?${e.query}` : ""}`);
      lines.push("  --- request ---");
      lines.push(e.requestText || "（空）");
      lines.push("  --- response ---");
      lines.push(e.responseText || "（空）");
    }
  }

  lines.push("");
  lines.push("### 给 Agent 的提示");
  lines.push(
    "- 叠字/空白/滚不到历史 → 看布局 estimateStuck、medianGap、视口 turn DOM↔ROW。",
  );
  lines.push("- 粘运行中/停不掉 → 看 phase/wire/settled/why 与 polls。");
  lines.push("- 投影落后或劈 turn → 对流式 deltas/snapshot 与 ROW 摘要。");
  lines.push(
    "- 接口有正文、页面空 → 对「接口」页签 response 与视口 ROW；差在 hydrate/mirror/前端过滤。",
  );
  lines.push(
    "- !EMPTY_ASSISTANT → 用户轮已 completed 却无助手行：多为中途 RUN_FINISHED 后迟到 TEXT 挂空 turnId（需 gateway 含 late-stream 挂回修复）；历史孤儿重载后无法自愈。",
  );
  lines.push(
    "- 上拉到顶看不到更早消息 → 看「消息/投影窗口」hasOlder、wouldTrigger、!HISTORY_TOP；直播 overflow 尾窗曾整窗替换冲掉 loadOlder（需同 epoch 保历史）。",
  );
  return lines.join("\n");
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function problemBadge(
  layout: V4ChatLayoutDump | null,
  turns?: VisibleTurnProbe[] | null,
  history?: HistoryLoadProbe | null,
  scrollTop?: number,
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
  if (turns?.some((t) => t.emptyAssistantCompleted)) {
    parts.push("!EMPTY_ASSISTANT");
  }
  // 视觉已到顶，但投影仍声明有更早行 → 预取该响却可能卡住 / 刚被尾窗冲掉
  if (
    history &&
    typeof scrollTop === "number" &&
    scrollTop <= 8 &&
    history.hasOlder &&
    !history.loadingOlder
  ) {
    parts.push("!HISTORY_TOP");
  }
  return parts.join(" ");
}

export function V4ViewportDebugOverlay() {
  const { enabled: obsEnabled } = useObsEnabled();
  const [prefOn, setPrefOn] = useState(readOverlayPref);
  const [minimized, setMinimized] = useState(false);
  const [tab, setTab] = useState<OverlayTab>(readOverlayTab);
  const [snapshot, setSnapshot] = useState<OverlaySnapshot | null>(null);
  const [expandedTurn, setExpandedTurn] = useState<string | null>(null);
  const [expandedStreamId, setExpandedStreamId] = useState<number | null>(null);
  const [expandedApiId, setExpandedApiId] = useState<number | null>(null);
  const [apiFamily, setApiFamily] = useState<ApiFamilyFilter>("all");
  const [streamEntries, setStreamEntries] = useState<ViewportStreamTapEntry[]>(
    () => listViewportStreamTapEntries({ limit: 48 }),
  );
  const [apiEntries, setApiEntries] = useState<ViewportApiTapEntry[]>(() =>
    listViewportApiTapEntries({ limit: 64 }),
  );
  const [copyHint, setCopyHint] = useState<string | null>(null);
  const [pos, setPos] = useState(defaultOverlayPos);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const streamScrollRef = useRef<HTMLDivElement | null>(null);
  const streamFollowBottomRef = useRef(true);
  const apiScrollRef = useRef<HTMLDivElement | null>(null);
  const apiFollowBottomRef = useRef(true);
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

  const refreshStream = useCallback(() => {
    setStreamEntries(
      listViewportStreamTapEntries({
        sessionKey: snapshot?.sessionKey ?? null,
        limit: 48,
      }),
    );
  }, [snapshot?.sessionKey]);

  const refreshApi = useCallback(() => {
    setApiEntries(
      listViewportApiTapEntries({
        family: apiFamily,
        limit: 64,
      }),
    );
  }, [apiFamily]);

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

  useEffect(() => {
    if (!active) return;
    refreshStream();
    let raf = 0;
    const unsub = subscribeViewportStreamTap(() => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        refreshStream();
      });
    });
    return () => {
      unsub();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [active, refreshStream]);

  useEffect(() => {
    if (!active) return;
    refreshApi();
    let raf = 0;
    const unsub = subscribeViewportApiTap(() => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        refreshApi();
      });
    });
    return () => {
      unsub();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [active, refreshApi]);

  const selectTab = useCallback((next: OverlayTab) => {
    setTab(next);
    writeOverlayTab(next);
    if (next === "stream") {
      streamFollowBottomRef.current = true;
    }
    if (next === "api") {
      apiFollowBottomRef.current = true;
    }
  }, []);

  // 流式页：默认贴最新（底部）；用户上滚后停跟，滚回底附近再恢复。
  useLayoutEffect(() => {
    if (!active || tab !== "stream" || !streamFollowBottomRef.current) return;
    const el = streamScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [active, tab, streamEntries]);

  // 接口页：同样贴底跟最新；上滚看历史入参/出参。
  useLayoutEffect(() => {
    if (!active || tab !== "api" || !apiFollowBottomRef.current) return;
    const el = apiScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [active, tab, apiEntries]);

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
    () =>
      problemBadge(
        snapshot?.layout ?? null,
        snapshot?.turns ?? null,
        snapshot?.history ?? null,
        snapshot?.scrollTop,
      ),
    [snapshot],
  );
  const visibleHost = snapshot?.layout?.hosts.find((h) => h.visibleAttr === "1");

  const flashCopyHint = useCallback((ok: boolean, label: string) => {
    setCopyHint(ok ? label : "复制失败");
    window.setTimeout(() => setCopyHint(null), 1600);
  }, []);

  const copyDiagnostic = useCallback(async () => {
    // 复制前先刷一帧，避免贴出去的是过期快照。
    const fresh = collectOverlaySnapshot();
    if (fresh) setSnapshot(fresh);
    const text = buildOverlayDiagnosticText({
      tab,
      snapshot: fresh ?? snapshot,
      streamEntries: listViewportStreamTapEntries({
        sessionKey: (fresh ?? snapshot)?.sessionKey ?? null,
        limit: 48,
      }),
      apiEntries: listViewportApiTapEntries({
        family: apiFamily,
        limit: 64,
      }),
      problems: problemBadge(
        (fresh ?? snapshot)?.layout ?? null,
        (fresh ?? snapshot)?.turns ?? null,
        (fresh ?? snapshot)?.history ?? null,
        (fresh ?? snapshot)?.scrollTop,
      ),
    });
    const ok = await copyTextToClipboard(text);
    flashCopyHint(ok, "已复制诊断");
  }, [snapshot, tab, apiFamily, flashCopyHint]);

  const copySessionId = useCallback(
    async (kind: "tid" | "sk") => {
      const fresh = collectOverlaySnapshot();
      if (fresh) setSnapshot(fresh);
      const snap = fresh ?? snapshot;
      const value =
        kind === "tid"
          ? String(snap?.tid || "").trim()
          : String(snap?.sessionKey || "").trim();
      if (!value) {
        flashCopyHint(false, kind === "tid" ? "无 tid" : "无 sk");
        return;
      }
      const ok = await copyTextToClipboard(value);
      flashCopyHint(ok, kind === "tid" ? "已复制 tid" : "已复制 sk");
    },
    [snapshot, flashCopyHint],
  );

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
            style={{
              ...btnStyle,
              borderColor: copyHint
                ? "rgba(134,239,172,0.55)"
                : "rgba(148,163,184,0.35)",
              color: copyHint ? "#86efac" : "#f8fafc",
            }}
            onClick={() => {
              void copyDiagnostic();
            }}
            title="复制诊断包（会话/运行态/布局/视口 turn DOM↔ROW/最近流式 JSON），直接贴给 Agent 排查"
          >
            {copyHint || "复制诊断"}
          </button>
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
              {/* 常驻一行摘要：省纵向空间；tid/sk 可一键复制查库 */}
              <div
                style={{
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "5px 8px",
                  borderRadius: 6,
                  background: "rgba(51,65,85,0.45)",
                  color: "#cbd5e1",
                  fontSize: 11,
                  minWidth: 0,
                }}
              >
                <div
                  style={{
                    ...mono,
                    flex: 1,
                    minWidth: 0,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                  title={`「${snapshot.title || snapshot.tid}」\ntid=${snapshot.tid}\nsk=${snapshot.sessionKey || "∅"}`}
                >
                  <b style={{ color: "#f8fafc" }}>
                    「{snapshot.title || snapshot.tid.slice(0, 8)}」
                  </b>
                  <span style={{ color: "#94a3b8" }}>
                    {" "}
                    tid={snapshot.tid.slice(0, 8)}
                    {snapshot.sessionKey
                      ? ` sk=${snapshot.sessionKey.slice(0, 14)}`
                      : ""}
                  </span>
                  {" · "}
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
                    ph={snapshot.runStatus.turnPhase}
                    {snapshot.runStatus.streamWireSource
                      ? ` wire=${snapshot.runStatus.streamWireSource}`
                      : " wire=∅"}
                    {snapshot.runStatus.v4FramesSseOpen ? " frames✓" : " frames✗"}
                    {snapshot.runStatus.uiTurnSettled ? " settled" : ""}
                    {snapshot.runStatus.execWhy
                      ? ` why=${snapshot.runStatus.execWhy}`
                      : ""}
                    {" · "}
                    scroll={snapshot.scrollTop}/{snapshot.scrollHeight} gap=
                    {visibleHost?.medianGap ?? "∅"}
                    {visibleHost?.estimateStuck ? " !EST72" : ""} turns=
                    {snapshot.turns.length}
                  </span>
                </div>
                <span
                  style={{
                    flexShrink: 0,
                    display: "flex",
                    gap: 4,
                  }}
                >
                  <button
                    type="button"
                    style={btnStyle}
                    title={`复制完整 threadId\n${snapshot.tid}`}
                    onClick={() => {
                      void copySessionId("tid");
                    }}
                  >
                    复制tid
                  </button>
                  <button
                    type="button"
                    style={{
                      ...btnStyle,
                      opacity: snapshot.sessionKey ? 1 : 0.45,
                    }}
                    disabled={!snapshot.sessionKey}
                    title={
                      snapshot.sessionKey
                        ? `复制完整 session_key\n${snapshot.sessionKey}`
                        : "当前无 sessionKey"
                    }
                    onClick={() => {
                      void copySessionId("sk");
                    }}
                  >
                    复制sk
                  </button>
                </span>
              </div>

              <div
                style={{
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "2px",
                  borderRadius: 8,
                  background: "rgba(30,41,59,0.85)",
                }}
              >
                {(
                  [
                    ["status", "运行"],
                    ["stream", `流式(${streamEntries.length})`],
                    ["api", `接口(${apiEntries.length})`],
                    ["viewport", `视口(${snapshot.turns.length})`],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    style={{
                      ...tabBtnBase,
                      background:
                        tab === id ? "rgba(51,65,85,0.95)" : "transparent",
                      color: tab === id ? "#f8fafc" : "#94a3b8",
                      borderColor:
                        tab === id
                          ? "rgba(148,163,184,0.35)"
                          : "transparent",
                      fontSize: 11,
                      padding: "3px 7px",
                    }}
                    onClick={() => selectTab(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflow: "hidden",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                {tab === "status" ? (
                  <div
                    style={{
                      ...mono,
                      flex: 1,
                      minHeight: 0,
                      overflow: "auto",
                      fontSize: 11,
                      color: "#cbd5e1",
                      padding: "4px 2px",
                    }}
                  >
                    <div style={{ marginBottom: 6 }}>
                      状态{" "}
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
                      {" · "}phase={snapshot.runStatus.turnPhase}
                      {" · "}wire=
                      {snapshot.runStatus.streamWireSource || "∅"}
                      {" · "}frames=
                      {snapshot.runStatus.v4FramesSseOpen ? "连" : "断"}
                      {" · "}settled=
                      {snapshot.runStatus.uiTurnSettled ? "1" : "0"}
                      {" · "}exec=
                      {snapshot.runStatus.executing ? "1" : "0"}
                      {" · "}why={snapshot.runStatus.execWhy || "∅"}
                    </div>
                    {snapshot.runStatus.mode === "sse" ? (
                      <div style={{ color: "#a5f3fc", marginBottom: 6 }}>
                        AG-UI POST /runs/stream 仍开着（浏览器持有 live SSE）
                      </div>
                    ) : null}
                    {snapshot.runStatus.mode === "running" ? (
                      snapshot.runStatus.polls.length === 0 ? (
                        <div style={{ color: "#fde68a", marginBottom: 6 }}>
                          运行中、无本机 SSE；未检测到 history-watch / catchup
                        </div>
                      ) : (
                        snapshot.runStatus.polls.map((p, i) => (
                          <div
                            key={`${p.owner}:${i}`}
                            style={{
                              marginBottom: 6,
                              padding: "5px 8px",
                              borderRadius: 6,
                              background: p.active
                                ? "rgba(180, 83, 9, 0.28)"
                                : "rgba(30, 41, 59, 0.65)",
                              color: p.active ? "#fde68a" : "#94a3b8",
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                            title={`(a)${p.target}\n(b)${p.owner}`}
                          >
                            轮询 {p.active ? "●" : "○"} 每{p.intervalSec}s ·{" "}
                            {p.owner}
                          </div>
                        ))
                      )
                    ) : (
                      <div style={{ color: "#64748b" }}>
                        historyWatch=
                        {snapshot.runStatus.historyWatchActive ? "1" : "0"} ·
                        v4Busy=
                        {snapshot.runStatus.v4TimelineBusy ? "1" : "0"}
                      </div>
                    )}
                    <div style={{ marginTop: 8, color: "#94a3b8" }}>
                      scroll={snapshot.scrollTop}/{snapshot.scrollHeight} ·
                      client={snapshot.clientHeight} · gap=
                      {visibleHost?.medianGap ?? "∅"}
                      {visibleHost?.estimateStuck ? " !EST72" : ""} · 视口 turn=
                      {snapshot.turns.length}
                    </div>
                    <div
                      style={{
                        marginTop: 10,
                        padding: "6px 8px",
                        borderRadius: 6,
                        background: "rgba(15, 23, 42, 0.55)",
                        color: "#cbd5e1",
                        lineHeight: 1.45,
                      }}
                    >
                      <div style={{ color: "#e2e8f0", fontWeight: 600 }}>
                        消息计数 · 投影窗{" "}
                        {snapshot.history.windowCount}/
                        {snapshot.history.totalCount ?? "∅"}
                        {" · "}用户气泡 {snapshot.history.windowUserCount}
                        {" · "}轮 {snapshot.history.windowTurnCount}
                      </div>
                      <div style={{ marginTop: 2, color: "#94a3b8" }}>
                        rowId first={snapshot.history.firstRowId ?? "∅"} · 窗=
                        {snapshot.history.windowFirstRowId ?? "∅"}…
                        {snapshot.history.windowLastRowId ?? "∅"}
                      </div>
                      <div style={{ marginTop: 4 }}>
                        上拉预取{" "}
                        <b
                          style={{
                            color: snapshot.history.wouldTrigger
                              ? "#fbbf24"
                              : snapshot.history.inPrefetchZone
                                ? "#67e8f9"
                                : "#86efac",
                          }}
                        >
                          {snapshot.history.loadingOlder
                            ? "加载中"
                            : snapshot.history.wouldTrigger
                              ? "应触发"
                              : snapshot.history.inPrefetchZone
                                ? snapshot.history.hasOlder
                                  ? "在预取带"
                                  : "到顶·无更早"
                                : "未到预取带"}
                        </b>
                        {" · "}hasOlder=
                        {snapshot.history.hasOlder ? "1" : "0"}
                        {" · "}trigger≤{snapshot.history.triggerPx}px
                        {" · "}scrollTop={snapshot.scrollTop}
                      </div>
                      <div style={{ marginTop: 2, color: "#64748b", fontSize: 10 }}>
                        规则：scrollTop ≤ max(64, 2×视口高) 才自动 loadOlder，不是一上滚就拉
                      </div>
                    </div>
                  </div>
                ) : null}

                {tab === "stream" ? (
                  <div
                    style={{
                      flex: 1,
                      minHeight: 0,
                      display: "flex",
                      flexDirection: "column",
                      border: "1px solid rgba(167,139,250,0.35)",
                      borderRadius: 8,
                      overflow: "hidden",
                      background: "rgba(76, 29, 149, 0.18)",
                    }}
                  >
                    <div
                      style={{
                        ...mono,
                        flexShrink: 0,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "4px 8px",
                        background: "rgba(55, 48, 163, 0.45)",
                        color: "#c4b5fd",
                        fontSize: 11,
                      }}
                    >
                      <span>最新在底 · 上滚看旧 · 点行展开 JSON</span>
                      <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                        <button
                          type="button"
                          style={btnStyle}
                          title="滚到最新并恢复跟新"
                          onClick={() => {
                            streamFollowBottomRef.current = true;
                            const el = streamScrollRef.current;
                            if (el) el.scrollTop = el.scrollHeight;
                          }}
                        >
                          最新
                        </button>
                        <button
                          type="button"
                          style={btnStyle}
                          title="清空环形缓冲"
                          onClick={() => clearViewportStreamTap()}
                        >
                          清空
                        </button>
                      </span>
                    </div>
                    <div
                      ref={streamScrollRef}
                      onScroll={(e) => {
                        const el = e.currentTarget;
                        const dist =
                          el.scrollHeight - el.scrollTop - el.clientHeight;
                        streamFollowBottomRef.current = dist < 56;
                      }}
                      style={{
                        ...mono,
                        flex: 1,
                        minHeight: 120,
                        overflow: "auto",
                        padding: "4px 6px 8px",
                        fontSize: 11,
                        color: "#ede9fe",
                      }}
                    >
                      {streamEntries.length === 0 ? (
                        <div style={{ color: "#a78bfa", padding: 8 }}>
                          尚无流式帧。发消息后这里贴底显示最新 AG-UI / V4 JSON。
                        </div>
                      ) : (
                        streamEntries.map((entry, idx) => {
                          const newest = idx >= streamEntries.length - 2;
                          const open = expandedStreamId === entry.id;
                          const time = new Date(entry.atMs).toLocaleTimeString(
                            "zh-CN",
                            {
                              hour12: false,
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                            },
                          );
                          return (
                            <div
                              key={entry.id}
                              style={{
                                marginBottom: 2,
                                borderRadius: 4,
                                border: newest
                                  ? "1px solid rgba(196,181,253,0.45)"
                                  : "1px solid transparent",
                                background: newest
                                  ? "rgba(91, 33, 182, 0.28)"
                                  : "transparent",
                              }}
                            >
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedStreamId((cur) =>
                                    cur === entry.id ? null : entry.id,
                                  )
                                }
                                style={{
                                  all: "unset",
                                  cursor: "pointer",
                                  display: "block",
                                  width: "100%",
                                  boxSizing: "border-box",
                                  padding: "3px 6px",
                                  color: newest ? "#f5f3ff" : "#c4b5fd",
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                }}
                                title={entry.headline}
                              >
                                {open ? "▼" : "▶"} #{entry.id} {time}{" "}
                                {entry.headline}
                              </button>
                              {open ? (
                                <pre
                                  style={{
                                    margin: "0 4px 6px",
                                    padding: 8,
                                    borderRadius: 4,
                                    background: "rgba(2,6,23,0.88)",
                                    color: "#f8fafc",
                                    whiteSpace: "pre-wrap",
                                    wordBreak: "break-word",
                                    maxHeight: 200,
                                    overflow: "auto",
                                    fontSize: 11,
                                  }}
                                >
                                  {entry.jsonText}
                                </pre>
                              ) : null}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                ) : null}

                {tab === "api" ? (
                  <div
                    style={{
                      flex: 1,
                      minHeight: 0,
                      display: "flex",
                      flexDirection: "column",
                      border: "1px solid rgba(52,211,153,0.35)",
                      borderRadius: 8,
                      overflow: "hidden",
                      background: "rgba(6, 78, 59, 0.18)",
                    }}
                  >
                    <div
                      style={{
                        ...mono,
                        flexShrink: 0,
                        display: "flex",
                        flexDirection: "column",
                        gap: 4,
                        padding: "4px 8px",
                        background: "rgba(6, 95, 70, 0.45)",
                        color: "#a7f3d0",
                        fontSize: 11,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <span>页面相关 HTTP · 最新在底 · 点行看入参/出参</span>
                        <span
                          style={{
                            marginLeft: "auto",
                            display: "flex",
                            gap: 4,
                          }}
                        >
                          <button
                            type="button"
                            style={btnStyle}
                            title="滚到最新并恢复跟新"
                            onClick={() => {
                              apiFollowBottomRef.current = true;
                              const el = apiScrollRef.current;
                              if (el) el.scrollTop = el.scrollHeight;
                            }}
                          >
                            最新
                          </button>
                          <button
                            type="button"
                            style={btnStyle}
                            title="清空接口环形缓冲"
                            onClick={() => clearViewportApiTap()}
                          >
                            清空
                          </button>
                        </span>
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {(
                          [
                            ["all", "全部"],
                            ["v4", "V4投影"],
                            ["messages", "轨迹消息"],
                            ["catchup", "catchup"],
                            ["runs", "runs"],
                          ] as const
                        ).map(([id, label]) => (
                          <button
                            key={id}
                            type="button"
                            style={{
                              ...btnStyle,
                              background:
                                apiFamily === id
                                  ? "rgba(16,185,129,0.35)"
                                  : "rgba(15,23,42,0.45)",
                              color: apiFamily === id ? "#ecfdf5" : "#a7f3d0",
                              borderColor:
                                apiFamily === id
                                  ? "rgba(52,211,153,0.55)"
                                  : "rgba(148,163,184,0.25)",
                            }}
                            onClick={() => {
                              setApiFamily(id);
                              apiFollowBottomRef.current = true;
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div
                      style={{
                        ...mono,
                        flexShrink: 0,
                        display: "grid",
                        gridTemplateColumns: "44px 56px 72px 40px 48px 1fr",
                        gap: 4,
                        padding: "3px 8px",
                        background: "rgba(2, 44, 34, 0.55)",
                        color: "#6ee7b7",
                        fontSize: 10,
                        borderBottom: "1px solid rgba(52,211,153,0.25)",
                      }}
                    >
                      <span>#</span>
                      <span>时间</span>
                      <span>接口</span>
                      <span>码</span>
                      <span>耗时</span>
                      <span>摘要</span>
                    </div>
                    <div
                      ref={apiScrollRef}
                      onScroll={(e) => {
                        const el = e.currentTarget;
                        const dist =
                          el.scrollHeight - el.scrollTop - el.clientHeight;
                        apiFollowBottomRef.current = dist < 56;
                      }}
                      style={{
                        ...mono,
                        flex: 1,
                        minHeight: 120,
                        overflow: "auto",
                        padding: "4px 6px 8px",
                        fontSize: 11,
                        color: "#d1fae5",
                      }}
                    >
                      {apiEntries.length === 0 ? (
                        <div style={{ color: "#6ee7b7", padding: 8 }}>
                          尚无页面相关接口。切会话 / 发消息 / catchup
                          后，这里会记下 subscribe、messages、catchup 等入参出参。
                        </div>
                      ) : (
                        apiEntries.map((entry, idx) => {
                          const newest = idx >= apiEntries.length - 2;
                          const open = expandedApiId === entry.id;
                          const time = new Date(entry.atMs).toLocaleTimeString(
                            "zh-CN",
                            {
                              hour12: false,
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                            },
                          );
                          return (
                            <div
                              key={entry.id}
                              style={{
                                marginBottom: 2,
                                borderRadius: 4,
                                border: newest
                                  ? "1px solid rgba(110,231,183,0.45)"
                                  : "1px solid transparent",
                                background: newest
                                  ? "rgba(6, 95, 70, 0.35)"
                                  : entry.ok
                                    ? "transparent"
                                    : "rgba(127, 29, 29, 0.28)",
                              }}
                            >
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedApiId((cur) =>
                                    cur === entry.id ? null : entry.id,
                                  )
                                }
                                style={{
                                  all: "unset",
                                  cursor: "pointer",
                                  display: "grid",
                                  gridTemplateColumns:
                                    "44px 56px 72px 40px 48px 1fr",
                                  gap: 4,
                                  width: "100%",
                                  boxSizing: "border-box",
                                  padding: "3px 6px",
                                  color: entry.ok ? "#d1fae5" : "#fecaca",
                                  alignItems: "center",
                                }}
                                title={entry.headline}
                              >
                                <span>
                                  {open ? "▼" : "▶"}
                                  {entry.id}
                                </span>
                                <span>{time}</span>
                                <span
                                  style={{
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {entry.method.slice(0, 4)} {entry.label}
                                </span>
                                <span>{entry.status || "—"}</span>
                                <span>{entry.durationMs}ms</span>
                                <span
                                  style={{
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                    color: "#a7f3d0",
                                  }}
                                >
                                  {entry.headline}
                                </span>
                              </button>
                              {open ? (
                                <div
                                  style={{
                                    margin: "0 4px 6px",
                                    display: "grid",
                                    gridTemplateColumns: "1fr 1fr",
                                    gap: 6,
                                  }}
                                >
                                  <div>
                                    <div
                                      style={{
                                        color: "#6ee7b7",
                                        marginBottom: 2,
                                        fontSize: 10,
                                      }}
                                    >
                                      入参 · {entry.path}
                                      {entry.query ? `?${entry.query}` : ""}
                                    </div>
                                    <pre
                                      style={{
                                        margin: 0,
                                        padding: 8,
                                        borderRadius: 4,
                                        background: "rgba(2,6,23,0.88)",
                                        color: "#f8fafc",
                                        whiteSpace: "pre-wrap",
                                        wordBreak: "break-word",
                                        maxHeight: 220,
                                        overflow: "auto",
                                        fontSize: 11,
                                      }}
                                    >
                                      {entry.requestText || "（无 body）"}
                                    </pre>
                                  </div>
                                  <div>
                                    <div
                                      style={{
                                        color: entry.ok ? "#6ee7b7" : "#fca5a5",
                                        marginBottom: 2,
                                        fontSize: 10,
                                      }}
                                    >
                                      出参 · {entry.ok ? "ok" : "fail"} ·{" "}
                                      {entry.status}
                                    </div>
                                    <pre
                                      style={{
                                        margin: 0,
                                        padding: 8,
                                        borderRadius: 4,
                                        background: "rgba(2,6,23,0.88)",
                                        color: "#f8fafc",
                                        whiteSpace: "pre-wrap",
                                        wordBreak: "break-word",
                                        maxHeight: 220,
                                        overflow: "auto",
                                        fontSize: 11,
                                      }}
                                    >
                                      {entry.responseText || "（空）"}
                                    </pre>
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                ) : null}

                {tab === "viewport" ? (
                  <div
                    style={{
                      flex: 1,
                      minHeight: 0,
                      overflow: "auto",
                      paddingRight: 2,
                    }}
                  >
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: 8,
                        marginBottom: 6,
                        position: "sticky",
                        top: 0,
                        zIndex: 1,
                        background: "rgba(15,23,42,0.96)",
                        paddingBottom: 2,
                      }}
                    >
                      <div style={{ ...colHeadStyle, color: "#86efac" }}>
                        左 · DOM
                      </div>
                      <div style={{ ...colHeadStyle, color: "#c4b5fd" }}>
                        右 · 投影 row
                      </div>
                    </div>

                    {snapshot.turns.length === 0 ? (
                      <div style={{ color: "#fbbf24" }}>
                        视口内没有 turn（空白常见：滚动与虚拟窗口错位）
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
                                  return `${kind} ${r.toolName}${
                                    r.status ? ` [${r.status}]` : ""
                                  }`;
                                }
                                if (typeof r.text === "string" && r.text) {
                                  return `${kind} ${clip(r.text, 80)}`;
                                }
                                if (typeof r.origin === "string") {
                                  return `${kind} origin=${r.origin}`;
                                }
                                if (typeof r.state === "string") {
                                  return `${kind} state=${r.state}`;
                                }
                                return kind;
                              })
                              .join(" · ");
                      return (
                        <div
                          key={`${t.turnId}:${t.dataIndex}`}
                          style={{
                            border: gapWarn
                              ? "1px solid rgba(251,191,36,0.55)"
                              : "1px solid rgba(148,163,184,0.22)",
                            borderRadius: 8,
                            marginBottom: 8,
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
                              padding: "5px 10px",
                              background: "rgba(30,41,59,0.85)",
                              color: "#93c5fd",
                              ...mono,
                              fontSize: 11,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                            }}
                          >
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                              #{t.dataIndex ?? "∅"} turn={t.turnId.slice(0, 8)} h=
                              {t.height}
                              {t.gapToNext != null
                                ? ` gap→${t.gapToNext}${gapWarn ? " ⚠" : ""}`
                                : ""}
                            </span>
                            <span style={{ marginLeft: "auto", color: "#94a3b8" }}>
                              {open ? "▲" : "▼"}
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
                                maxHeight: 120,
                                minHeight: 56,
                                borderRight:
                                  "1px solid rgba(148,163,184,0.22)",
                                background: "rgba(6, 78, 59, 0.22)",
                                color: "#d1fae5",
                              }}
                            >
                              {t.displayText || "（界面无文字）"}
                            </div>
                            <div
                              style={{
                                ...paneStyle,
                                maxHeight: 120,
                                minHeight: 56,
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
                                padding: 10,
                                borderTop: "1px solid rgba(148,163,184,0.18)",
                                background: "rgba(2,6,23,0.88)",
                                color: "#f1f5f9",
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                                maxHeight: 220,
                                overflow: "auto",
                                ...mono,
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
                  </div>
                ) : null}
              </div>
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
