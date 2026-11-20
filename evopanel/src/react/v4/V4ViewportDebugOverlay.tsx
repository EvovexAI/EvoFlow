/**
 * V4 视口调试浮层：紧凑状态条 + 分页
 * - 运行：SSE / 轮询 / settled
 * - 消息：投影窗已显示/全序行数、用户气泡、loadOlder 预取带（≤2×视口）
 * - 流式：AG-UI / V4 原始 JSON（一行一条，全文可滚，会话目录落盘）
 * - 画面：约每秒一帧「页面上看得见什么」（用户/正文/思考/工具），排查乱套用
 * - 计时/水位线：发送 → 出泡上屏 → 上线 → 首字 → 结束；正常收紧、异常留证（复制诊断必带）
 * - 滚轮：scrollTop 轨迹 / !JUMP / 到顶语义（能否自动拉历史 vs 已拉尽）
 * - 接口：页面相关 HTTP（subscribe / messages / catchup…）入参出参表
 * - 视口：DOM ↔ 投影 row
 * - 虚拟化：投影软顶 / 窗首尾 / 流式 tip / 直播轮（转圈+SSE、上滚历史必看）
 * - 异常：流式无画面 / 最新气泡错位 / loadOlder 不前进 / 绘画埋没…（可监测表）
 * 布局诊断（!EST72 / gap）仍在状态条；问题标记优先吃异常表。
 * 抽头落盘：~/.evoflow/logs/stream-compare/{sessionId}/overlay/viewport-*.log
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
  attachViewportScrollTap,
  clearViewportScrollTap,
  countViewportScrollJumps,
  detachViewportScrollTap,
  formatConversationRecordCounts,
  formatScrollTopVerdict,
  listViewportScrollTapEntries,
  setViewportScrollHistoryContext,
  setViewportScrollTapSessionId,
  subscribeViewportScrollTap,
  type ViewportScrollTapEntry,
} from "./v4-viewport-scroll-tap.js";
import {
  hasOlderRows,
} from "@zcode/ui/v4/conversationProjectionStore.js";
import {
  historyPrefetchTriggerPx,
  shouldTriggerLoadOlder,
} from "@zcode/ui/v4/timelineScrollAnchor.js";
import { buildConversationTurnRenderUnits } from "@zcode/ui/v4/conversationTurnRenderUnits.js";
import {
  classifyEmptyAssistantCompleted,
  collectViewportAnomalies,
  formatAnomalyBadge,
  mergeStickyViewportAnomalies,
  type StickyViewportAnomaly,
  type ViewportAnomaly,
} from "./v4-viewport-anomaly.js";
import {
  collectVirtualizationProbe,
  formatVirtualizationProbeForDiag,
  type VirtualizationProbe,
} from "./v4-viewport-virtualization-probe.js";
import {
  classifyChatTurnTimingVerdict,
  formatChatTurnWaterlineForDiag,
  listChatTurnAnomalies,
  listChatTurnTimingRows,
  subscribeChatTurnTiming,
  type ChatTurnTimingRow,
} from "../lib/chat-turn-timing-log.js";
import {
  clearViewportPageSnap,
  listViewportPageSnapEntries,
  pageVisibleBitsFromRawRows,
  pushViewportPageSnap,
  subscribeViewportPageSnap,
  turnsFromWindowRows,
  type ViewportPageSnapEntry,
} from "./v4-viewport-page-snap.js";

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
  /** 底边 Y（top+height），用于叠层判定 */
  bottom: number;
  height: number;
  displayText: string;
  /** 与下一 turn 的 top 差；末条为 null */
  gapToNext: number | null;
  /**
   * 下一卡 top − 本卡 bottom：负值=肉眼重叠（估高叠字现场）。
   * 末条为 null。
   */
  spaceToNext: number | null;
  /** spaceToNext &lt; -8 → 与下一卡在屏幕上叠在一起 */
  overlapsNext: boolean;
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
  /** 视口相交的 turn（布局/空隙诊断） */
  turns: VisibleTurnProbe[];
  /** 投影窗全序 row（视口页 1:1 摊平用，含最新发送，不跟滚动丢） */
  windowRows: Array<Record<string, unknown>>;
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

/** 视口左栏：单行给人看的摘要（与右栏 JSON 1:1） */
function viewportRowLeftLabel(r: Record<string, unknown>): string {
  const kind = String(r.kind || "?");
  if (kind === "userInput") {
    return `用户 ${clip(r.text, 100) || "（空）"}`;
  }
  if (kind === "assistantText") {
    return `正文 ${clip(r.text, 100) || "（空）"}`;
  }
  if (kind === "reasoning") {
    return `思考 ${clip(r.text, 80) || "（空）"}`;
  }
  if (kind === "toolCall") {
    const name = String(r.toolName || r.name || "tool");
    const status = r.status ? `[${String(r.status)}]` : "";
    return `工具 ${name}${status}`;
  }
  if (kind === "turnHeader") {
    const origin = r.origin ? ` origin=${String(r.origin)}` : "";
    const state = r.state ? ` state=${String(r.state)}` : "";
    return `轮头${origin}${state}`;
  }
  if (kind === "subagent") {
    return `子代理 ${String(r.subagentType || "")} ${clip(r.summaryText, 60)}`;
  }
  if (kind === "artifact") {
    return `产物 ${String(r.displayName || r.artifactType || "")}`;
  }
  return kind;
}

