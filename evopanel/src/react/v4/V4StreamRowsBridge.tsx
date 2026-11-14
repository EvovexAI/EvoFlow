// V4StreamRowsBridge — 把 V4 投影订阅收在叶子桥组件里，frame 更新只重渲染
// children 子树，不牵动 ChatApp 控制器（对齐老架构"流式期间控制器不重渲染"）。
//
// - 协议客户端：vendor 树的 SessionDataLayer + ConversationProjectionStore
//   （无 UI 数据层，语义 = ZCode v4：snapshot 整体替换 / fromSeq 衔接 / 断档不猜）。
// - 渲染：render-prop 交付**协议原生快照**（rows.window 原样），由
//   V4ZCodeTimeline（ZCode ConversationTimeline）渲染——行视图/时间线/贴底
//   全部是 ZCode 显示区域的正式实现，不经过任何行适配。
// - payload = null：V4 未就绪（开关关闭/会话无 threadId/订阅中），调用方回落老链路。
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  SessionDataLayer,
  type SessionLease,
} from "@zcode/ui/v4/sessionDataLayer.js";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationStoreState as StoreState } from "@zcode/ui/v4/conversationProjectionStore.js";
import { getEvoflowV4Transport } from "./evoflowV4Transport.js";
import {
  bindV4OpenThread,
  describeV4NotRenderedYet,
  describeV4Rendered,
  logV4Life,
  v4OpenSinceClickMs,
} from "../lib/v4-lifecycle-log.js";
import { markStreamCompareSession } from "../lib/stream-compare-file-log.js";
import { bindOpenTraceThread, endOpenTrace, markOpenStage } from "@zcode/ui/lib/openTrace.js";
import { publishV4DisplayAuthority } from "./v4Gate.js";
import { setV4TimelineBusy } from "./v4-timeline-busy-store.js";
import { resolveSessionBusyFromControl } from "./control-busy.js";
import {
  getSessionRuntime,
  isLivePostStreamOpen,
  isTurnBusy,
  noteSessionEvent,
} from "../lib/session-runtime-store.js";
import { isSessionRecoveryCooldownActive } from "../lib/stream-reattach-cooldown.js";
import { evoflowFetch } from "../../lib/ws-client.js";

export interface V4TimelinePayload {
  sessionId: string;
  snapshot: ConversationSnapshot;
  status: StoreState["status"];
  loadingOlder: boolean;
  onLoadOlder: () => Promise<void> | void;
}

export type V4BridgePhase =
  | "disabled"
  | "no-thread"
  | "connecting"
  | "ready"
  /** 投影 store 已 error 且无快照：V4 失败态（不回落老面板；闸门放行 AG-UI 正文）。 */
  | "failed";

const NOT_READY: StoreState | null = null;

/** 连接级单例数据层（同页所有会话共享一条 V4 SSE；keep-warm 由数据层管理）。 */
let sharedLayer: SessionDataLayer | null = null;
function getSharedLayer(): SessionDataLayer {
  if (!sharedLayer) {
    sharedLayer = new SessionDataLayer({ transport: getEvoflowV4Transport() });
  }
  return sharedLayer;
}

/** EvoFlow 外部模块（goalCommand / 头部 goal 徽标）复用同一条共享数据层，
 *  禁止自建 SessionDataLayer——那会开出第二条 frames SSE 连接。 */
export function getSharedV4SessionDataLayer(): SessionDataLayer {
  return getSharedLayer();
}

/**
 * 悬停预热限流：每个未命中快照的预热 = 一条完整 V4 快照订阅（单帧 370–854KB，
 * 主线程 JSON.parse）。鼠标扫过会话列表会连续触发，实测一次滑过 8+ 会话可在
 * 1s 内产生 ~4MB 解析导致整窗卡死（2026-10-27 00:44 复现）。
 * 命中已有快照的预热零成本，不受限；冷启动订阅按滑动窗口限量 + 总数封顶。
 */
const WARM_COLD_WINDOW_MS = 3_000;
/** 1 cold hydrate at a time in the window — parallel 1k+ row hydrates stall Gateway. */
const WARM_COLD_MAX_PER_WINDOW = 1;
const WARM_MAX_LIVE_SESSIONS = 4;
/** 多会话并跑：钉住最近/执行中会话的租约，避免 30s keep-warm 过期后冷开空白。 */
const PIN_MAX_SESSIONS = 4;
/**
 * 超大投影（复刻长会话常 1k–2k+ 行）后台 pin 会拖死 Gateway hydrate / context PATCH，
 * 表现为「两个对话在跑时点别的会话一直 connecting」。同屏最多钉住 1 条超大会话。
 */
const MEGA_PIN_ROW_SOFT_CAP = 900;
const MEGA_PIN_MAX = 1;
let _warmColdTimestamps: number[] = [];
const _pinnedLeases = new Map<string, SessionLease>();
/** threadId → 取消 pin busy 订阅 */
const _pinBusyUnsubs = new Map<string, () => void>();
/** threadId → sessionKey（侧栏 busy 与 runtime lastEventAt 用 sessionKey） */
const _pinSessionKeyByThread = new Map<string, string>();

function _leaseRowCount(lease: SessionLease): number {
  try {
    const st = lease.store.getState();
    return st.snapshot?.rows?.totalCount ?? st.snapshot?.rows?.window?.length ?? 0;
  } catch {
    return 0;
  }
}

function _pinnedMegaCount(): number {
  let n = 0;
  for (const lease of _pinnedLeases.values()) {
    if (_leaseRowCount(lease) >= MEGA_PIN_ROW_SOFT_CAP) n += 1;
  }
  return n;
}