/** 视口右栏：单行 JSON 摘要（完整对象点开 turn 再看） */
function viewportRowJsonSummary(r: Record<string, unknown>): string {
  try {
    return JSON.stringify(r);
  } catch {
    return String(r);
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
  scrollHeight: number = 0,
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
    // 跟底中不预取（与 ConversationTimeline 一致）；否则短尾窗会假阳性 auto=1。
    const followingAttr =
      typeof document !== "undefined"
        ? document
            .querySelector('[data-v4-chat-host-visible="1"] [data-following]')
            ?.getAttribute("data-following")
        : null;
    const following = followingAttr !== "false";
    const distanceFromBottom = Math.max(
      0,
      (scrollHeight || 0) - scrollTop - clientHeight,
    );
    const wouldTrigger = shouldTriggerLoadOlder({
      scrollTop,
      canLoadOlder: hasOlder,
      loadingOlder,
      triggerPx,
      following,
      distanceFromBottom,
      viewportHeight: clientHeight,
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
  let windowRowsFlat: Array<Record<string, unknown>> = [];
  if (tid) {
    try {
      const snap = getSharedV4SessionDataLayer()
        .peekStore(tid)
        ?.getState()?.snapshot;
      const windowRows = snap?.rows?.window ?? [];
      windowRowsFlat = windowRows.map((row) =>
        summarizeRow(row),
      ) as Array<Record<string, unknown>>;
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
      windowRowsFlat = [];
    }
  }

  const turns: VisibleTurnProbe[] = visibleEls.map(({ el, r }, i) => {
    const turnId = String(el.getAttribute("data-turn-id") || "").trim();
    const next = visibleEls[i + 1];
    const top = Math.round(r.top);
    const height = Math.round(r.height);
    const bottom = top + height;
    const gapToNext = next ? Math.round(next.r.top - r.top) : null;
    const spaceToNext = next ? Math.round(next.r.top - r.bottom) : null;
    // 允许 8px 缝；再负就是绝对定位叠在一起（肉眼重叠）。
    const overlapsNext = spaceToNext != null && spaceToNext < -8;
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
    const executionKind =
      header && typeof (header as { executionKind?: unknown }).executionKind === "string"
        ? String((header as { executionKind: string }).executionKind)
        : null;
    const rawEmpty = classifyEmptyAssistantCompleted({
      headerOrigin,
      headerState,
      executionKind,
      rows: raw.map((row) => ({
        kind: String(row.kind || ""),
        origin:
          typeof (row as { origin?: unknown }).origin === "string"
            ? String((row as { origin: string }).origin)
            : undefined,
        text:
          typeof (row as { text?: unknown }).text === "string"
            ? String((row as { text: string }).text)
            : undefined,
      })),
    });
    // 后方已有续跑正文时，渲染会撤掉本轮 empty-run；探针跟时间线一致。
    let emptyAssistantCompleted = rawEmpty;
    if (raw.length > 0) {
      try {
        const units = buildConversationTurnRenderUnits(raw, { sessionBusy: false });
        emptyAssistantCompleted = units.some(
          (unit) =>
            unit.visibleUserInputs.some(
              (u) =>
                (!u.origin || u.origin === "realUser") &&
                Boolean(String(u.text || "").trim()),
            ) &&
            unit.assistantTextRows.length === 0 &&
            unit.assistantWorkRows.length === 0 &&
            !!unit.header?.state &&
            (String(unit.header.state).startsWith("completed") ||
              unit.header.state === "failed"),
        );
      } catch {
        emptyAssistantCompleted = rawEmpty;
      }
    }
    return {
      turnId: turnId || `anon-${i}`,
      dataIndex: el.getAttribute("data-index"),
      top,
      bottom,
      height,
      // 肉眼所见：截长一点，复制诊断靠这段对齐屏幕
      displayText: clip(el.innerText || "", 480),
      gapToNext,
      spaceToNext,
      overlapsNext,
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
    history: collectHistoryLoadProbe(tid, scrollTop, clientHeight, scrollHeight),
    turns,
    windowRows: windowRowsFlat,
  };
}

const OVERLAY_WIDTH_PX = 1100;
const OVERLAY_HEIGHT_PX = 860;
const OVERLAY_MIN_WIDTH_PX = 520;
const OVERLAY_MIN_HEIGHT_PX = 320;
const OVERLAY_DEFAULT_BOTTOM_GAP = 72;
const OVERLAY_EDGE_PAD = 8;
/** 拖拽后标题条至少留在视口内的高度，避免拖飞后抓不到。 */
const OVERLAY_HEADER_MIN_VISIBLE_PX = 44;
const OVERLAY_TAB_LS_KEY = "EVOFLOW_V4_VIEWPORT_OVERLAY_TAB";
const OVERLAY_SIZE_LS_KEY = "EVOFLOW_V4_VIEWPORT_OVERLAY_SIZE";

type OverlayTab =
  | "status"
  | "stream"
  | "page"
  | "timing"
  | "scroll"
  | "api"
  | "viewport"
  | "virt"
  | "anomaly";
type ApiFamilyFilter = "all" | ViewportApiTapFamily | "history";

/** 抽头条：完整换行，不用省略号 */
const tapLineStyle: CSSProperties = {
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  overflowWrap: "anywhere",
};

const tapJsonPreStyle: CSSProperties = {
  margin: "4px 0 0",
  padding: 8,
  borderRadius: 4,
  border: "1px solid rgba(148,163,184,0.35)",
  background: "rgba(2,6,23,0.92)",
  color: "#f8fafc",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  overflowWrap: "anywhere",
  overflow: "auto",
  fontSize: 11,
  lineHeight: 1.35,
};

function readOverlayTab(): OverlayTab {
  try {
    const v = localStorage.getItem(OVERLAY_TAB_LS_KEY);
    if (
      v === "status" ||
      v === "stream" ||
      v === "page" ||
      v === "timing" ||
      v === "scroll" ||
      v === "api" ||
      v === "viewport" ||
      v === "virt" ||
      v === "anomaly"
    ) {
      return v;
    }
  } catch {
    /* ignore */
  }
  return "page";
}

function writeOverlayTab(tab: OverlayTab): void {
  try {
    localStorage.setItem(OVERLAY_TAB_LS_KEY, tab);
  } catch {
    /* ignore */
  }
}

type OverlaySize = { width: number; height: number };

function clampOverlaySize(width: number, height: number): OverlaySize {
  if (typeof window === "undefined") {
    return {
      width: Math.max(OVERLAY_MIN_WIDTH_PX, width),
      height: Math.max(OVERLAY_MIN_HEIGHT_PX, height),
    };
  }
  const maxW = Math.max(OVERLAY_MIN_WIDTH_PX, window.innerWidth - OVERLAY_EDGE_PAD * 2);
  const maxH = Math.max(OVERLAY_MIN_HEIGHT_PX, window.innerHeight - OVERLAY_EDGE_PAD * 2);
  return {
    width: Math.min(maxW, Math.max(OVERLAY_MIN_WIDTH_PX, Math.round(width))),
    height: Math.min(maxH, Math.max(OVERLAY_MIN_HEIGHT_PX, Math.round(height))),
  };
}

function defaultOverlaySize(): OverlaySize {
  if (typeof window === "undefined") {
    return { width: OVERLAY_WIDTH_PX, height: OVERLAY_HEIGHT_PX };
  }
  return clampOverlaySize(
    Math.min(OVERLAY_WIDTH_PX, window.innerWidth - 32),
    Math.min(OVERLAY_HEIGHT_PX, Math.round(window.innerHeight * 0.86)),
  );
}

function readOverlaySize(): OverlaySize {
  try {
    const raw = localStorage.getItem(OVERLAY_SIZE_LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { width?: unknown; height?: unknown };
      const w = Number(parsed?.width);
      const h = Number(parsed?.height);
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
        return clampOverlaySize(w, h);
      }
    }
  } catch {
    /* ignore */
  }
  return defaultOverlaySize();
}

function writeOverlaySize(size: OverlaySize): void {
  try {
    localStorage.setItem(OVERLAY_SIZE_LS_KEY, JSON.stringify(size));
  } catch {
    /* ignore */
  }
}

const shellStyle: CSSProperties = {
  position: "fixed",
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

function defaultOverlayPos(size?: OverlaySize): { left: number; top: number } {
  if (typeof window === "undefined") return { left: 16, top: 120 };
  const s = size || defaultOverlaySize();
  return {
    left: Math.max(OVERLAY_EDGE_PAD, window.innerWidth - s.width - 16),
    top: Math.max(
      OVERLAY_EDGE_PAD,
      window.innerHeight - s.height - OVERLAY_DEFAULT_BOTTOM_GAP,
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

function summarizeTurnRows(
  rawRows: VisibleTurnProbe["rawRows"],
): string {
  if (rawRows.length === 0) return "（投影无此 turn）";
  const kinds = new Map<string, number>();
  for (const r of rawRows) {
    const kind = String(r.kind || "?");
    const key =
      typeof r.toolName === "string"
        ? `${kind}:${r.toolName}`
        : typeof r.origin === "string"
          ? `${kind}:${r.origin}`
          : kind;
    kinds.set(key, (kinds.get(key) ?? 0) + 1);
  }
  const head = [...kinds.entries()]
    .slice(0, 8)
    .map(([k, n]) => (n > 1 ? `${k}×${n}` : k))
    .join(" | ");
  const user = rawRows.find(
    (r) => r.kind === "userInput" && typeof r.text === "string" && r.text.trim(),
  );
  const asst = rawRows.find(
    (r) => r.kind === "assistantText" && typeof r.text === "string" && r.text.trim(),
  );
  const bits = [head];
  if (user?.text) bits.push(`user「${clip(user.text, 48)}」`);
  if (asst?.text) bits.push(`asst「${clip(asst.text, 48)}」`);
  else if (!rawRows.some((r) => r.kind === "assistantText" || r.kind === "toolCall")) {
    bits.push("无助手行");
  }
  return bits.join(" · ");
}

function pickDiagnosticTurns(
  turns: OverlaySnapshot["turns"],
): OverlaySnapshot["turns"] {
  if (turns.length === 0) return turns;
  const flagged = turns.filter(
    (t) =>
      t.orphanHeaderNoUser ||
      t.emptyAssistantCompleted ||
      t.overlapsNext ||
      (t.spaceToNext != null && t.spaceToNext < 24 && t.height > 120),
  );
  if (flagged.length > 0) {
    // 异常/叠层轮 + 其前后各一（上下文），去重保序，最多 6（叠字要多看几卡）
    const want = new Set(flagged);
    for (const t of flagged) {
      const i = turns.indexOf(t);
      if (i > 0) want.add(turns[i - 1]!);
      if (i >= 0 && i < turns.length - 1) want.add(turns[i + 1]!);
    }
    return turns.filter((t) => want.has(t)).slice(0, 6);
  }
  // 健康时只留末 2 轮，够对「最新气泡 / 空回复」
  return turns.slice(-2);
}

function isNoisyApiPath(path: string): boolean {
  const p = path.toLowerCase();
  return (
    p.includes("file_changes") ||
    p.includes("/assets/") ||
    p.includes("/telemetry") ||
    p.includes("/metrics")
  );
}

function isSignalApiPath(path: string): boolean {
  const p = path.toLowerCase();
  return (
    p.includes("rows_range") ||
    p.includes("subscribe") ||
    p.includes("catchup") ||
    p.includes("/frames") ||
    p.includes("snapshot")
  );
}

/**
 * 一键复制给 Agent：异常优先、短证据。
 * 刻意不塞：流式整段 JSON、滚轮流水账、file_changes、百科提示——那些干扰排障。
 */
function buildOverlayDiagnosticText(opts: {
  tab: OverlayTab;
  snapshot: OverlaySnapshot | null;
  streamEntries: ViewportStreamTapEntry[];
  scrollEntries: ViewportScrollTapEntry[];
  apiEntries: ViewportApiTapEntry[];
  /** 水位线对账用（subscribe/chatSend 等，可比 apiEntries 更宽） */
  waterlineApiEntries?: ViewportApiTapEntry[];
  problems: string;
  anomalies: ViewportAnomaly[];
  virt?: VirtualizationProbe | null;
}): string {
  const {
    tab,
    snapshot,
    streamEntries,
    scrollEntries,
    apiEntries,
    waterlineApiEntries,
    problems,
    anomalies,
    virt,
  } = opts;
  const waterlineApis = waterlineApiEntries?.length
    ? waterlineApiEntries
    : apiEntries;
  const lines: string[] = [];
  lines.push("## EvoFlow V4 视口诊断（精简）");
  lines.push(
    `- ${new Date().toISOString()} · tab=${tab} · ${problems || "OK"} · 异常=${anomalies.length}`,
  );
  lines.push("");
  lines.push("### 怎么用");
  lines.push(
    "- 复现「叠字/错位」后立刻点「复制诊断」贴给 Agent——下面「肉眼所见」是屏幕 DOM 文案+坐标，不是投影幻想。",
  );
  lines.push("- 不必复制 HTML/截长图；若肉眼叠了而本节无 !叠下一卡，再说一声。");
  lines.push(
    "- 「发送水位线」：发了几次、何时出泡上屏、上线/首字/收口是否正常；正常只留摘要，异常带前后接口。",
  );
  lines.push(
    "- 「虚拟化」表：软顶/窗首尾/流式 tip/直播轮——转圈但 SSE 在动、上滚没历史，先对这一节。",
  );
  if (!snapshot) {
    lines.push("- 快照: （无可见对话）");
    // 无快照仍尽量带水位线（发了没回也能对账）
    lines.push("");
    lines.push(
      ...formatChatTurnWaterlineForDiag({
        apiHints: waterlineApis.map((e) => ({
          at: e.atMs,
          path: e.path || e.label,
          ok: e.ok,
          ms: e.durationMs ?? null,
          status: e.status ?? null,
          error: e.errorText || null,
        })),
        anomalies: listChatTurnAnomalies(),
      }),
    );
    return lines.join("\n");
  }

  const h = snapshot.history;
  const rs = snapshot.runStatus;
  const pageSeen = pageVisibleBitsFromRawRows(snapshot.windowRows || []);
  const pageSeenLine = [pageSeen.user, pageSeen.text, pageSeen.tool]
    .filter(Boolean)
    .join(" | ");
  const host = snapshot.layout?.hosts.find((x) => x.visibleAttr === "1");
  const eyeTurns = snapshot.turns;
  const overlapCount = eyeTurns.filter((t) => t.overlapsNext).length;
  const tight72 =
    host?.estimateStuck === true ||
    eyeTurns.filter(
      (t) => t.gapToNext != null && t.gapToNext >= 60 && t.gapToNext <= 84,
    ).length >= 2;
  const eyeVerdict = [
    overlapCount > 0 ? `!叠层×${overlapCount}` : "",
    host?.stacked ? "!STACK(多卡同Y)" : "",
    tight72 ? "!EST72(间距≈72估高)" : "",
    overlapCount === 0 && !host?.stacked && !tight72 ? "排列正常" : "",
  ]
    .filter(Boolean)
    .join(" · ");

  // —— 肉眼所见必须最先：Agent 先对屏幕再对投影 ——
  lines.push("");
  lines.push("### 肉眼所见（视口 DOM · 从上到下）");
  lines.push(`- 总判: ${eyeVerdict || "∅"}`);
  lines.push(
    `- 视口 turn=${eyeTurns.length} · scroll ${snapshot.scrollTop}/${snapshot.scrollHeight} · client=${snapshot.clientHeight}`,
  );
  if (eyeTurns.length === 0) {
    lines.push("- （视口无可见 turn 节点）");
  } else {
    const list =
      overlapCount > 0 || host?.stacked
        ? eyeTurns.slice(0, 10)
        : pickDiagnosticTurns(eyeTurns);
    for (let i = 0; i < list.length; i++) {
      const t = list[i]!;
      const flags = [
        t.overlapsNext ? "!叠下一卡" : "",
        t.spaceToNext != null && t.spaceToNext < 24 && t.spaceToNext >= -8
          ? "!贴太近"
          : "",
        t.orphanHeaderNoUser ? "!NO_USER" : "",
        t.emptyAssistantCompleted ? "!EMPTY_ASSISTANT" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const space =
        t.spaceToNext == null
          ? ""
          : ` space→下=${t.spaceToNext}${t.overlapsNext ? "(负=重叠)" : ""}`;
      lines.push(
        `- [#${t.dataIndex ?? "∅"}] y=${t.top}→${t.bottom} h=${t.height}${space}${flags ? ` ${flags}` : ""} tid=${t.turnId.slice(0, 10)}`,
      );
      lines.push(`  屏上字: ${clip(t.displayText, 220) || "（空）"}`);
    }
    if (list.length < eyeTurns.length) {
      lines.push(`- …另有 ${eyeTurns.length - list.length} 卡未展开（无叠层时只留异常/末轮）`);
    }
  }

  lines.push("");
  lines.push(
    ...formatChatTurnWaterlineForDiag({
      sessionKey: snapshot.sessionKey || null,
      apiHints: waterlineApis.map((e) => ({
        at: e.atMs,
        path: e.path || e.label,
        ok: e.ok,
        ms: e.durationMs ?? null,
        status: e.status ?? null,
        error: e.errorText || null,
      })),
      anomalies: listChatTurnAnomalies().filter(
        (a) =>
          !snapshot.sessionKey ||
          !a.sessionKey ||
          a.sessionKey === snapshot.sessionKey,
      ),
    }),
  );

  lines.push("");
  lines.push("### 会话 / 投影摘要");
  lines.push(
    `- ${snapshot.title || "∅"} · tid=${snapshot.tid} · sk=${snapshot.sessionKey || "∅"}`,
  );
  lines.push(`- 页面所见(段末): ${pageSeenLine || "（空）"}`);
  lines.push(
    `- ${formatConversationRecordCounts({
      windowCount: h.windowCount,
      totalCount: h.totalCount,
      windowTurnCount: h.windowTurnCount,
      windowUserCount: h.windowUserCount,
    })} · win=${h.windowFirstRowId ?? "∅"}…${h.windowLastRowId ?? "∅"} · hasOlder=${h.hasOlder ? 1 : 0} loading=${h.loadingOlder ? 1 : 0} wouldTrigger=${h.wouldTrigger ? 1 : 0}`,
  );
  lines.push(
    `- run ${rs.label} phase=${rs.turnPhase} wire=${rs.streamWireSource || "∅"} frames=${rs.v4FramesSseOpen ? "up" : "down"} settled=${rs.uiTurnSettled ? 1 : 0} exec=${rs.executing ? 1 : 0} why=${rs.execWhy || "∅"}`,
  );
  const activePolls = rs.polls.filter((p) => p.active);
  if (activePolls.length > 0) {
    lines.push(
      `- polls: ${activePolls.map((p) => `${p.owner}@${p.intervalSec}s`).join(", ")}`,
    );
  }
  const layoutBad =
    !!host?.estimateStuck ||
    !!host?.stacked ||
    (snapshot.layout?.stackedHostCount ?? 0) > 0 ||
    !!snapshot.layout?.composer?.drifted;
  if (host) {
    lines.push(
      `- layout turns=${host.turnCount} uniqueY=${host.uniqueTops} gap=${host.medianGap ?? "∅"} stuck=${host.estimateStuck ? 1 : 0} stacked=${host.stacked ? 1 : 0} hosts=${snapshot.layout?.stackedHostCount ?? 0} composerDrift=${snapshot.layout?.composer?.drifted ? 1 : 0}${layoutBad ? " ←" : ""}`,
    );
  }

  const virtProbe =
    virt ??
    collectVirtualizationProbe({
      tid: snapshot.tid,
      windowRows: snapshot.windowRows || [],
      windowCount: h.windowCount,
      totalCount: h.totalCount,
      winFirst: h.windowFirstRowId,
      winLast: h.windowLastRowId,
      hasOlder: h.hasOlder,
      loadingOlder: h.loadingOlder,
      wouldTrigger: h.wouldTrigger,
      streamEntries,
    });
  lines.push("");
  lines.push(...formatVirtualizationProbeForDiag(virtProbe));

  lines.push("");
  lines.push(`### 异常（${anomalies.length}）`);
  if (anomalies.length === 0) {
    lines.push("- （无）");
  } else {
    for (const a of anomalies) {
      const liveTag =
        "live" in a && typeof (a as { live?: boolean }).live === "boolean"
          ? (a as { live: boolean }).live
            ? "现"
            : "曾"
          : "";
      lines.push(
        `- [${a.severity}${liveTag ? `·${liveTag}` : ""}] ${a.code} · ${a.title} · ${a.detail}`,
      );
    }
  }

  const turns = pickDiagnosticTurns(snapshot.turns);
  lines.push("");
  lines.push(
    `### 投影对照（${turns.length}/${snapshot.turns.length}，异常优先）`,
  );
  if (turns.length === 0) {
    lines.push("- （视口无 turn）");
  } else {
    for (const t of turns) {
      const flags = [
        t.overlapsNext ? "!叠下一卡" : "",
        t.orphanHeaderNoUser ? "!NO_USER" : "",
        t.emptyAssistantCompleted ? "!EMPTY_ASSISTANT" : "",
      ]
        .filter(Boolean)
        .join(" ");
      lines.push(
        `- #${t.dataIndex ?? "∅"} ${t.turnId.slice(0, 12)} h=${t.height}${flags ? ` ${flags}` : ""}${t.headerState ? ` ${t.headerState}` : ""}`,
      );
      lines.push(`  DOM: ${clip(t.displayText, 160) || "（空）"}`);
      lines.push(`  ROW: ${summarizeTurnRows(t.rawRows)}`);
    }
  }

  const needStreamDetail = anomalies.some(
    (a) =>
      a.code === "STREAM_AHEAD_OF_WINDOW" ||
      a.code === "STREAM_LIVE_NO_DOM" ||
      a.code === "EMPTY_ASSISTANT",
  );
  const recentStream = streamEntries.slice(needStreamDetail ? -6 : -4);
  lines.push("");
  lines.push(`### 流式 headline（${recentStream.length}/${streamEntries.length}，无整段 JSON）`);
  if (recentStream.length === 0) {
    lines.push("- （无）");
  } else {
    for (const e of recentStream) {
      lines.push(
        `- #${e.id} ${e.kindLabel || "?"} ${e.summary || e.headline}`,
      );
    }
  }

  const jumps = scrollEntries.filter((e) => e.jump).slice(-8);
  const jumpTotal = scrollEntries.reduce((n, e) => n + (e.jump ? 1 : 0), 0);
  lines.push("");
  lines.push(`### 滚轮 !JUMP（${jumps.length} 条 / 总计 ${jumpTotal}）`);
  if (jumps.length === 0) {
    const last = scrollEntries.at(-1);
    if (last) {
      lines.push(
        `- 最近非跳: top=${Math.round(last.scrollTop)} h=${Math.round(last.scrollHeight)} src=${last.source} follow=${last.followingAttr ?? "∅"} winFirst=${last.windowFirstRowId ?? "∅"}`,
      );
    } else {
      lines.push("- （无）");
    }
  } else {
    for (const e of jumps) {
      lines.push(
        `- #${e.id} ${e.headline} · src=${e.source} follow=${e.followingAttr ?? "∅"} dH=${Math.round(e.dHeight)} winFirst=${e.windowFirstRowId ?? "∅"} shown=${e.windowCount}/${e.totalCount ?? "∅"}`,
      );
    }
  }

  const signalApis = apiEntries.filter(
    (e) => !e.ok || isSignalApiPath(e.path) || !isNoisyApiPath(e.path),
  );
  const recentApi = [
    ...signalApis.filter((e) => !e.ok),
    ...signalApis.filter((e) => e.ok && isSignalApiPath(e.path)),
  ]
    .filter((e, i, arr) => arr.findIndex((x) => x.id === e.id) === i)
    .slice(-6);
  lines.push("");
  lines.push(
    `### 接口（${recentApi.length} 条信号；已跳过 file_changes 等噪声）`,
  );
  if (recentApi.length === 0) {
    lines.push("- （无）");
  } else {
    for (const e of recentApi) {
      lines.push(
        `- #${e.id} ${e.method} ${e.label} ${e.status} ${e.durationMs}ms ${e.ok ? "ok" : "FAIL"} · ${e.path}`,
      );
      // 失败或 rows_range/subscribe：只留极短 body，够对 epoch/winFirst
      if (!e.ok || e.path.includes("rows_range") || e.path.includes("subscribe")) {
        const req = clip(e.requestText.replace(/\s+/g, " ").trim(), 160);
        const res = clip(e.responseText.replace(/\s+/g, " ").trim(), 200);
        if (req) lines.push(`  req: ${req}`);
        if (res) lines.push(`  res: ${res}`);
      }
    }
  }

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

function readToolDisplayMeta(row: ConversationRow): {
  displayKind: string | undefined;
  hasMedia: boolean;
} {
  if (row.kind !== "toolCall") return { displayKind: undefined, hasMedia: false };
  const display =
    (row as { display?: { kind?: string; media?: unknown } }).display ??
    (row as { output?: { display?: { kind?: string; media?: unknown } } }).output
      ?.display;
  const displayKind =
    display && typeof display.kind === "string" ? display.kind : undefined;
  const hasMedia = Array.isArray(display?.media) && display!.media!.length > 0;
  return { displayKind, hasMedia };
}

function collectAnomalyWindowRows(tid: string): NonNullable<
  Parameters<typeof collectViewportAnomalies>[0]["windowRows"]
> {
  if (!tid) return [];
  try {
    const snap = getSharedV4SessionDataLayer()
      .peekStore(tid)
      ?.getState()?.snapshot;
    const windowRows = snap?.rows?.window ?? [];
    return windowRows.map((row) => {
      const meta = readToolDisplayMeta(row);
      return {
        rowId: row.rowId,
        kind: String(row.kind || ""),
        origin:
          typeof (row as { origin?: unknown }).origin === "string"
            ? String((row as { origin: string }).origin)
            : undefined,
        turnId: String(row.turnId || ""),
        text:
          typeof (row as { text?: unknown }).text === "string"
            ? String((row as { text: string }).text)
            : undefined,
        state:
          typeof (row as { state?: unknown }).state === "string"
            ? String((row as { state: string }).state)
            : undefined,
        status:
          typeof (row as { status?: unknown }).status === "string"
            ? String((row as { status: string }).status)
            : undefined,
        displayKind: meta.displayKind,
        hasMedia: meta.hasMedia,
      };
    });
  } catch {
    return [];
  }
}

function buildViewportAnomalies(input: {
  snapshot: OverlaySnapshot | null;
  streamEntries: ViewportStreamTapEntry[];
  apiEntries: ViewportApiTapEntry[];
  scrollEntries: ViewportScrollTapEntry[];
}): ViewportAnomaly[] {
  const snap = input.snapshot;
  if (!snap) return [];
  const host = snap.layout?.hosts.find((h) => h.visibleAttr === "1");
  return collectViewportAnomalies({
    tid: snap.tid,
    scrollTop: snap.scrollTop,
    scrollHeight: snap.scrollHeight,
    clientHeight: snap.clientHeight,
    executing: snap.runStatus.executing,
    uiTurnSettled: snap.runStatus.uiTurnSettled,
    history: {
      hasOlder: snap.history.hasOlder,
      loadingOlder: snap.history.loadingOlder,
      wouldTrigger: snap.history.wouldTrigger,
      firstRowId: snap.history.firstRowId,
      windowFirstRowId: snap.history.windowFirstRowId,
      windowLastRowId: snap.history.windowLastRowId,
      windowCount: snap.history.windowCount,
      totalCount: snap.history.totalCount,
    },
    turns: snap.turns,
    layout: host
      ? {
          estimateStuck: !!host.estimateStuck,
          stackedHostCount: snap.layout?.stackedHostCount ?? 0,
          composerDrifted: !!snap.layout?.composer?.drifted,
        }
      : snap.layout
        ? {
            estimateStuck: false,
            stackedHostCount: snap.layout.stackedHostCount,
            composerDrifted: !!snap.layout.composer?.drifted,
          }
        : null,
    windowRows: collectAnomalyWindowRows(snap.tid),
    streamEntries: input.streamEntries.map((e) => ({
      atMs: e.atMs,
      channel: e.channel,
      sessionId: e.sessionId,
      kindLabel: e.kindLabel,
      summary: e.summary,
      headline: e.headline,
      jsonText: e.jsonText,
    })),
    apiEntries: input.apiEntries.map((e) => ({
      atMs: e.atMs,
      path: e.path,
      ok: e.ok,
      sessionId: e.sessionId,
      requestText: e.requestText,
      responseText: e.responseText,
    })),
    scrollEntries: input.scrollEntries.map((e) => ({
      atMs: e.atMs,
      jump: e.jump,
      source: e.source,
      followingAttr: e.followingAttr,
    })),
  });
}

function problemBadge(anomalies: readonly ViewportAnomaly[]): string {
  return formatAnomalyBadge(anomalies);
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
    () => listViewportStreamTapEntries({ limit: 200 }),
  );
  const [apiEntries, setApiEntries] = useState<ViewportApiTapEntry[]>(() =>
    listViewportApiTapEntries({ limit: 200 }),
  );
  const [scrollEntries, setScrollEntries] = useState<ViewportScrollTapEntry[]>(
    () => listViewportScrollTapEntries({ limit: 200 }),
  );
  const [timingRows, setTimingRows] = useState<ChatTurnTimingRow[]>(() =>
    listChatTurnTimingRows({ limit: 40 }),
  );
  const [pageSnaps, setPageSnaps] = useState<ViewportPageSnapEntry[]>(() =>
    listViewportPageSnapEntries({ limit: 120 }),
  );
  const [expandedPageSnapId, setExpandedPageSnapId] = useState<number | null>(
    null,
  );
  const [scrollJumpsOnly, setScrollJumpsOnly] = useState(false);
  const pageSnapScrollRef = useRef<HTMLDivElement | null>(null);
  const pageSnapFollowBottomRef = useRef(true);
  const [copyHint, setCopyHint] = useState<string | null>(null);
  /** error/warn 锁定：避免 700ms 刷新 + 时间窗证据滑出后标题栏闪灭 */
  const [stickyAnomalies, setStickyAnomalies] = useState<StickyViewportAnomaly[]>(
    [],
  );
  const stickyTidRef = useRef<string | null>(null);
  const [size, setSize] = useState<OverlaySize>(readOverlaySize);
  const [pos, setPos] = useState(() => defaultOverlayPos(readOverlaySize()));
  const panelRef = useRef<HTMLDivElement | null>(null);
  const streamScrollRef = useRef<HTMLDivElement | null>(null);
  const streamFollowBottomRef = useRef(true);
  const apiScrollRef = useRef<HTMLDivElement | null>(null);
  const apiFollowBottomRef = useRef(true);
  const scrollTrailRef = useRef<HTMLDivElement | null>(null);
  const scrollFollowBottomRef = useRef(true);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    originLeft: number;
    originTop: number;
  } | null>(null);
  const resizeRef = useRef<{
    startX: number;
    startY: number;
    originW: number;
    originH: number;
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

  const refreshPageSnaps = useCallback(() => {
    setPageSnaps(
      listViewportPageSnapEntries({
        sessionId: snapshot?.tid ?? null,
        limit: 120,
      }),
    );
  }, [snapshot?.tid]);

  const samplePageSnap = useCallback(
    (
      snap: OverlaySnapshot,
      opts?: { force?: boolean },
    ) => {
      const windowRows = snap.windowRows?.length
        ? snap.windowRows
        : [];
      // 无投影窗时退回视口可见 turn（仍按内容签名，不变不记）
      const turns =
        windowRows.length > 0
          ? turnsFromWindowRows(windowRows)
          : snap.turns.map((t) => ({
              turnId: t.turnId,
              dataIndex: t.dataIndex,
              rawRows: t.rawRows,
              orphanHeaderNoUser: t.orphanHeaderNoUser,
              emptyAssistantCompleted: t.emptyAssistantCompleted,
            }));
      pushViewportPageSnap({
        sessionId: snap.tid,
        runLabel: snap.runStatus.label,
        scrollTop: snap.scrollTop,
        scrollHeight: snap.scrollHeight,
        turns,
        force: opts?.force === true,
      });
    },
    [],
  );

  const refresh = useCallback(
    (opts?: { forcePageSnap?: boolean }) => {
      const snap = collectOverlaySnapshot();
      setSnapshot(snap);
      if (snap?.tid) {
        samplePageSnap(snap, { force: opts?.forcePageSnap === true });
      }
    },
    [samplePageSnap],
  );

  const refreshStream = useCallback(() => {
    setStreamEntries(
      listViewportStreamTapEntries({
        sessionKey: snapshot?.sessionKey ?? null,
        sessionId: snapshot?.tid ?? null,
        limit: 200,
      }),
    );
  }, [snapshot?.sessionKey, snapshot?.tid]);

  const refreshApi = useCallback(() => {
    setApiEntries(
      listViewportApiTapEntries({
        family: apiFamily,
        sessionId: snapshot?.tid ?? null,
        limit: 200,
      }),
    );
  }, [apiFamily, snapshot?.tid]);

  const refreshScroll = useCallback(() => {
    setScrollEntries(
      listViewportScrollTapEntries({
        limit: 200,
        jumpsOnly: scrollJumpsOnly,
      }),
    );
  }, [scrollJumpsOnly]);

  const refreshTiming = useCallback(() => {
    setTimingRows(
      listChatTurnTimingRows({
        sessionKey: snapshot?.sessionKey ?? null,
        limit: 40,
      }),
    );
  }, [snapshot?.sessionKey]);

  const active = obsEnabled && prefOn;

  useEffect(() => {
    if (!active) {
      setSnapshot(null);
      detachViewportScrollTap();
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
    attachViewportScrollTap(sc);
    sc?.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const timer = window.setInterval(schedule, 700);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      sc?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.clearInterval(timer);
      detachViewportScrollTap();
    };
  }, [active, refresh, snapshot?.tid]);

  // 投影窗 / loadOlder 状态喂给滚轮轨迹，到顶行才能写清「还能自动拉吗」。
  useEffect(() => {
    if (!active || !snapshot) return;
    const h = snapshot.history;
    setViewportScrollTapSessionId(snapshot.tid);
    setViewportScrollHistoryContext({
      hasOlder: h.hasOlder,
      loadingOlder: h.loadingOlder,
      firstRowId: h.firstRowId,
      windowFirstRowId: h.windowFirstRowId,
      totalCount: h.totalCount,
      windowCount: h.windowCount,
      windowUserCount: h.windowUserCount,
      windowTurnCount: h.windowTurnCount,
    });
  }, [active, snapshot]);

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

  useEffect(() => {
    if (!active) return;
    refreshScroll();
    let raf = 0;
    const unsub = subscribeViewportScrollTap(() => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        refreshScroll();
      });
    });
    return () => {
      unsub();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [active, refreshScroll]);

  useEffect(() => {
    if (!active) return;
    refreshTiming();
    return subscribeChatTurnTiming(() => {
      refreshTiming();
    });
  }, [active, refreshTiming]);

  useEffect(() => {
    if (!active) return;
    refreshPageSnaps();
    return subscribeViewportPageSnap(() => {
      refreshPageSnaps();
    });
  }, [active, refreshPageSnaps]);

  const selectTab = useCallback((next: OverlayTab) => {
    setTab(next);
    writeOverlayTab(next);
    if (next === "stream") {
      streamFollowBottomRef.current = true;
    }
    if (next === "api") {
      apiFollowBottomRef.current = true;
    }
    if (next === "scroll") {
      scrollFollowBottomRef.current = true;
    }
    if (next === "page") {
      pageSnapFollowBottomRef.current = true;
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

  // 滚轮轨迹：默认贴最新；上滚查阅历史样本。
  useLayoutEffect(() => {
    if (!active || tab !== "scroll" || !scrollFollowBottomRef.current) return;
    const el = scrollTrailRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [active, tab, scrollEntries]);

  // 画面快照：贴底跟新帧。
  useLayoutEffect(() => {
    if (!active || tab !== "page" || !pageSnapFollowBottomRef.current) return;
    const el = pageSnapScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [active, tab, pageSnaps]);

  const clampToViewport = useCallback(
    (left: number, top: number, w = size.width, h = size.height) =>
      clampOverlayPos(left, top, w, h),
    [size.height, size.width],
  );

  useEffect(() => {
    if (!active) return;
    const onWinResize = () => {
      setSize((prev) => {
        const next = clampOverlaySize(prev.width, prev.height);
        if (next.width !== prev.width || next.height !== prev.height) {
          writeOverlaySize(next);
        }
        return next;
      });
      setPos((prev) => clampToViewport(prev.left, prev.top));
    };
    window.addEventListener("resize", onWinResize);
    onWinResize();
    return () => window.removeEventListener("resize", onWinResize);
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

  const onPointerDownResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    resizeRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originW: size.width,
      originH: size.height,
      originLeft: pos.left,
      originTop: pos.top,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMoveResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = resizeRef.current;
    if (!r) return;
    const next = clampOverlaySize(
      r.originW + (e.clientX - r.startX),
      r.originH + (e.clientY - r.startY),
    );
    setSize(next);
    setPos(clampToViewport(r.originLeft, r.originTop, next.width, next.height));
  };
  const onPointerUpResize = () => {
    const r = resizeRef.current;
    resizeRef.current = null;
    if (!r) return;
    // 松手时再落一次当前尺寸（避免闭包读到拖拽前的旧 size）
    setSize((cur) => {
      writeOverlaySize(cur);
      return cur;
    });
  };

  const resetPos = () => {
    const next = defaultOverlaySize();
    setSize(next);
    writeOverlaySize(next);
    setPos(defaultOverlayPos(next));
  };

  const liveAnomalies = useMemo(
    () =>
      buildViewportAnomalies({
        snapshot,
        streamEntries,
        apiEntries,
        scrollEntries,
      }),
    [snapshot, streamEntries, apiEntries, scrollEntries],
  );

  const virtProbe = useMemo((): VirtualizationProbe | null => {
    if (!snapshot) return null;
    let following = true;
    try {
      following =
        document
          .querySelector('[data-v4-chat-host-visible="1"] [data-following]')
          ?.getAttribute("data-following") !== "false";
    } catch {
      following = true;
    }
    const h = snapshot.history;
    return collectVirtualizationProbe({
      tid: snapshot.tid,
      windowRows: snapshot.windowRows || [],
      windowCount: h.windowCount,
      totalCount: h.totalCount,
      winFirst: h.windowFirstRowId,
      winLast: h.windowLastRowId,
      hasOlder: h.hasOlder,
      loadingOlder: h.loadingOlder,
      wouldTrigger: h.wouldTrigger,
      following,
      streamEntries,
    });
  }, [snapshot, streamEntries]);
  useEffect(() => {
    const tid = snapshot?.tid ?? "";
    if (!tid) {
      stickyTidRef.current = null;
      setStickyAnomalies([]);
      return;
    }
    setStickyAnomalies((prev) => {
      const merged = mergeStickyViewportAnomalies({
        tid,
        prevTid: stickyTidRef.current,
        prev,
        live: liveAnomalies,
        windowFirstRowId: snapshot?.history?.windowFirstRowId ?? null,
      });
      stickyTidRef.current = merged.tid;
      const next = merged.items;
      const same =
        next.length === prev.length &&
        next.every((a, i) => {
          const b = prev[i];
          return (
            !!b &&
            a.code === b.code &&
            a.live === b.live &&
            a.detail === b.detail &&
            a.title === b.title &&
            a.severity === b.severity
          );
        });
      return same ? prev : next;
    });
  }, [liveAnomalies, snapshot?.tid, snapshot?.history?.windowFirstRowId]);
  // 展示 / 标题栏：优先锁定表（含「曾现」），不再跟 700ms 时间窗闪灭
  const anomalies = stickyAnomalies;
  const problems = useMemo(() => problemBadge(anomalies), [anomalies]);
  const visibleHost = snapshot?.layout?.hosts.find((h) => h.visibleAttr === "1");
  const clearStickyAnomalies = useCallback(() => {
    stickyTidRef.current = snapshot?.tid ?? null;
    setStickyAnomalies(
      liveAnomalies
        .filter((a) => a.severity === "info")
        .map((a) => ({
          ...a,
          firstSeenAt: Date.now(),
          lastSeenAt: Date.now(),
          live: true,
        })),
    );
  }, [liveAnomalies, snapshot?.tid]);

  const flashCopyHint = useCallback((ok: boolean, label: string) => {
    setCopyHint(ok ? label : "复制失败");
    window.setTimeout(() => setCopyHint(null), 1600);
  }, []);

  const copyDiagnostic = useCallback(async () => {
    // 复制前先刷一帧，避免贴出去的是过期快照。
    const fresh = collectOverlaySnapshot();
    if (fresh) setSnapshot(fresh);
    const streamForCopy = listViewportStreamTapEntries({
      sessionKey: (fresh ?? snapshot)?.sessionKey ?? null,
      sessionId: (fresh ?? snapshot)?.tid ?? null,
      limit: 16,
    });
    const scrollForCopy = listViewportScrollTapEntries({ limit: 32 });
    const apiForCopy = listViewportApiTapEntries({
      family: apiFamily,
      sessionId: (fresh ?? snapshot)?.tid ?? null,
      limit: 24,
    });
    // 水位线要对账 subscribe/chatSend：不受当前接口 tab 过滤，多拿一批
    const apiForWaterline = listViewportApiTapEntries({
      family: "all",
      sessionId: (fresh ?? snapshot)?.tid ?? null,
      includeForeign: true,
      limit: 48,
    });
    const liveForCopy = buildViewportAnomalies({
      snapshot: fresh ?? snapshot,
      streamEntries: streamForCopy,
      apiEntries: apiForCopy,
      scrollEntries: scrollForCopy,
    });
    const snapForCopy = fresh ?? snapshot;
    const stickyForCopy = mergeStickyViewportAnomalies({
      tid: snapForCopy?.tid ?? "",
      prevTid: stickyTidRef.current,
      prev: stickyAnomalies,
      live: liveForCopy,
      windowFirstRowId: snapForCopy?.history?.windowFirstRowId ?? null,
    }).items;
    let following = true;
    try {
      following =
        document
          .querySelector('[data-v4-chat-host-visible="1"] [data-following]')
          ?.getAttribute("data-following") !== "false";
    } catch {
      following = true;
    }
    const virtForCopy = snapForCopy
      ? collectVirtualizationProbe({
          tid: snapForCopy.tid,
          windowRows: snapForCopy.windowRows || [],
          windowCount: snapForCopy.history.windowCount,
          totalCount: snapForCopy.history.totalCount,
          winFirst: snapForCopy.history.windowFirstRowId,
          winLast: snapForCopy.history.windowLastRowId,
          hasOlder: snapForCopy.history.hasOlder,
          loadingOlder: snapForCopy.history.loadingOlder,
          wouldTrigger: snapForCopy.history.wouldTrigger,
          following,
          streamEntries: streamForCopy,
        })
      : null;
    const text = buildOverlayDiagnosticText({
      tab,
      snapshot: snapForCopy,
      streamEntries: streamForCopy,
      scrollEntries: scrollForCopy,
      apiEntries: apiForCopy,
      waterlineApiEntries: apiForWaterline,
      anomalies: stickyForCopy,
      problems: problemBadge(stickyForCopy),
      virt: virtForCopy,
    });
    const ok = await copyTextToClipboard(text);
    flashCopyHint(ok, "已复制诊断");
  }, [snapshot, tab, apiFamily, flashCopyHint, stickyAnomalies]);

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
        width: size.width,
        height: minimized ? "auto" : size.height,
        maxHeight: minimized ? undefined : size.height,
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
            title="复现叠字/错位后点：复制「肉眼所见」DOM 文案+坐标+叠层标记，再贴给 Agent"
          >
            {copyHint || "复制诊断"}
          </button>
          <button
            type="button"
            style={btnStyle}
            onClick={() => refresh({ forcePageSnap: true })}
            title="立即刷新（画面无变化也会补记一帧）"
          >
            刷新
          </button>
          <button
            type="button"
            style={btnStyle}
            onClick={resetPos}
            title="位置+尺寸复位：右下角大窗"
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
                    [
                      "anomaly",
                      anomalies.length
                        ? `异常(${anomalies.length})`
                        : "异常",
                    ],
                    ["page", `画面(${pageSnaps.length})`],
                    ["stream", `流式(${streamEntries.length})`],
                    ["timing", `计时(${timingRows.length})`],
                    [
                      "scroll",
                      `滚轮(${scrollEntries.length}${countViewportScrollJumps() ? `!${countViewportScrollJumps()}` : ""})`,
                    ],
                    ["api", `接口(${apiEntries.length})`],
                    [
                      "viewport",
                      `视口(${
                        snapshot.windowRows?.filter(
                          (r) => String(r.kind) !== "turnHeader",
                        ).length || snapshot.turns.length
                      })`,
                    ],
                    [
                      "virt",
                      virtProbe?.flags.length
                        ? `虚拟化(!${virtProbe.flags.length})`
                        : "虚拟化",
                    ],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    style={{
                      ...tabBtnBase,
                      background:
                        tab === id ? "rgba(51,65,85,0.95)" : "transparent",
                      color:
                        tab === id
                          ? "#f8fafc"
                          : id === "anomaly" && anomalies.length > 0
                            ? "#fbbf24"
                            : id === "virt" && (virtProbe?.flags.length ?? 0) > 0
                              ? "#fbbf24"
                              : "#94a3b8",
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
                    <div
                      style={{
                        marginBottom: 8,
                        padding: "6px 8px",
                        borderRadius: 6,
                        background:
                          anomalies.length > 0
                            ? "rgba(127,29,29,0.28)"
                            : "rgba(22,101,52,0.22)",
                        color: anomalies.length > 0 ? "#fecaca" : "#86efac",
                      }}
                    >
                      异常表{" "}
                      <b>
                        {anomalies.length > 0
                          ? `${anomalies.length} 条 · ${anomalies
                              .slice(0, 3)
                              .map((a) => a.code)
                              .join(" / ")}${
                              anomalies.length > 3
                                ? ` +${anomalies.length - 3}`
                                : ""
                            }`
                          : "0 · OK"}
                      </b>
                      {anomalies.length > 0 ? (
                        <button
                          type="button"
                          style={{
                            ...btnStyle,
                            marginLeft: 8,
                            borderColor: "rgba(251,191,36,0.45)",
                            color: "#fbbf24",
                          }}
                          onClick={() => selectTab("anomaly")}
                        >
                          打开异常
                        </button>
                      ) : null}
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
                              ...tapLineStyle,
                            }}
                          >
                            轮询 {p.active ? "●" : "○"} 每{p.intervalSec}s ·{" "}
                            {p.owner}
                            {"\n"}
                            target={p.target}
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
                        {formatConversationRecordCounts({
                          windowCount: snapshot.history.windowCount,
                          totalCount: snapshot.history.totalCount,
                          windowTurnCount: snapshot.history.windowTurnCount,
                          windowUserCount: snapshot.history.windowUserCount,
                        })}
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
                        规则：未跟底且 scrollTop ≤ max(64, 2×视口高) 才自动
                        loadOlder；跟底中绝不预取（防短尾窗死循环）
                      </div>
                    </div>
                  </div>
                ) : null}

                {tab === "page" ? (
                  <div
                    style={{
                      flex: 1,
                      minHeight: 0,
                      display: "flex",
                      flexDirection: "column",
                      border: "1px solid rgba(52,211,153,0.4)",
                      borderRadius: 8,
                      overflow: "hidden",
                      background: "rgba(6, 78, 59, 0.22)",
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
                        background: "rgba(6, 95, 70, 0.5)",
                        color: "#a7f3d0",
                        fontSize: 11,
                      }}
                    >
                      <span>
                        仅内容变化记一帧（尾部用户/正文/思考/工具）· 不变不刷 ·
                        点开看明细
                      </span>
                      <span
                        style={{ marginLeft: "auto", display: "flex", gap: 4 }}
                      >
                        <button
                          type="button"
                          style={btnStyle}
                          title="滚到最新"
                          onClick={() => {
                            pageSnapFollowBottomRef.current = true;
                            const el = pageSnapScrollRef.current;
                            if (el) el.scrollTop = el.scrollHeight;
                          }}
                        >
                          最新
                        </button>
                        <button
                          type="button"
                          style={btnStyle}
                          title="清空画面快照"
                          onClick={() => clearViewportPageSnap()}
                        >
                          清空
                        </button>
                      </span>
                    </div>
                    <div
                      ref={pageSnapScrollRef}
                      onScroll={(e) => {
                        const el = e.currentTarget;
                        const dist =
                          el.scrollHeight - el.scrollTop - el.clientHeight;
                        pageSnapFollowBottomRef.current = dist < 56;
                      }}
                      style={{
                        ...mono,
                        flex: 1,
                        minHeight: 120,
                        overflow: "auto",
                        padding: "4px 6px 8px",
                        fontSize: 12,
                        color: "#d1fae5",
                        lineHeight: 1.35,
                      }}
                    >
                      {pageSnaps.length === 0 ? (
                        <div style={{ color: "#6ee7b7", padding: 8 }}>
                          尚无画面帧。用户发送 / 正文 / 工具变化时才会记；点顶栏「刷新」可强制补一帧。
                        </div>
                      ) : (
                        pageSnaps.map((entry, idx) => {
                          const newest = idx >= pageSnaps.length - 2;
                          const open = expandedPageSnapId === entry.id;
                          const d = new Date(entry.atMs);
                          const time = `${d.toLocaleTimeString("zh-CN", {
                            hour12: false,
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}.${String(entry.atMs % 1000).padStart(3, "0")}`;
                          return (
                            <div
                              key={entry.id}
                              style={{
                                marginBottom: open ? 6 : 1,
                                padding: open ? "4px 6px 6px" : "1px 4px",
                                borderRadius: 4,
                                border: newest
                                  ? "1px solid rgba(110,231,183,0.5)"
                                  : "1px solid transparent",
                                background: newest
                                  ? "rgba(6, 95, 70, 0.35)"
                                  : "transparent",
                              }}
                            >
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedPageSnapId((cur) =>
                                    cur === entry.id ? null : entry.id,
                                  )
                                }
                                style={{
                                  all: "unset",
                                  cursor: "pointer",
                                  display: "flex",
                                  alignItems: "baseline",
                                  gap: 8,
                                  width: "100%",
                                  boxSizing: "border-box",
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  color: "#ecfdf5",
                                }}
                                title={entry.headline}
                              >
                                <span style={{ color: "#6ee7b7", flexShrink: 0 }}>
                                  {open ? "▼" : "▶"}
                                </span>
                                <span
                                  style={{
                                    color: "#f8fafc",
                                    fontWeight: 700,
                                    flexShrink: 0,
                                  }}
                                >
                                  #{entry.id}
                                </span>
                                <span
                                  style={{ color: "#94a3b8", flexShrink: 0 }}
                                >
                                  {time}
                                </span>
                                <span
                                  style={{
                                    minWidth: 0,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                  }}
                                >
                                  {entry.headline}
                                </span>
                              </button>
                              {open ? (
                                <pre style={{ ...tapJsonPreStyle, marginTop: 6 }}>
                                  {entry.detailText}
                                </pre>
                              ) : null}
                            </div>
                          );
                        })
                      )}
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
                      <span>
                        最新在底 · 序号+时间+类型+摘要 · 点开才看 JSON
                      </span>
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
                        fontSize: 12,
                        color: "#ede9fe",
                        lineHeight: 1.35,
                      }}
                    >
                      {streamEntries.length === 0 ? (
                        <div style={{ color: "#a78bfa", padding: 8 }}>
                          尚无流式帧。发消息后这里贴底显示最新 AG-UI / V4 摘要。
                        </div>
                      ) : (
                        streamEntries.map((entry, idx) => {
                          const newest = idx >= streamEntries.length - 2;
                          // 默认一行摘要；点开才展开 JSON
                          const open = expandedStreamId === entry.id;
                          const d = new Date(entry.atMs);
                          const time = `${d.toLocaleTimeString("zh-CN", {
                            hour12: false,
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}.${String(entry.atMs % 1000).padStart(3, "0")}`;
                          const kind = entry.kindLabel || "其它";
                          const kindColor =
                            kind === "用户"
                              ? "#86efac"
                              : kind === "正文"
                                ? "#93c5fd"
                                : kind === "思考"
                                  ? "#c4b5fd"
                                  : kind === "工具"
                                    ? "#fcd34d"
                                    : kind === "开跑" || kind === "收尾"
                                      ? "#67e8f9"
                                      : "#e2e8f0";
                          return (
                            <div
                              key={entry.id}
                              style={{
                                marginBottom: open ? 6 : 1,
                                padding: open ? "4px 6px 6px" : "1px 4px",
                                borderRadius: 4,
                                border: newest
                                  ? "1px solid rgba(196,181,253,0.45)"
                                  : "1px solid transparent",
                                background: newest
                                  ? "rgba(91, 33, 182, 0.22)"
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
                                  display: "flex",
                                  alignItems: "baseline",
                                  gap: 8,
                                  width: "100%",
                                  boxSizing: "border-box",
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  color: newest ? "#f5f3ff" : "#ddd6fe",
                                }}
                                title={`${kind} ${entry.summary || entry.headline}`}
                              >
                                <span style={{ color: "#a78bfa", flexShrink: 0 }}>
                                  {open ? "▼" : "▶"}
                                </span>
                                <span
                                  style={{
                                    color: "#f8fafc",
                                    fontWeight: 700,
                                    flexShrink: 0,
                                  }}
                                >
                                  #{entry.id}
                                </span>
                                <span
                                  style={{
                                    color: "#94a3b8",
                                    flexShrink: 0,
                                  }}
                                >
                                  {time}
                                </span>
                                <span
                                  style={{
                                    color: kindColor,
                                    fontWeight: 700,
                                    flexShrink: 0,
                                  }}
                                >
                                  {kind}
                                </span>
                                <span
                                  style={{
                                    minWidth: 0,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    color: newest ? "#faf5ff" : "#e9d5ff",
                                  }}
                                >
                                  {entry.summary || entry.headline}
                                </span>
                              </button>
                              {open ? (
                                <div style={{ marginTop: 6 }}>
                                  <div
                                    style={{
                                      color: "#a78bfa",
                                      fontSize: 11,
                                      marginBottom: 2,
                                    }}
                                  >
                                    JSON · {entry.channel}/{entry.type}
                                  </div>
                                  <pre style={tapJsonPreStyle}>
                                    {entry.jsonText}
                                  </pre>
                                </div>
                              ) : null}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                ) : null}

                {tab === "timing" ? (
                  <div
                    style={{
                      flex: 1,
                      minHeight: 0,
                      display: "flex",
                      flexDirection: "column",
                      border: "1px solid rgba(56,189,248,0.4)",
                      borderRadius: 8,
                      overflow: "hidden",
                      background: "rgba(8, 47, 73, 0.28)",
                    }}
                  >
                    <div
                      style={{
                        ...mono,
                        flexShrink: 0,
                        padding: "6px 10px",
                        background: "rgba(7, 89, 133, 0.55)",
                        color: "#bae6fd",
                        fontSize: 11,
                      }}
                    >
                      发送水位线：出泡(上屏)→上线→首字→结束 · 正常收紧 ·
                      异常留证 · viewport-timing.log
                    </div>
                    <div
                      style={{
                        ...mono,
                        flex: 1,
                        minHeight: 0,
                        overflow: "auto",
                        padding: "4px 6px 8px",
                        fontSize: 11,
                        color: "#e0f2fe",
                      }}
                    >
                      {timingRows.length === 0 ? (
                        <div style={{ color: "#7dd3fc", padding: 8 }}>
                          尚无回合计时。点发送后这里会出现一行：发送时刻、出泡上屏、上线、首字、判定。
                        </div>
                      ) : (
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns:
                              "56px 72px 1fr 48px 48px 48px 48px 1fr",
                            gap: "4px 8px",
                            alignItems: "start",
                            padding: "4px 4px 0",
                          }}
                        >
                          {(
                            [
                              "发送",
                              "判定",
                              "内容",
                              "出泡",
                              "上线",
                              "首字",
                              "结束",
                              "首包预览",
                            ] as const
                          ).map((h) => (
                            <div
                              key={h}
                              style={{
                                color: "#7dd3fc",
                                fontSize: 10,
                                borderBottom:
                                  "1px solid rgba(125,211,252,0.35)",
                                paddingBottom: 4,
                                position: "sticky",
                                top: 0,
                                background: "rgba(8,47,73,0.95)",
                              }}
                            >
                              {h}
                            </div>
                          ))}
                          {[...timingRows].reverse().map((row) => {
                            const send = new Date(
                              row.sendAt,
                            ).toLocaleTimeString("zh-CN", {
                              hour12: false,
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                            });
                            const ms = (at: number | null) =>
                              at == null
                                ? "—"
                                : `${Math.max(0, at - row.sendAt)}ms`;
                            const verdict = classifyChatTurnTimingVerdict(row);
                            const verdictColor =
                              verdict.level === "ok"
                                ? "#86efac"
                                : verdict.level === "pending"
                                  ? "#7dd3fc"
                                  : verdict.level === "warn"
                                    ? "#fbbf24"
                                    : "#fca5a5";
                            const firstLabel =
                              row.firstKind === "text"
                                ? "正文"
                                : row.firstKind === "reasoning"
                                  ? "思考"
                                  : row.firstKind === "tool"
                                    ? "工具"
                                    : row.firstKind || "—";
                            return (
                              <div key={row.id} style={{ display: "contents" }}>
                                <div style={tapLineStyle}>{send}</div>
                                <div
                                  style={{
                                    color: verdictColor,
                                    fontWeight: 600,
                                  }}
                                  title={verdict.zh}
                                >
                                  {verdict.zh}
                                </div>
                                <div style={tapLineStyle}>
                                  {row.textPreview || "（空）"}
                                </div>
                                <div
                                  style={{
                                    color:
                                      row.userBubbleAt != null
                                        ? "#86efac"
                                        : "#fbbf24",
                                  }}
                                >
                                  {ms(row.userBubbleAt)}
                                </div>
                                <div>{ms(row.wireAt)}</div>
                                <div
                                  style={{
                                    color:
                                      row.firstResponseAt != null &&
                                      row.firstResponseAt - row.sendAt >= 3000
                                        ? "#fbbf24"
                                        : "#e0f2fe",
                                  }}
                                  title={firstLabel}
                                >
                                  {ms(row.firstResponseAt)}
                                </div>
                                <div>{ms(row.streamEndAt)}</div>
                                <div style={tapLineStyle}>
                                  {row.firstResponseAt != null
                                    ? `${firstLabel} ${row.firstPreview || ""}`
                                    : "等待首字"}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}

                {tab === "scroll" ? (
                  <div
                    style={{
                      flex: 1,
                      minHeight: 0,
                      display: "flex",
                      flexDirection: "column",
                      border: "1px solid rgba(251,191,36,0.4)",
                      borderRadius: 8,
                      overflow: "hidden",
                      background: "rgba(120, 53, 15, 0.22)",
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
                        background: "rgba(146, 64, 14, 0.5)",
                        color: "#fde68a",
                        fontSize: 11,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          flexWrap: "wrap",
                        }}
                      >
                        <span>
                          轨迹贴底 · !JUMP=猛跳 · 到顶写清能否自动拉历史
                        </span>
                        <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                          <button
                            type="button"
                            style={{
                              ...btnStyle,
                              borderColor: scrollJumpsOnly
                                ? "rgba(251,191,36,0.7)"
                                : undefined,
                              color: scrollJumpsOnly ? "#fbbf24" : undefined,
                            }}
                            title="只看猛跳样本"
                            onClick={() => setScrollJumpsOnly((v) => !v)}
                          >
                            {scrollJumpsOnly ? "仅JUMP✓" : "仅JUMP"}
                          </button>
                          <button
                            type="button"
                            style={btnStyle}
                            title="滚到最新并恢复跟新"
                            onClick={() => {
                              scrollFollowBottomRef.current = true;
                              const el = scrollTrailRef.current;
                              if (el) el.scrollTop = el.scrollHeight;
                            }}
                          >
                            最新
                          </button>
                          <button
                            type="button"
                            style={btnStyle}
                            title="清空滚轮轨迹"
                            onClick={() => clearViewportScrollTap()}
                          >
                            清空
                          </button>
                        </span>
                      </div>
                      <div
                        style={{
                          marginTop: 4,
                          padding: "6px 8px",
                          borderRadius: 6,
                          background: "rgba(154, 52, 18, 0.45)",
                          border: "1px solid rgba(251, 146, 60, 0.55)",
                          color: "#fff7ed",
                          fontSize: 12,
                          fontWeight: 700,
                          lineHeight: 1.4,
                        }}
                        title="已显示=客户端投影窗行数；全量=服务端会话全序行数。hasOlder=0 且已显示少于全量时，说明尾窗被软顶裁过，不是「历史本来就这么少」。"
                      >
                        对话记录 ·{" "}
                        {formatConversationRecordCounts({
                          windowCount: snapshot.history.windowCount,
                          totalCount: snapshot.history.totalCount,
                          windowTurnCount: snapshot.history.windowTurnCount,
                          windowUserCount: snapshot.history.windowUserCount,
                        })}
                        {typeof snapshot.history.totalCount === "number" &&
                        snapshot.history.windowCount < snapshot.history.totalCount &&
                        !snapshot.history.hasOlder ? (
                          <span style={{ color: "#fecaca", fontWeight: 600 }}>
                            {" · !缺窗（已显示少于全量却 hasOlder=0）"}
                          </span>
                        ) : null}
                      </div>
                      <div style={{ color: "#fdba74", fontSize: 10, lineHeight: 1.35, marginTop: 4 }}>
                        到顶语义：几何顶=scrollTop≈0；「应自动拉」=还有更早；「无更早」=历史已尽；
                        「loading」=正在展开；「卡住」=到顶仍有更早却没触发。src=scrollToBottom /
                        browser/native / wheel 可对照谁拽的。
                      </div>
                      <div style={{ color: "#fed7aa", fontSize: 10 }}>
                        当前 scroll={snapshot.scrollTop}/{snapshot.scrollHeight} · hasOlder=
                        {snapshot.history.hasOlder ? 1 : 0} · loading=
                        {snapshot.history.loadingOlder ? 1 : 0} · wouldTrigger=
                        {snapshot.history.wouldTrigger ? 1 : 0} · first=
                        {snapshot.history.firstRowId ?? "∅"} · winFirst=
                        {snapshot.history.windowFirstRowId ?? "∅"} · JUMP累计=
                        {countViewportScrollJumps()}
                      </div>
                    </div>
                    <div
                      ref={scrollTrailRef}
                      onScroll={(e) => {
                        const el = e.currentTarget;
                        const dist =
                          el.scrollHeight - el.scrollTop - el.clientHeight;
                        scrollFollowBottomRef.current = dist < 56;
                      }}
                      style={{
                        ...mono,
                        flex: 1,
                        minHeight: 120,
                        overflow: "auto",
                        padding: "4px 6px 8px",
                        fontSize: 11,
                        color: "#ffedd5",
                      }}
                    >
                      {scrollEntries.length === 0 ? (
                        <div style={{ color: "#fdba74", padding: 8 }}>
                          尚无轨迹。在对话区上下滚几下，这里会贴底记下位置变化；猛跳标
                          !JUMP。
                        </div>
                      ) : (
                        scrollEntries.map((entry, idx) => {
                          const newest = idx >= scrollEntries.length - 2;
                          const time = new Date(entry.atMs).toLocaleTimeString(
                            "zh-CN",
                            {
                              hour12: false,
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                            },
                          );
                          const ms = String(entry.atMs % 1000).padStart(3, "0");
                          return (
                            <div
                              key={entry.id}
                              style={{
                                marginBottom: 2,
                                padding: "3px 6px",
                                borderRadius: 4,
                                border: entry.jump
                                  ? "1px solid rgba(248,113,113,0.65)"
                                  : newest
                                    ? "1px solid rgba(251,191,36,0.45)"
                                    : "1px solid transparent",
                                background: entry.jump
                                  ? "rgba(153, 27, 27, 0.45)"
                                  : newest
                                    ? "rgba(154, 52, 18, 0.35)"
                                    : "transparent",
                                color: entry.jump ? "#fecaca" : "#ffedd5",
                              }}
                              title={formatScrollTopVerdict(entry.verdict)}
                            >
                              <div style={tapLineStyle}>
                                #{entry.id} {time}.{ms}{" "}
                                {entry.jump ? (
                                  <b style={{ color: "#f87171" }}>!JUMP </b>
                                ) : null}
                                {entry.headline}
                              </div>
                              <div
                                style={{
                                  ...tapLineStyle,
                                  marginTop: 2,
                                  fontSize: 10,
                                  color: entry.jump ? "#fca5a5" : "#fdba74",
                                }}
                              >
                                {formatScrollTopVerdict(entry.verdict)}
                                {" · "}已显示{entry.windowCount}/全量
                                {entry.totalCount ?? "∅"}
                                {" · "}hasOlder={entry.hasOlder ? 1 : 0}
                                {" · "}loading={entry.loadingOlder ? 1 : 0}
                                {" · "}auto=
                                {entry.wouldTrigger ? 1 : 0}
                                {" · "}first={entry.firstRowId ?? "∅"}→win
                                {entry.windowFirstRowId ?? "∅"}
                                {" · "}follow={entry.followingAttr ?? "∅"}
                              </div>
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
                        <span>
                          最新在底 · V4 历史 =
                          <b style={{ color: "#fde68a" }}> 订投影→SSE首屏</b>
                          {" / "}上拉 rowsRange
                        </span>
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
                            ["history", "查历史"],
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
                                  ? id === "history"
                                    ? "rgba(245,158,11,0.4)"
                                    : "rgba(16,185,129,0.35)"
                                  : "rgba(15,23,42,0.45)",
                              color:
                                apiFamily === id
                                  ? "#ecfdf5"
                                  : id === "history"
                                    ? "#fde68a"
                                    : "#a7f3d0",
                              borderColor:
                                apiFamily === id
                                  ? id === "history"
                                    ? "rgba(251,191,36,0.65)"
                                    : "rgba(52,211,153,0.55)"
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
                          {apiFamily === "history" ? (
                            <>
                              尚无查历史记录。V4 打开会话的历史是{" "}
                              <b>subscribe → SSE snapshot</b>
                              （标签「查历史·订阅 / 查历史·首屏」），不是 Obs
                              「调用记录」里的模型请求，也通常不是 /messages。
                              <br />
                              上拉更早才是{" "}
                              <b>store.loadOlder → rowsRange</b>
                              （「查历史·上拉」）。
                              <br />
                              当前 hasOlder=
                              {snapshot?.history.hasOlder ? "1" : "0"} ·
                              loading=
                              {snapshot?.history.loadingOlder ? "1" : "0"} ·
                              firstRowId=
                              {snapshot?.history.firstRowId ?? "∅"} · winFirst=
                              {snapshot?.history.windowFirstRowId ?? "∅"}
                              <br />
                              切到本会话或点「清空」后再切一次会话，应出现「查历史·订阅
                              + 查历史·首屏」。
                              {snapshot?.history.hasOlder
                                ? " 有更早行时滚到顶才会多一条「查历史·上拉」。"
                                : " hasOlder=0 时上拉不会请求。"}
                            </>
                          ) : (
                            <>
                              尚无本会话接口记录。切会话 / 发消息 / 上拉到顶
                              后会出现。若刚点过「清空」需再触发一次。
                            </>
                          )}
                        </div>
                      ) : (
                        apiEntries.map((entry, idx) => {
                          const newest = idx >= apiEntries.length - 2;
                          const open =
                            expandedApiId === entry.id || newest;
                          const isHistory =
                            entry.badge === "查历史" ||
                            entry.label.startsWith("查历史");
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
                                marginBottom: 8,
                                padding: "6px 8px",
                                borderRadius: 6,
                                border: isHistory
                                  ? "1px solid rgba(251,191,36,0.55)"
                                  : newest
                                    ? "1px solid rgba(110,231,183,0.45)"
                                    : "1px solid rgba(148,163,184,0.22)",
                                background: isHistory
                                  ? "rgba(120, 53, 15, 0.35)"
                                  : newest
                                    ? "rgba(6, 95, 70, 0.35)"
                                    : entry.ok
                                      ? "rgba(15,23,42,0.35)"
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
                                  display: "block",
                                  width: "100%",
                                  boxSizing: "border-box",
                                  color: entry.ok
                                    ? isHistory
                                      ? "#fef3c7"
                                      : "#d1fae5"
                                    : "#fecaca",
                                  ...tapLineStyle,
                                }}
                              >
                                {open ? "▼" : "▶"} #{entry.id} {time}{" "}
                                {isHistory ? (
                                  <span
                                    style={{
                                      display: "inline-block",
                                      marginRight: 4,
                                      padding: "0 5px",
                                      borderRadius: 3,
                                      background: "rgba(245,158,11,0.55)",
                                      color: "#422006",
                                      fontWeight: 700,
                                      fontSize: 10,
                                    }}
                                  >
                                    查历史
                                  </span>
                                ) : null}
                                {entry.method} {entry.label} ·{" "}
                                {entry.status || "—"} · {entry.durationMs}ms
                                {"\n"}
                                {entry.headline}
                                {entry.pageText
                                  ? `\n📄 ${entry.pageText}`
                                  : ""}
                              </button>
                              {open ? (
                                <div
                                  style={{
                                    marginTop: 6,
                                    display: "flex",
                                    flexDirection: "column",
                                    gap: 8,
                                  }}
                                >
                                  {isHistory ? (
                                    <div
                                      style={{
                                        padding: "6px 8px",
                                        borderRadius: 4,
                                        border:
                                          "1px solid rgba(251,191,36,0.4)",
                                        background: "rgba(69, 26, 3, 0.45)",
                                        color: "#fef3c7",
                                      }}
                                    >
                                      <div
                                        style={{
                                          color: "#fbbf24",
                                          marginBottom: 4,
                                          fontSize: 10,
                                          fontWeight: 700,
                                        }}
                                      >
                                        {entry.label === "查历史·首屏"
                                          ? "查历史·首屏 = subscribe/resync 后 SSE snapshot 进 store 的窗口行（V4 打开会话真正「查到的历史」）"
                                          : entry.label === "查历史·订阅" ||
                                              entry.label === "查历史·resync"
                                            ? "查历史·订阅 = POST /api/v4/conversation/subscribe；行内容在随后「查历史·首屏」"
                                            : entry.label === "查历史·轨迹"
                                              ? "查历史·轨迹 = 旧 GET …/messages（V4 权威时常跳过）"
                                              : "查历史·上拉 = store.loadOlder → conversation.rowsRange（/api/v4/conversation/rows_range）"}
                                      </div>
                                      <div style={{ fontSize: 11, marginBottom: 6 }}>
                                        {entry.pageText || "（无分页摘要）"}
                                      </div>
                                      <div
                                        style={{
                                          color: "#fcd34d",
                                          marginBottom: 2,
                                          fontSize: 10,
                                        }}
                                      >
                                        本页返回的历史消息
                                      </div>
                                      <pre
                                        style={{
                                          ...tapJsonPreStyle,
                                          maxHeight: 220,
                                          borderColor:
                                            "rgba(251,191,36,0.35)",
                                          color: "#fffbeb",
                                        }}
                                      >
                                        {entry.historyPreviewText ||
                                          "（无预览）"}
                                      </pre>
                                    </div>
                                  ) : null}
                                  <div
                                    style={{
                                      display: "grid",
                                      gridTemplateColumns: "1fr 1fr",
                                      gap: 8,
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
                                        入参 JSON · {entry.path}
                                        {entry.query ? `?${entry.query}` : ""}
                                      </div>
                                      <pre style={tapJsonPreStyle}>
                                        {entry.requestText || "（无 body）"}
                                      </pre>
                                    </div>
                                    <div>
                                      <div
                                        style={{
                                          color: entry.ok
                                            ? "#6ee7b7"
                                            : "#fca5a5",
                                          marginBottom: 2,
                                          fontSize: 10,
                                        }}
                                      >
                                        出参 JSON · {entry.ok ? "ok" : "fail"} ·{" "}
                                        {entry.status}
                                      </div>
                                      <pre style={tapJsonPreStyle}>
                                        {entry.responseText || "（空）"}
                                      </pre>
                                    </div>
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
                    {(() => {
                      // 投影窗全序摊平（含最新发送）；不是「视口碰巧看见的旧 turn」
                      const sourceRows =
                        snapshot.windowRows?.length > 0
                          ? snapshot.windowRows
                          : snapshot.turns.flatMap((t) => t.rawRows);
                      type FlatLine = {
                        key: string;
                        lineNo: number;
                        turnId: string;
                        row: Record<string, unknown>;
                      };
                      const flat: FlatLine[] = [];
                      let lineNo = 0;
                      for (let ri = 0; ri < sourceRows.length; ri++) {
                        const r = sourceRows[ri]!;
                        const kind = String(r.kind || "");
                        if (kind === "turnHeader") continue;
                        lineNo += 1;
                        const rowId =
                          typeof r.rowId === "number" ||
                          typeof r.rowId === "string"
                            ? String(r.rowId)
                            : `i${ri}`;
                        flat.push({
                          key: `${String(r.turnId || "")}:${rowId}:${ri}`,
                          lineNo,
                          turnId: String(r.turnId || ""),
                          row: r,
                        });
                      }
                      const lastUser = [...flat]
                        .reverse()
                        .find((x) => String(x.row.kind) === "userInput");
                      const lastUserText = clip(lastUser?.row.text, 80);
                      const latestSend = timingRows.length
                        ? timingRows[timingRows.length - 1]
                        : null;
                      const sendText = clip(latestSend?.textPreview, 80);
                      const sendMatch =
                        !!sendText &&
                        !!lastUserText &&
                        (lastUserText === sendText ||
                          lastUserText.includes(sendText) ||
                          sendText.includes(lastUserText));
                      const pageSeen = pageVisibleBitsFromRawRows(sourceRows);
                      const pageSeenLine = [
                        pageSeen.user,
                        pageSeen.text,
                        pageSeen.tool,
                      ]
                        .filter(Boolean)
                        .join(" | ");
                      return (
                        <>
                          <div
                            style={{
                              ...mono,
                              marginBottom: 8,
                              padding: "6px 8px",
                              borderRadius: 6,
                              border: sendMatch
                                ? "1px solid rgba(134,239,172,0.45)"
                                : "1px solid rgba(251,191,36,0.55)",
                              background: sendMatch
                                ? "rgba(22,101,52,0.28)"
                                : "rgba(120,53,15,0.35)",
                              color: sendMatch ? "#bbf7d0" : "#fde68a",
                              fontSize: 12,
                            }}
                          >
                            发送「{sendText || "∅"}」
                            {" → "}
                            窗尾用户「{lastUserText || "∅"}」
                            {sendMatch
                              ? " · 对齐"
                              : " · 不一致（查投影是否没吃到 / 视口旧数据）"}
                            {" · "}共{flat.length}条
                          </div>
                          <div
                            style={{
                              ...mono,
                              marginBottom: 8,
                              padding: "6px 8px",
                              borderRadius: 6,
                              border: "1px solid rgba(125,211,252,0.45)",
                              background: "rgba(12,74,110,0.35)",
                              color: "#e0f2fe",
                              fontSize: 12,
                            }}
                            title="与时间线同一套 renderUnits：段末正文才是页面折叠外能看见的"
                          >
                            页面所见（应对齐聊天区）：
                            {pageSeenLine || "（空）"}
                          </div>
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
                              左 · 投影原行（含已折进「已工作」的中间正文；≠页面所见）
                            </div>
                            <div style={{ ...colHeadStyle, color: "#c4b5fd" }}>
                              右 · 这一条的 JSON
                            </div>
                          </div>
                          {flat.length === 0 ? (
                            <div style={{ color: "#fbbf24" }}>
                              投影窗没有用户/正文/工具行
                            </div>
                          ) : null}
                          {flat.map((item) => {
                            const open = expandedTurn === item.key;
                            const left = viewportRowLeftLabel(item.row);
                            const right = viewportRowJsonSummary(item.row);
                            return (
                              <div
                                key={item.key}
                                style={{
                                  marginBottom: open ? 6 : 1,
                                  borderRadius: 4,
                                  border: open
                                    ? "1px solid rgba(196,181,253,0.45)"
                                    : "1px solid transparent",
                                  background: open
                                    ? "rgba(30,41,59,0.55)"
                                    : "transparent",
                                }}
                              >
                                <button
                                  type="button"
                                  onClick={() =>
                                    setExpandedTurn((cur) =>
                                      cur === item.key ? null : item.key,
                                    )
                                  }
                                  style={{
                                    all: "unset",
                                    cursor: "pointer",
                                    display: "grid",
                                    gridTemplateColumns: "1fr 1fr",
                                    width: "100%",
                                    boxSizing: "border-box",
                                    ...mono,
                                    fontSize: 12,
                                  }}
                                >
                                  <div
                                    style={{
                                      padding: "4px 8px",
                                      borderRight:
                                        "1px solid rgba(148,163,184,0.25)",
                                      background: "rgba(6, 78, 59, 0.2)",
                                      color: "#d1fae5",
                                      whiteSpace: "nowrap",
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      textAlign: "left",
                                    }}
                                    title={left}
                                  >
                                    <span
                                      style={{
                                        color: "#f8fafc",
                                        fontWeight: 700,
                                        marginRight: 6,
                                      }}
                                    >
                                      L{item.lineNo}
                                    </span>
                                    <span style={{ color: "#64748b" }}>
                                      row#
                                      {String(item.row.rowId ?? "∅")}{" "}
                                    </span>
                                    {left}
                                  </div>
                                  <div
                                    style={{
                                      padding: "4px 8px",
                                      background: "rgba(76, 29, 149, 0.2)",
                                      color: "#ede9fe",
                                      whiteSpace: "nowrap",
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      textAlign: "left",
                                    }}
                                    title={right}
                                  >
                                    {open ? "▼ " : "▶ "}
                                    {right}
                                  </div>
                                </button>
                                {open ? (
                                  <pre
                                    style={{
                                      ...tapJsonPreStyle,
                                      margin: "0 0 4px",
                                    }}
                                  >
                                    {JSON.stringify(
                                      {
                                        line: item.lineNo,
                                        turnId: item.turnId,
                                        row: item.row,
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
                      );
                    })()}
                  </div>
                ) : null}

                {tab === "virt" ? (
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
                    <div
                      style={{
                        marginBottom: 8,
                        padding: "6px 8px",
                        borderRadius: 6,
                        background:
                          (virtProbe?.flags.length ?? 0) > 0
                            ? "rgba(127,29,29,0.28)"
                            : "rgba(22,101,52,0.22)",
                        color:
                          (virtProbe?.flags.length ?? 0) > 0
                            ? "#fecaca"
                            : "#86efac",
                        lineHeight: 1.4,
                      }}
                    >
                      <b>虚拟化 / 投影窗</b>
                      {" · "}
                      {virtProbe?.flags.length
                        ? virtProbe.flags.join(" · ")
                        : "窗跟流正常"}
                      <div style={{ marginTop: 4, color: "#94a3b8", fontSize: 10 }}>
                        对齐 ZCode：follow=1 查 tip/STREAM_AHEAD；follow=0 查上拉；
                        soft-cap 只在 snapshot/loadOlder（delta 不裁）。窗首&gt;窗尾 → UNSORTED。
                      </div>
                    </div>
                    {virtProbe ? (
                      <table
                        style={{
                          width: "100%",
                          borderCollapse: "collapse",
                          fontSize: 11,
                        }}
                      >
                        <tbody>
                          {(
                            [
                              ["软顶 softCap", String(virtProbe.softCap)],
                              [
                                "已显示 / 全量",
                                `${virtProbe.windowCount} / ${virtProbe.totalCount ?? "∅"}`,
                              ],
                              [
                                "占比 softCap",
                                `${virtProbe.softCapRatio}${virtProbe.balloon ? " !BALLOON" : ""}`,
                              ],
                              [
                                "窗两端(数组)",
                                `${virtProbe.winFirst ?? "∅"} … ${virtProbe.winLast ?? "∅"}`,
                              ],
                              [
                                "真实 min/max",
                                `${virtProbe.winMin ?? "∅"} … ${virtProbe.winMax ?? "∅"}${virtProbe.unsortedEnds ? " !UNSORTED" : ""}`,
                              ],
                              [
                                "流式 tip streamMax",
                                String(virtProbe.streamMaxRowId ?? "∅"),
                              ],
                              [
                                "窗尾 winLast",
                                String(virtProbe.winLast ?? "∅"),
                              ],
                              [
                                "STREAM_AHEAD",
                                virtProbe.streamAhead
                                  ? `是 · Δ+${virtProbe.streamAheadDelta}`
                                  : "否",
                              ],
                              [
                                "直播轮 tid",
                                virtProbe.liveTurnId
                                  ? virtProbe.liveTurnId.slice(0, 16)
                                  : "∅",
                              ],
                              [
                                "直播 tip liveTip",
                                String(virtProbe.liveTipRowId ?? "∅"),
                              ],
                              [
                                "inFlight 轮/窗",
                                `${virtProbe.liveInFlight} / ${virtProbe.windowInFlight}`,
                              ],
                              [
                                "上滚 hasOlder",
                                virtProbe.hasOlder ? "1" : "0",
                              ],
                              [
                                "loadingOlder",
                                virtProbe.loadingOlder ? "1" : "0",
                              ],
                              [
                                "wouldTrigger",
                                virtProbe.wouldTrigger ? "1" : "0",
                              ],
                              [
                                "跟底 follow",
                                virtProbe.following ? "1" : "0",
                              ],
                            ] as const
                          ).map(([k, v]) => (
                            <tr key={k}>
                              <td
                                style={{
                                  padding: "3px 6px",
                                  color: "#94a3b8",
                                  whiteSpace: "nowrap",
                                  verticalAlign: "top",
                                  width: "42%",
                                }}
                              >
                                {k}
                              </td>
                              <td
                                style={{
                                  padding: "3px 6px",
                                  color:
                                    String(v).includes("!") ||
                                    (k === "STREAM_AHEAD" && v.startsWith("是"))
                                      ? "#fbbf24"
                                      : "#e2e8f0",
                                  wordBreak: "break-all",
                                }}
                              >
                                {v}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div style={{ color: "#64748b", padding: 8 }}>
                        无投影快照（打开对话后再看）
                      </div>
                    )}
                  </div>
                ) : null}

                {tab === "anomaly" ? (
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
                    <div
                      style={{
                        marginBottom: 8,
                        color: "#94a3b8",
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 8,
                        justifyContent: "space-between",
                      }}
                    >
                      <span>
                        error/warn{" "}
                        <b style={{ color: "#e2e8f0" }}>锁定显示</b>
                        （证据滑出时间窗也不灭）；「现」=本帧仍命中，「曾」=曾现已安静。换会话自动清；也可手动清。
                      </span>
                      <button
                        type="button"
                        style={{
                          ...btnStyle,
                          flexShrink: 0,
                          opacity: anomalies.length ? 1 : 0.45,
                        }}
                        disabled={anomalies.length === 0}
                        onClick={clearStickyAnomalies}
                        title="清除锁定的异常（本帧仍命中的 info 会留下）"
                      >
                        清除锁定
                      </button>
                    </div>
                    {anomalies.length === 0 ? (
                      <div style={{ color: "#86efac" }}>暂无异常 · OK</div>
                    ) : (
                      <table
                        style={{
                          width: "100%",
                          borderCollapse: "collapse",
                          tableLayout: "fixed",
                        }}
                      >
                        <thead>
                          <tr style={{ color: "#94a3b8", textAlign: "left" }}>
                            <th style={{ width: 52, padding: "4px 6px" }}>级</th>
                            <th style={{ width: 168, padding: "4px 6px" }}>
                              代码
                            </th>
                            <th style={{ padding: "4px 6px" }}>说明 / 证据</th>
                          </tr>
                        </thead>
                        <tbody>
                          {anomalies.map((a) => (
                            <tr
                              key={a.code}
                              style={{
                                borderTop: "1px solid rgba(148,163,184,0.18)",
                                verticalAlign: "top",
                                opacity: a.live ? 1 : 0.72,
                              }}
                            >
                              <td
                                style={{
                                  padding: "6px",
                                  color:
                                    a.severity === "error"
                                      ? "#f87171"
                                      : a.severity === "warn"
                                        ? "#fbbf24"
                                        : "#67e8f9",
                                  fontWeight: 700,
                                }}
                              >
                                {a.severity}
                              </td>
                              <td
                                style={{
                                  padding: "6px",
                                  color: "#f8fafc",
                                  wordBreak: "break-all",
                                }}
                              >
                                {a.code}
                                <div
                                  style={{
                                    marginTop: 2,
                                    fontSize: 10,
                                    color: a.live ? "#86efac" : "#94a3b8",
                                  }}
                                >
                                  {a.live ? "现·仍命中" : "曾·已安静"}
                                </div>
                              </td>
                              <td style={{ padding: "6px" }}>
                                <div style={{ color: "#e2e8f0" }}>{a.title}</div>
                                <div
                                  style={{
                                    color: "#94a3b8",
                                    marginTop: 2,
                                    wordBreak: "break-word",
                                  }}
                                >
                                  {a.detail}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}
      {!minimized ? (
        <div
          onPointerDown={onPointerDownResize}
          onPointerMove={onPointerMoveResize}
          onPointerUp={onPointerUpResize}
          onPointerCancel={onPointerUpResize}
          title="拖右下角缩放"
          style={{
            position: "absolute",
            right: 2,
            bottom: 2,
            width: 18,
            height: 18,
            cursor: "nwse-resize",
            borderRadius: 3,
            background:
              "linear-gradient(135deg, transparent 0 45%, rgba(148,163,184,0.55) 46% 54%, transparent 55% 70%, rgba(148,163,184,0.75) 71% 79%, transparent 80%)",
            zIndex: 2,
          }}
        />
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