function _pushPinBusyFromStore(
  threadId: string,
  sessionKey: string,
  store: { getState: () => StoreState; subscribe: (l: () => void) => () => void },
): void {
  const sk = String(sessionKey || "").trim();
  const tid = String(threadId || "").trim();
  if (!sk || !tid) return;
  const prevUnsub = _pinBusyUnsubs.get(tid);
  if (prevUnsub) {
    try {
      prevUnsub();
    } catch {
      /* ignore */
    }
    _pinBusyUnsubs.delete(tid);
  }
  const push = () => {
    try {
      const rt = getSessionRuntime(sk);
      // 用户点停后的冷却 / 已 settled：投影里陈旧 running 工具不得再钉齿轮与停止钮。
      if (isSessionRecoveryCooldownActive(sk) || rt.uiTurnSettled) {
        setV4TimelineBusy(sk, false);
        return;
      }
      const snap = store.getState()?.snapshot ?? null;
      // host 仍在跑：并集因子；host 已 idle 时 control 终态直接收口（control-first，
      // 见 control-busy.ts——Phase A 后 control 与快照同源，可做权威）。
      // 勿用 isSessionRuntimeLive（停后 stream 缓冲仍有字也会 true）。
      const hostExecuting = isTurnBusy(rt) || isLivePostStreamOpen(rt);
      const busy = resolveSessionBusyFromControl(snap, {
        hostExecuting: hostExecuting ? true : false,
      });
      setV4TimelineBusy(sk, busy);
      if (busy) {
        noteSessionEvent(sk, rt, { at: Date.now(), silent: true });
      }
    } catch {
      /* best-effort */
    }
  };
  push();
  _pinBusyUnsubs.set(tid, store.subscribe(push));
}

function _releasePinBusy(threadId: string, clearBusy: boolean): void {
  const tid = String(threadId || "").trim();
  if (!tid) return;
  const unsub = _pinBusyUnsubs.get(tid);
  if (unsub) {
    try {
      unsub();
    } catch {
      /* ignore */
    }
    _pinBusyUnsubs.delete(tid);
  }
  const sk = _pinSessionKeyByThread.get(tid);
  _pinSessionKeyByThread.delete(tid);
  if (clearBusy && sk) setV4TimelineBusy(sk, false);
}

export function warmEvoflowV4Session(
  sessionId: string,
  opts?: { force?: boolean },
): void {
  const id = String(sessionId || "").trim();
  if (!id) return;
  try {
    const layer = getSharedLayer();
    const now = monotonicNowSafe();
    _warmColdTimestamps = _warmColdTimestamps.filter((t) => now - t < WARM_COLD_WINDOW_MS);
    const known = layer.has(id);
    if (!known && !opts?.force) {
      if (layer.size >= WARM_MAX_LIVE_SESSIONS) return;
      if (_warmColdTimestamps.length >= WARM_COLD_MAX_PER_WINDOW) return;
      // 已钉住超大会话时禁止再冷预热：否则 keep_warm 排队把切会话 subscribe 拖到十几秒。
      if (_pinnedMegaCount() >= MEGA_PIN_MAX) return;
      _warmColdTimestamps.push(now);
    }
    const lease = layer.acquire(id, { intent: "prefetch" });
    const st = lease.store.getState();
    const hasSnap = Boolean(st.snapshot);
    const rowCount =
      st.snapshot?.rows?.totalCount ?? st.snapshot?.rows?.window?.length ?? 0;
    logV4Life({
      event: "open_warm",
      threadId: id,
      zh: hasSnap
        ? `悬停预热命中已有快照（openKind=${lease.openKind}，行数≈${rowCount}）→ 点击应能立刻出历史。`
        : `悬停预热开始订阅（openKind=${lease.openKind}，尚无快照）→ 后台等首帧；keep-warm 约 30s。`,
      detail: {
        openKind: lease.openKind,
        hasSnapshot: hasSnap,
        rowCount,
        storeStatus: st.status,
        intent: "prefetch",
      },
    });
    queueMicrotask(() => {
      try {
        lease.release();
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* best effort */
  }
}

/**
 * LangGraph stream-404 remint：在 React 换 selectedThreadId 之前调用，
 * 把旧 thread 投影原地改挂到新 thread，避免 cold open 清空时间线。
 */
export function rebindEvoflowV4ThreadOnRemint(
  oldThreadId: string,
  newThreadId: string,
): boolean {
  const oldId = String(oldThreadId || "").trim();
  const newId = String(newThreadId || "").trim();
  if (!oldId || !newId || oldId === newId) return false;
  let ok = false;
  try {
    ok = getSharedLayer().rebindSessionId(oldId, newId);
  } catch {
    ok = false;
  }
  // pin 表也要跟着走，否则仍钉着旧 tid，新 tid 冷开。
  try {
    const pinned = _pinnedLeases.get(oldId);
    if (pinned) {
      _pinnedLeases.delete(oldId);
      _pinnedLeases.set(newId, pinned);
    }
    const busyUnsub = _pinBusyUnsubs.get(oldId);
    if (busyUnsub) {
      _pinBusyUnsubs.delete(oldId);
      _pinBusyUnsubs.set(newId, busyUnsub);
    }
    const sk = _pinSessionKeyByThread.get(oldId);
    if (sk !== undefined) {
      _pinSessionKeyByThread.delete(oldId);
      _pinSessionKeyByThread.set(newId, sk);
    }
  } catch {
    /* best effort */
  }
  if (ok) {
    logV4Life({
      event: "remint_rebind",
      threadId: newId,
      zh: `stream-404 remint：V4 投影已从 ${oldId.slice(0, 8)}… 改挂到新 thread，保留快照避免空白卡顿。`,
      detail: { oldThreadId: oldId, newThreadId: newId },
      skipDedupe: true,
    });
  }
  return ok;
}

try {
  (
    window as Window & {
      __evoflowRebindV4OnRemint?: (oldId: string, newId: string) => boolean;
    }
  ).__evoflowRebindV4OnRemint = rebindEvoflowV4ThreadOnRemint;
} catch {
  /* ignore non-browser */
}

/**
 * 用户点开会话前调用：取消其它 keep-warm 中的冷 hydrate，
 * 把 Gateway 订阅槽让给当前会话（仍保留已 pin 的执行中投影）。
 */
export function focusEvoflowV4SessionForOpen(sessionId: string): void {
  const id = String(sessionId || "").trim();
  if (!id) return;
  try {
    const keep = [id, ..._pinnedLeases.keys()];
    const closed = getSharedLayer().releaseKeepWarmExcept(keep);
    if (closed > 0) {
      logV4Life({
        event: "focus_cancel_warm",
        threadId: id,
        zh: `用户打开会话：取消 ${closed} 条后台 keep-warm 投影，避免 hydrate 排队堵点击。`,
        detail: { closed, keepCount: keep.length },
      });
    }
  } catch {
    /* best effort */
  }
}

export type V4PinTarget = {
  threadId: string;
  /** 侧栏 / runtime 用 sessionKey；缺省时只钉租约、不同步 busy */
  sessionKey?: string | null;
};

/**
 * 钉住一组 thread 的 V4 投影租约（执行中 + 最近点过的会话）。
 * 与悬停 warm 不同：不立刻 release，refCount 保持 >0，store 不会进 30s keep-warm 过期关闭。
 * 这是「三路并跑切来切去空白」的根治：ZCode 同语义 — 有投影就继续显示，别冷开干等。
 *
 * 同时把各 pin store 的「还有活」同步到 v4-timeline-busy-store，并轻触 lastEventAt，
 * 避免切走选中会话后 SyncV4TimelineBusy 清 busy、45s stale 轮询误清侧栏转圈。
 */
export function syncEvoflowV4PinnedSessions(
  targets: readonly (string | V4PinTarget)[],
): void {
  const want: string[] = [];
  const seen = new Set<string>();
  const sessionByThread = new Map<string, string>();
  for (const raw of targets) {
    const id =
      typeof raw === "string"
        ? String(raw || "").trim()
        : String(raw?.threadId || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    want.push(id);
    const sk =
      typeof raw === "string"
        ? ""
        : String(raw?.sessionKey || "").trim();
    if (sk) {
      sessionByThread.set(id, sk);
      _pinSessionKeyByThread.set(id, sk);
    }
    if (want.length >= PIN_MAX_SESSIONS) break;
  }
  const wantSet = new Set(want);
  for (const [id, lease] of [..._pinnedLeases.entries()]) {
    if (wantSet.has(id)) continue;
    try {
      lease.release();
    } catch {
      /* ignore */
    }
    _pinnedLeases.delete(id);
    _releasePinBusy(id, true);
    logV4Life({
      event: "pin_release",
      threadId: id,
      zh: "取消钉住 V4 投影租约（会话已不在执行中/最近列表）。",
      detail: { pinned: _pinnedLeases.size },
    });
  }
  const layer = getSharedLayer();
  const primaryId = want[0] || "";
  let megaPinned = _pinnedMegaCount();
  for (const id of want) {
    const sk = sessionByThread.get(id) || _pinSessionKeyByThread.get(id) || "";
    const existing = _pinnedLeases.get(id);
    if (existing) {
      const existingRows = _leaseRowCount(existing);
      // 非首选的超大 pin：一律释放，把 Gateway 留给当前点开的会话 hydrate。
      if (existingRows >= MEGA_PIN_ROW_SOFT_CAP && id !== primaryId) {
        try {
          existing.release();
        } catch {
          /* ignore */
        }
        _pinnedLeases.delete(id);
        _releasePinBusy(id, true);
        megaPinned = Math.max(0, megaPinned - 1);
        logV4Life({
          event: "pin_release",
          threadId: id,
          zh: `释放超大投影钉住（行数≈${existingRows}）→ 避免拖死其它会话打开。`,
          detail: { rowCount: existingRows, pinned: _pinnedLeases.size },
        });
        continue;
      }
      try {
        existing.store.ensureConnected();
      } catch {
        /* ignore */
      }
      if (sk) _pushPinBusyFromStore(id, sk, existing.store);
      continue;
    }
    try {
      // pin 集合已截断到 PIN_MAX；允许冷 acquire，不被悬停 warm 的 live 上限挡住。
      const lease = layer.acquire(id);
      const st = lease.store.getState();
      const rowCount =
        st.snapshot?.rows?.totalCount ?? st.snapshot?.rows?.window?.length ?? 0;
      const isMega = rowCount >= MEGA_PIN_ROW_SOFT_CAP;
      if (isMega && megaPinned >= MEGA_PIN_MAX && id !== primaryId) {
        try {
          lease.release();
        } catch {
          /* ignore */
        }
        logV4Life({
          event: "pin_skip_mega",
          threadId: id,
          zh: `跳过钉住超大投影（行数≈${rowCount}，已有 ${megaPinned} 条）→ 保护切会话。`,
          detail: { rowCount, megaPinned, primaryId: primaryId || null },
        });
        continue;
      }
      _pinnedLeases.set(id, lease);
      if (isMega) megaPinned += 1;
      if (sk) _pushPinBusyFromStore(id, sk, lease.store);
      logV4Life({
        event: "pin_acquire",
        threadId: id,
        zh: `钉住 V4 投影租约（openKind=${lease.openKind}，行数≈${rowCount}）→ 切回不应冷开空白。`,
        detail: {
          openKind: lease.openKind,
          rowCount,
          storeStatus: st.status,
          pinned: _pinnedLeases.size,
          sessionKey: sk || null,
        },
      });
    } catch {
      /* best effort */
    }
  }
}

/** In-flight + last catchup — coalesce observer 1.5s ticks. */
const _catchupInFlight = new Set<string>();
const _catchupStableAt = new Map<string, { at: number; reason: string }>();
/** V4 已有投影时，旁观只做低频 soft reconcile；高频 catchup 会与 live mirror 对打（189↔351）。 */
const CATCHUP_READY_SOFT_MS = 20_000;
const CATCHUP_AFTER_REHYDRATE_MS = 12_000;
const CATCHUP_STABLE_MS = 2_800;

function _catchupCooldownMs(reason: string, softIntervalMs = CATCHUP_READY_SOFT_MS): number {
  if (reason === "post-rehydrate" || reason === "rehydrated") return CATCHUP_AFTER_REHYDRATE_MS;
  if (reason === "ready-soft") return softIntervalMs;
  return CATCHUP_STABLE_MS;
}

export type RefreshEvoflowV4Opts = {
  /**
   * 已有投影行时的 soft reconcile 最短间隔。
   * 默认 20s（飞书旁观防与 live mirror 对打）；工作流节点右栏无本机流式时可传 ~2–3s。
   */
  softIntervalMs?: number;
};

/**
 * 手动重连入口（v4-failed 终态「重新连接」按钮落点）：重燃该会话 store 的
 * 订阅退避循环（store.retry() 复位计数并立即重订阅）。store 未建立过时是
 * no-op——正常打开流程自身会订阅。
 */
export function retryEvoflowV4Session(sessionId: string): void {
  const id = String(sessionId || "").trim();
  if (!id) return;
  try {
    const layer = getSharedLayer();
    if (!layer.has(id)) return;
    const lease = layer.acquire(id);
    queueMicrotask(() => {
      try {
        lease.release();
      } catch {
        /* ignore */
      }
    });
    void lease.store.retry();
  } catch {
    /* best effort */
  }
}

/**
 * 员工执行过程等只读面板：主动拉一次最新投影（非流式）。
 *
 * - 面板已 ready 且有行：默认跳过（靠 SSE / channel mirror 增量）；每 ~20s soft 一次
 * - POST /catchup 成功后禁止再 resync；rehydrate 后冷却，避免与 live recovery 对打
 * - catchup 失败才回退 recoverFromStaleAuthority
 */
export function refreshEvoflowV4Session(
  sessionId: string,
  opts?: RefreshEvoflowV4Opts,
): void {
  const id = String(sessionId || "").trim();
  if (!id) return;
  const softIntervalMs = Math.max(
    500,
    Number(opts?.softIntervalMs) > 0 ? Number(opts?.softIntervalMs) : CATCHUP_READY_SOFT_MS,
  );
  if (_catchupInFlight.has(id)) {
    console.info("[observer-hw] v4 catchup skipped (in-flight)", { threadId: id });
    return;
  }
  const stable = _catchupStableAt.get(id);
  if (stable && Date.now() - stable.at < _catchupCooldownMs(stable.reason, softIntervalMs)) {
    console.info("[observer-hw] v4 catchup skipped (cooldown)", {
      threadId: id,
      reason: stable.reason,
      ageMs: Date.now() - stable.at,
      softIntervalMs,
    });
    return;
  }

  // 已有 V4 投影：旁观 tick 不要每 1.5s wipe；只低频 soft reconcile。
  try {
    const layer = getSharedLayer();
    if (layer.has(id)) {
      const lease = layer.acquire(id);
      try {
        const st = lease.store.getState();
        const n =
          st.snapshot?.rows?.totalCount ?? st.snapshot?.rows?.window?.length ?? 0;
        if (st.snapshot && n > 0) {
          const last = _catchupStableAt.get(id);
          const softDue = !last || Date.now() - last.at >= softIntervalMs;
          if (!softDue) {
            console.info("[observer-hw] v4 catchup skipped (ready)", {
              threadId: id,
              rows: n,
              ageMs: last ? Date.now() - last.at : null,
              softIntervalMs,
            });
            return;
          }
        }
      } finally {
        try {
          lease.release();
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* fall through to catchup */
  }

  _catchupInFlight.add(id);
  void (async () => {
    let catchupChanged = false;
    let catchupOk = false;
    let catchupReason = "";
    try {
      const resp = await evoflowFetch("/api/v4/conversation/catchup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: id }),
      });
      if (resp.ok) {
        catchupOk = true;
        try {
          const body = (await resp.json()) as {
            changed?: boolean;
            rows?: number;
            reason?: string;
          };
          catchupChanged = Boolean(body?.changed);
          catchupReason = String(body?.reason || "");
          console.info("[observer-hw] v4 catchup", {
            threadId: id,
            changed: catchupChanged,
            rows: body?.rows,
            reason: catchupReason,
          });
          _catchupStableAt.set(id, {
            at: Date.now(),
            reason: catchupChanged
              ? "post-rehydrate"
              : catchupReason || "ready-soft",
          });
        } catch {
          /* ignore parse */
        }
      } else {
        console.warn("[observer-hw] v4 catchup HTTP", resp.status, id);
      }
    } catch (err) {
      console.warn("[observer-hw] v4 catchup failed", {
        threadId: id,
        error: String(err instanceof Error ? err.message : err),
      });
    } finally {
      _catchupInFlight.delete(id);
    }

    try {
      const layer = getSharedLayer();
      if (!layer.has(id)) {
        warmEvoflowV4Session(id, { force: true });
        return;
      }
      // catchup HTTP 成功则禁止再 resync：
      // - changed=true：服务端已广播 recovery
      // - changed=false：投影未变 / live-mirror，再 resync 也会整页 recovery → 抖动
      // 仅 catchup 失败时才 recoverFromStaleAuthority。
      if (catchupOk) {
        if (catchupChanged) {
          console.info("[observer-hw] v4 skip resync (catchup already recovered)", {
            threadId: id,
            reason: catchupReason || "rehydrated",
          });
        }
        return;
      }
      const lease = layer.acquire(id);
      try {
        lease.store.recoverFromStaleAuthority();
      } finally {
        try {
          lease.release();
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* best effort */
    }
  })();
}

function _rowActivityMs(row: {
  kind?: string;
  createdAt?: number;
  startedAt?: number;
  endedAt?: number;
}): number {
  const ended = typeof row.endedAt === "number" && Number.isFinite(row.endedAt) ? row.endedAt : 0;
  const started =
    typeof row.startedAt === "number" && Number.isFinite(row.startedAt) ? row.startedAt : 0;
  const created =
    typeof row.createdAt === "number" && Number.isFinite(row.createdAt) ? row.createdAt : 0;
  // 工具行优先 endedAt/startedAt（最新调用时刻）；其它行用 createdAt。
  if (row.kind === "toolCall" || row.kind === "subagent" || row.kind === "hookInvocation") {
    return Math.max(ended, started, created);
  }
  return Math.max(created, ended, started);
}

/**
 * 读当前 V4 投影窗口的最近活动时间（Unix ms）。无快照 / 无行则 null。
 * 用于右栏标题旁的弱提示（如节点进度「最近工具时间」）。
 */
export function peekEvoflowV4LastActivityAt(sessionId: string): number | null {
  const id = String(sessionId || "").trim();
  if (!id) return null;
  try {
    const layer = getSharedLayer();
    if (!layer.has(id)) return null;
    const lease = layer.acquire(id);
    try {
      const window = lease.store.getState().snapshot?.rows?.window;
      if (!Array.isArray(window) || window.length === 0) return null;
      let best = 0;
      // 从末尾扫：最近工具优先，否则取窗口内最大活动时间。
      for (let i = window.length - 1; i >= 0; i--) {
        const row = window[i] as {
          kind?: string;
          createdAt?: number;
          startedAt?: number;
          endedAt?: number;
        };
        const ms = _rowActivityMs(row);
        if (ms > best) best = ms;
        if (row.kind === "toolCall" && ms > 0) break;
      }
      return best > 0 ? best : null;
    } finally {
      try {
        lease.release();
      } catch {
        /* ignore */
      }
    }
  } catch {
    return null;
  }
}

function monotonicNowSafe(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function V4StreamRowsBridge(props: {
  /** v4 session id = LangGraph threadId。 */
  sessionId: string | null;
  enabled: boolean;
  children: (payload: V4TimelinePayload | null, phase: V4BridgePhase) => ReactNode;
}): ReactNode {
  const { sessionId, enabled, children } = props;
  const layer = useMemo(() => getSharedLayer(), []);
  const [lease, setLease] = useState<SessionLease | null>(null);

  // layout：尽量在绘制前换租约，减少「新 sessionId + 旧 store」错配一帧。
  useLayoutEffect(() => {
    if (!enabled || !sessionId) {
      setLease(null);
      return;
    }
    bindV4OpenThread(sessionId);
    bindOpenTraceThread(sessionId);
    // 先清掉其它 keep-warm 冷 hydrate，再 acquire——用户点击插队。
    focusEvoflowV4SessionForOpen(sessionId);
    const acquireStartedAt = Date.now();
    const acquired = layer.acquire(sessionId);
    const acquireMs = Date.now() - acquireStartedAt;
    const st = acquired.store.getState();
    const hasSnap = Boolean(st.snapshot);
    const rowCount =
      st.snapshot?.rows?.totalCount ?? st.snapshot?.rows?.window?.length ?? 0;
    const since = v4OpenSinceClickMs({ threadId: sessionId });
    markOpenStage(
      "acquire",
      hasSnap
        ? `V4 租约已挂上（命中缓存快照，openKind=${acquired.openKind}，行数≈${rowCount}）`
        : `V4 租约已挂上（无缓存快照，openKind=${acquired.openKind}，store=${st.status}）`,
      {
        acquireMs,
        openKind: acquired.openKind,
        hasSnapshot: hasSnap,
        rowCount,
        storeStatus: st.status,
      },
      {
        reason: hasSnap
          ? undefined
          : `openKind=${acquired.openKind}：这是冷开（没有可复用的投影 store），后面还要等服务端 subscribe + 首帧 snapshot 才会上屏。` +
            `openKind=cold 且会话很久没打开过 → 慢在服务端 hydrate 拉库；openKind=warm 说明刚被预热过。`,
      },
    );
    logV4Life({
      event: "open_acquire",
      threadId: sessionId,
      zh: hasSnap
        ? `点击后租约已挂上：命中缓存快照（openKind=${acquired.openKind}，行数≈${rowCount}）→ 应几乎立刻上屏。`
        : `点击后租约已挂上：无缓存快照（openKind=${acquired.openKind}，store=${st.status}）→ 需等 subscribe/首帧，这是「慢」的主路径。`,
      detail: {
        openKind: acquired.openKind,
        hasSnapshot: hasSnap,
        rowCount,
        storeStatus: st.status,
        subscriptionId: st.subscriptionId,
        ...(since != null ? { sinceClickMs: since } : {}),
      },
      skipDedupe: true,
    });
    // acquire 后立刻自愈卡住的 connecting（SessionDataLayer 已 ensureConnected；
    // 这里再兜一层，覆盖 lease 已挂上但首帧仍未到的 hung HTTP：短延迟 retry）。
    let earlyRetryTimer: number | null = null;
    if (!hasSnap && st.status === "connecting" && !st.subscriptionId) {
      earlyRetryTimer = window.setTimeout(() => {
        try {
          const cur = acquired.store.getState();
          if (cur.snapshot || cur.subscriptionId || cur.status !== "connecting") return;
          void acquired.store.retry();
          logV4Life({
            event: "connecting_early_retry",
            level: "warn",
            threadId: sessionId,
            zh: "切会话后 1.2s 仍无订阅：提前 retry（不等满 5s watchdog）。",
            detail: { openKind: acquired.openKind, storeStatus: cur.status },
            skipDedupe: true,
          });
        } catch {
          /* best-effort */
        }
      }, 1_200);
    }
    setLease(acquired);
    return () => {
      if (earlyRetryTimer != null) window.clearTimeout(earlyRetryTimer);
      acquired.release();
      setLease(null);
    };
  }, [layer, enabled, sessionId]);

  // sessionId 已变但 effect 尚未提交时，绝不能读上一会话的 store（会 ready 错配 → 误 hold 老面板）。
  // 但 pin/keep-warm 里若已有目标 session 的投影，peek 出来先画——对齐 ZCode「旧投影优于空白」。
  const leaseForSession =
    lease && sessionId && lease.sessionId === sessionId ? lease : null;
  const peekStore =
    !leaseForSession && sessionId ? layer.peekStore(sessionId) : null;
  const store = leaseForSession?.store ?? peekStore;
  const state: StoreState | null = useSyncExternalStore(
    (listener) => store?.subscribe(listener) ?? (() => {}),
    () => store?.getState() ?? NOT_READY,
    () => NOT_READY,
  );

  const onLoadOlder = useMemo(
    () => async () => {
      await store?.loadOlder();
    },
    [store],
  );

  const snapshot: ConversationSnapshot | null = state?.snapshot ?? null;
  const storeFailed = !!sessionId && !snapshot && state?.status === "error";
  const pathState = !enabled
    ? "legacy:off"
    : !sessionId
      ? "legacy:no-thread"
      : snapshot
        ? "v4"
        : storeFailed
          ? "v4-failed"
          : "v4-connecting";
  const lastPathLogRef = useRef("");
  const connectingSinceRef = useRef<number | null>(null);
  const connectingSessionRef = useRef<string | null>(null);

  // 闸门权威：仅 ready（有快照）时闸 AG-UI TEXT_*；failed/connecting 必须放行正文。
  // 幂等：只在「非 live → live」时 +1，「live → 非 live」时 -1，卸载时 -1。
  // 快照每帧更新都会重跑这个 effect，若按帧 +1 会把引用计数撑爆。
  const authorityRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const live = enabled && !!sessionId && !!snapshot;
    const tid = live ? sessionId! : null;
    const prev = authorityRef.current;
    if (prev === tid) return;
    if (prev) publishV4DisplayAuthority({ threadId: prev, live: false });
    if (tid) publishV4DisplayAuthority({ threadId: tid, live: true });
    authorityRef.current = tid;
    return () => {
      if (authorityRef.current) {
        publishV4DisplayAuthority({ threadId: authorityRef.current, live: false });
        authorityRef.current = null;
      }
    };
  }, [enabled, sessionId, snapshot]);

  useLayoutEffect(() => {
    const key = `${pathState}:${sessionId ?? ""}`;
    if (lastPathLogRef.current === key) return;
    lastPathLogRef.current = key;
    const rowCount = snapshot?.rows?.totalCount ?? snapshot?.rows?.window?.length ?? 0;
    const storeStatus = state?.status ?? null;
    if (sessionId) {
      try {
        markStreamCompareSession(sessionId);
      } catch {
        /* ignore */
      }
    }
    if (pathState === "v4") {
      const waitedMs =
        connectingSinceRef.current != null && connectingSessionRef.current === sessionId
          ? Date.now() - connectingSinceRef.current
          : null;
      connectingSinceRef.current = null;
      connectingSessionRef.current = null;
      const sinceClick = v4OpenSinceClickMs({ threadId: sessionId });
      console.info(
        `%c[v4-path] ★ 显示数据源 = V4 帧管线 → ZCode ConversationTimeline（GET /api/v4/conversation/frames）sessionId=${sessionId}`,
        "color:#2563eb;font-weight:bold",
      );
      const zhRender = describeV4Rendered({ rowCount, storeStatus });
      logV4Life({
        event: "ui_render",
        threadId: sessionId,
        zh: zhRender,
        detail: { path: "v4", rowCount, storeStatus },
        skipDedupe: true,
      });
      // React 已提交该会话的时间线 DOM（layout effect 里能拿到快照 = 已渲染）。
      markOpenStage(
        "render",
        `React 已提交 V4 时间线 DOM（行数≈${rowCount}）`,
        {
          rowCount,
          storeStatus,
          connectingWaitedMs: waitedMs,
          openKind: leaseForSession?.openKind ?? null,
        },
      );
      // 上屏：等一帧 rAF，确保浏览器真的把内容画出来（此时才算「用户看得到」）。
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          markOpenStage("paint", "浏览器已上屏（连续两帧 rAF 后）", { rowCount });
          endOpenTrace({
            status:
              sinceClick != null && sinceClick >= 3000
                ? "error"
                : sinceClick != null && sinceClick >= 1200
                  ? "warn"
                  : "ok",
            detail: {
              rowCount,
              connectingWaitedMs: waitedMs,
              openKind: leaseForSession?.openKind ?? null,
              sinceClickMs: sinceClick,
            },
          });
        });
      });
      logV4Life({
        event: "path",
        threadId: sessionId,
        zh: `显示路径切到 V4 时间线（首帧已到）。行数=${rowCount}`,
        detail: { path: "v4", rowCount, storeStatus },
        skipDedupe: true,
      });
      logV4Life({
        event: "open_ready",
        threadId: sessionId,
        level: sinceClick != null && sinceClick >= 1500 ? "warn" : "info",
        zh:
          sinceClick != null
            ? `【上屏耗时】距点击 ${sinceClick}ms 历史已可显示（行数=${rowCount}${waitedMs != null ? `，本段 connecting ${waitedMs}ms` : ""}）。${sinceClick >= 1500 ? "偏慢：对照同会话 open_acquire/subscribe_ack/frame_snapshot/sse_frame_assemble。" : "正常。"}`
            : `历史已可显示（行数=${rowCount}）；无点击计时锚点（可能来自预热/非侧栏打开）。`,
        detail: {
          rowCount,
          storeStatus,
          connectingWaitedMs: waitedMs,
          openKind: leaseForSession?.openKind ?? null,
        },
        skipDedupe: true,
      });
    } else if (pathState === "v4-failed") {
      connectingSinceRef.current = null;
      connectingSessionRef.current = null;
      console.warn(
        `%c[v4-path] V4 store=error 且无快照（session=${sessionId}）→ 留在 V4 失败态，放行 AG-UI 正文`,
        "color:#dc2626;font-weight:bold",
      );
      // 打开失败：终结 trace（error），把失败原因写进分段。
      markOpenStage(
        "subscribe_ack",
        "V4 投影失败（store=error、无快照）",
        { storeStatus, lease: !!leaseForSession },
        {
          reason:
            "订阅过程中投影 store 进入 error 态且没有任何快照：subscribe 被拒绝或连接被打断" +
            "（runtime 换代 / 网关重启 / 订阅被拒）。查 transport 的 subscribe_ack 段与控制台 [v4-tx] 警告。",
        },
      );
      endOpenTrace({
        status: "error",
        reason: "打开失败：V4 投影 store=error 且无快照，历史未能上屏。",
        detail: { path: "v4-failed", storeStatus },
      });
      logV4Life({
        event: "ui_render",
        threadId: sessionId,
        level: "warn",
        zh: "V4 投影失败（store=error、无快照）：留在 V4 失败态；闸门放行 AG-UI 正文。",
        detail: { path: "v4-failed", storeStatus, lease: !!leaseForSession },
        skipDedupe: true,
      });
      logV4Life({
        event: "path",
        threadId: sessionId,
        level: "warn",
        zh: "显示路径仍为 V4（failed 占位，不回落老面板）。",
        detail: { path: "v4-failed", storeStatus },
        skipDedupe: true,
      });
    } else if (pathState === "v4-connecting") {
      connectingSinceRef.current = Date.now();
      connectingSessionRef.current = sessionId;
      console.info(
        `%c[v4-path] V4 已订阅，等首帧快照中（session=${sessionId}）——不回落老面板`,
        "color:#9333ea;font-weight:bold",
      );
      const zhWait = describeV4NotRenderedYet({
        path: "v4-connecting",
        storeStatus,
        lease: !!leaseForSession,
        rowCount: 0,
        hasSubscription: storeStatus === "live",
      });
      logV4Life({
        event: "ui_render",
        threadId: sessionId,
        level: "info",
        zh: zhWait,
        detail: { path: "v4-connecting", storeStatus, lease: !!leaseForSession },
      });
      logV4Life({
        event: "path",
        threadId: sessionId,
        zh: "点击会话后进入「等首帧」：页面此时只显示加载中，历史时间线尚未挂载。",
        detail: { path: "v4-connecting", storeStatus, lease: !!leaseForSession },
      });
    } else {
      connectingSinceRef.current = null;
      connectingSessionRef.current = null;
      const reason = !enabled ? "V4 开关关闭" : "会话尚无 threadId";
      console.info(
        `%c[v4-path] 显示数据源 = 老链路（AG-UI SSE）——${reason}`,
        "color:#ca8a04;font-weight:bold",
      );
      const zhLegacy = describeV4NotRenderedYet({ path: pathState, reason });
      logV4Life({
        event: "ui_render",
        threadId: sessionId,
        zh: zhLegacy,
        detail: { path: pathState, reason },
      });
      logV4Life({
        event: "path",
        threadId: sessionId,
        zh: `未走 V4 时间线：${reason}`,
        detail: { path: pathState, reason },
      });
    }
  }, [pathState, sessionId, enabled, snapshot, state?.status, leaseForSession]);

  // connecting 每秒打进度；无订阅 2s / 有订阅等首帧 5s 后 warn + recovery。
  useLayoutEffect(() => {
    if (pathState !== "v4-connecting" || !sessionId) return;
    const started = connectingSinceRef.current || Date.now();
    connectingSinceRef.current = started;
    const stuckAfterMs = store?.getState()?.subscriptionId ? 5_000 : 2_000;
    const tick = window.setInterval(() => {
      if (lastPathLogRef.current !== `v4-connecting:${sessionId}`) return;
      const st = store?.getState();
      const waitedMs = Date.now() - started;
      const storeStatus = st?.status ?? state?.status ?? null;
      const hasSubscription = !!st?.subscriptionId;
      const hasSnap = Boolean(st?.snapshot);
      logV4Life({
        event: "connecting_tick",
        level: waitedMs >= 3000 ? "warn" : "info",
        threadId: sessionId,
        zh: `仍在等 V4 首帧：已 ${Math.round(waitedMs / 1000)}s（store=${storeStatus || "?"} sub=${hasSubscription ? "有" : "无"} snap=${hasSnap ? "有" : "无"}）。`,
        detail: {
          waitedMs,
          storeStatus,
          lease: !!leaseForSession,
          hasSubscription,
          hasSnapshot: hasSnap,
          openKind: leaseForSession?.openKind ?? null,
        },
        skipDedupe: true,
      });
    }, 1_000);
    const stuck = window.setTimeout(() => {
      if (lastPathLogRef.current !== `v4-connecting:${sessionId}`) return;
      const st = store?.getState();
      const waitedMs = Date.now() - started;
      const storeStatus = st?.status ?? state?.status ?? null;
      const hasSubscription = !!st?.subscriptionId;
      const why = describeV4NotRenderedYet({
        path: "v4-connecting",
        storeStatus,
        lease: !!leaseForSession,
        rowCount: 0,
        hasSubscription,
      });
      logV4Life({
        event: "connecting_stuck",
        level: "warn",
        threadId: sessionId,
        zh: `点击会话后已等待 ${Math.round(waitedMs / 1000)} 秒仍未渲染历史。${why} 将尝试主动 recovery（与发消息触发的自愈同路径）。`,
        detail: {
          waitedMs,
          storeStatus,
          lease: !!leaseForSession,
          hasSubscription,
          hint: "initial 丢失时发消息会走 delta→recovery；此处主动 recoverFromStaleAuthority",
        },
        skipDedupe: true,
      });
      // 卡住 5s：把「卡在哪」明确写进分段计时，并终结这次 trace（error）。
      markOpenStage(
        "subscribe_ack",
        `等首帧已超时（${Math.round(waitedMs / 1000)}s，store=${storeStatus || "?"}，订阅=${hasSubscription ? "有" : "无"}）`,
        {
          waitedMs,
          storeStatus,
          hasSubscription,
          hasSnapshot: !!st?.snapshot,
          openKind: leaseForSession?.openKind ?? null,
        },
        {
          reason:
            `点击后 ${Math.round(waitedMs / 1000)}s 仍未拿到首帧。` +
            `${hasSubscription ? "订阅已建立但服务端没推 initial 帧" : "订阅都没建起来（connect 未发出 / 被 runtime 回收静默吞掉）"}。` +
            `已触发主动 recovery。若恢复后仍不显示，看同一 trace 里 subscribe/frame_snapshot 两段谁超时。`,
        },
      );
      try {
        if (!st?.snapshot) {
          if (st?.subscriptionId) {
            store?.recoverFromStaleAuthority();
          } else if (st && String(st.status) === "connecting") {
            // connecting 但无 subscription 且已 5s：connect 从未发出或被 recycle
            // timer 的代际检查静默吞掉（2026-11-08 正式版实锤：空白 47.9s，
            // subscribe POST 直到旧回合 sse_final 才放行）。retry() 清 recycle
            // 计数并强制重连——connect() 自身有 connectInFlight 幂等，不怕重复。
            void store?.retry();
          } else if (sessionId) {
            // store=error 且无 subscription：re-acquire 走 keep-warm 再试一次
            // （用户正在看的会话，绕过预热限流）
            warmEvoflowV4Session(sessionId, { force: true });
          }
        }
      } catch {
        /* best-effort */
      }
    }, stuckAfterMs);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(stuck);
    };
  }, [pathState, sessionId, state?.status, leaseForSession, store]);

  const status = state?.status ?? "connecting";
  const loadingOlder = state?.loadingOlder ?? false;
  const payload = useMemo<V4TimelinePayload | null>(() => {
    // 切会话瞬间 lease effect 尚未提交：leaseForSession=null，但 pin/peek 里已有
    // 目标 thread 投影。旧逻辑强依赖 lease → payload=null → 时间线空白一帧。
    // store 已是「本 session 的 lease 或 peek」，不会误交上一会话快照。
    if (!snapshot || !sessionId || !store) return null;
    return {
      sessionId,
      snapshot,
      status,
      loadingOlder,
      onLoadOlder,
    };
  }, [sessionId, snapshot, status, loadingOlder, onLoadOlder, store]);

  if (!enabled || !sessionId) {
    return children(null, !enabled ? "disabled" : "no-thread");
  }
  // 有快照 → ready；store error 无快照 → failed（留在 V4 失败态，不回落老面板）；否则 connecting。
  const phase: V4BridgePhase = payload
    ? "ready"
    : storeFailed
      ? "failed"
      : "connecting";
  return children(payload, phase);
}
