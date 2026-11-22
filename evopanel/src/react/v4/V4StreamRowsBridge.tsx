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
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  loadV4SnapshotDiskCache,
  scheduleV4SnapshotDiskCache,
} from "./v4-snapshot-disk-cache.js";
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
import { getV4TimelineBusy, setV4TimelineBusy } from "./v4-timeline-busy-store.js";
import { isSessionExecuting } from "../lib/session-execution/queries.js";
import { resolveSessionBusyFromControl } from "./control-busy.js";
import {
  getSessionRuntime,
  isLivePostStreamOpen,
  isTurnBusy,
  noteSessionEvent,
} from "../lib/session-runtime-store.js";
import { isSessionRecoveryCooldownActive } from "../lib/stream-reattach-cooldown.js";
import { evoflowFetch } from "../../lib/ws-client.js";
import {
  memoryWatchIntervalMs,
  noteRendererMemoryPressure,
  pinMaxForMemoryLevel,
  readRendererHeapMb,
  resolveRendererMemoryLevel,
  shouldContinueCriticalEviction,
} from "../lib/renderer-memory-pressure.js";
import { shrinkAllLiveProjectionWindows } from "../../zcode-ui/v4/conversationProjectionStore.js";

export interface V4TimelinePayload {
  sessionId: string;
  snapshot: ConversationSnapshot;
  status: StoreState["status"];
  loadingOlder: boolean;
  onLoadOlder: () => Promise<void> | void;
  /** 快照自动补拉（恢复可视性）：fresh subscribe / resync 后尾窗截断历史时用。 */
  onAutoBackfill: () => Promise<void> | void;
  /**
   * 跟底 / 回底部：若 loadOlder 已把投影窗撑成 balloon，裁回 softCap。
   * 上滚阅读历史时不要调。
   */
  onFollowingTip?: () => void;
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
 * 悬停预热限流：每个未命中快照的预热 = 一条完整 V4 快照订阅 + 主线程 JSON.parse。
 * 2026-10-27 实测单帧曾到 370–854KB 并把整窗卡死；同日服务端已加 256KB 字节预算
 * （60 行尾窗超限对半收缩，conversation.py _SNAPSHOT_MAX_BYTES），帧体积已受控，
 * 但 parse 仍在主线程，鼠标扫过列表仍会连续触发订阅——限流保留作为主线程防御。
 * 命中已有快照的预热零成本，不受限；冷启动只按滑动窗口限量。
 * 不对 layer.size 封顶——pin 会计入 size，封顶会让第 5 路悬停永远预热不到（偏离 ZCode）。
 */
const WARM_COLD_WINDOW_MS = 3_000;
/** 并行冷 hydrate 会拖死 Gateway；窗内最多 2 条。 */
const WARM_COLD_MAX_PER_WINDOW = 2;
/** 多会话并跑：钉住最近/执行中会话的租约，避免 30s keep-warm 过期后冷开空白。 */
const PIN_MAX_SESSIONS_DEFAULT = 4;
/**
 * 超大投影（复刻长会话常 1k–2k+ 行）仅用于观测 / 悬停冷预热节流。
 * pin 数量只走 pinMaxForMemoryLevel（与普通会话同一上限）——对齐 ZCode：
 * 执行中/最近的长会话一样常驻投影，不再因「超大」少钉一条导致互切冷开。
 */
const MEGA_PIN_ROW_SOFT_CAP = 900;
let _warmColdTimestamps: number[] = [];
const _pinnedLeases = new Map<string, SessionLease>();
/** threadId → 取消 pin busy 订阅 */
const _pinBusyUnsubs = new Map<string, () => void>();
/** threadId → sessionKey（侧栏 busy 与 runtime lastEventAt 用 sessionKey） */
const _pinSessionKeyByThread = new Map<string, string>();
/**
 * 跨 Bridge remount 的 sticky 快照（KeepAlive linger 卸掉后再挂也能画 ≤8s）。
 * 对齐 ZCode：旧投影优于空白。
 */
const _stickySnapshotByThread = new Map<
  string,
  { snapshot: ConversationSnapshot; at: number }
>();
const STICKY_SNAPSHOT_MS = 8_000;
let _memPressureTimer: ReturnType<typeof setTimeout> | null = null;

function _rememberStickySnapshot(
  sessionId: string,
  snapshot: ConversationSnapshot,
): void {
  const id = String(sessionId || "").trim();
  if (!id || !snapshot) return;
  _stickySnapshotByThread.set(id, { snapshot, at: Date.now() });
  if (_stickySnapshotByThread.size > 24) {
    const cutoff = Date.now() - STICKY_SNAPSHOT_MS;
    for (const [k, v] of _stickySnapshotByThread) {
      if (v.at < cutoff) _stickySnapshotByThread.delete(k);
    }
  }
}

function _peekStickySnapshot(sessionId: string): ConversationSnapshot | null {
  const id = String(sessionId || "").trim();
  if (!id) return null;
  const hit = _stickySnapshotByThread.get(id);
  if (!hit) return null;
  if (Date.now() - hit.at > STICKY_SNAPSHOT_MS) {
    _stickySnapshotByThread.delete(id);
    return null;
  }
  return hit.snapshot;
}

/** 侧栏/调试：该 thread 是否已有可画投影（peek 或 sticky）。 */
export function peekEvoflowV4HasPaintableSnapshot(sessionId: string): boolean {
  const id = String(sessionId || "").trim();
  if (!id) return false;
  try {
    const store = getSharedLayer().peekStore(id);
    if (store?.getState()?.snapshot) return true;
  } catch {
    /* ignore */
  }
  return !!_peekStickySnapshot(id);
}

function _clearStickySnapshots(): number {
  const n = _stickySnapshotByThread.size;
  _stickySnapshotByThread.clear();
  return n;
}

function _runMemoryPressurePass(): void {
  const level = noteRendererMemoryPressure({
    pinned: _pinnedLeases.size,
    layerSize: getSharedLayer().size,
  });
  if (level === "normal") return;

  // high：挤无快照冷 hydrate；同时强制把已常驻窗口裁到当前 softCap。
  // critical：heap 仍涨则清空全部 keep-warm + sticky，并对所有 live store 再裁一遍。
  if (level === "critical" && !shouldContinueCriticalEviction()) {
    const shrunk = shrinkAllLiveProjectionWindows();
    if (shrunk > 0) {
      logV4Life({
        event: "mem_pressure_shrink_windows",
        level: "warn",
        zh: `渲染内存危急但 heap 回落：仍强制裁了 ${shrunk} 个投影窗口。`,
        detail: { shrunk, heapMb: readRendererHeapMb() },
        skipDedupe: true,
      });
    }
    return;
  }

  const keep = [..._pinnedLeases.keys()];
  const onlyWithoutSnapshot = level === "high";
  const closed = getSharedLayer().releaseKeepWarmExcept(keep, {
    onlyWithoutSnapshot,
    preferLargest: true,
    // critical：一次清空空闲投影，别每次只挤 2 条看着 heap 涨到 3GB。
    ...(level === "critical" ? {} : { limit: 4 }),
  });
  const shrunk = shrinkAllLiveProjectionWindows();
  const stickyCleared = level === "critical" ? _clearStickySnapshots() : 0;
  if (closed > 0 || shrunk > 0 || stickyCleared > 0) {
    logV4Life({
      event: "mem_pressure_evict_warm",
      // warn only — critical eviction is protective, not a product failure.
      // skipDedupe=false so 2s critical polls don't flood frontend ERROR logs.
      level: "warn",
      zh:
        level === "critical"
          ? `渲染内存危急：清 keep-warm ${closed}、裁窗口 ${shrunk}、清 sticky ${stickyCleared}，避免 Out of Memory。`
          : `渲染内存偏高：清 keep-warm ${closed}、裁窗口 ${shrunk}。`,
      detail: {
        closed,
        shrunk,
        stickyCleared,
        level,
        pinned: _pinnedLeases.size,
        heapMb: readRendererHeapMb(),
        onlyWithoutSnapshot,
      },
    });
  }
}

function _ensureMemoryPressureWatch(): void {
  if (_memPressureTimer != null || typeof window === "undefined") return;
  const tick = () => {
    try {
      _runMemoryPressurePass();
    } catch {
      /* best-effort */
    }
    const level = resolveRendererMemoryLevel();
    _memPressureTimer = setTimeout(tick, memoryWatchIntervalMs(level));
  };
  _memPressureTimer = setTimeout(tick, memoryWatchIntervalMs("normal"));
}

try {
  _ensureMemoryPressureWatch();
} catch {
  /* ignore */
}

/** pin busy 订阅指纹：同 store+sk 已订则只推一次，避免 sync 循环撕订触发 #185 */
const _pinBusyBindKey = new Map<string, string>();

function _pushPinBusyFromStore(
  threadId: string,
  sessionKey: string,
  store: { getState: () => StoreState; subscribe: (l: () => void) => () => void },
): void {
  const sk = String(sessionKey || "").trim();
  const tid = String(threadId || "").trim();
  if (!sk || !tid) return;
  const bindKey = `${sk}::${tid}`;
  const prevUnsub = _pinBusyUnsubs.get(tid);
  if (prevUnsub && _pinBusyBindKey.get(tid) === bindKey) {
    // 已订同一会话：只同步一次 busy，不拆订阅（拆订+重订会在投影帧风暴里放大更新）
    try {
      const rt = getSessionRuntime(sk);
      if (isSessionRecoveryCooldownActive(sk) || rt.uiTurnSettled) {
        setV4TimelineBusy(sk, false);
        return;
      }
      const snap = store.getState()?.snapshot ?? null;
      const hostExecuting = isTurnBusy(rt) || isLivePostStreamOpen(rt);
      setV4TimelineBusy(
        sk,
        resolveSessionBusyFromControl(snap, {
          hostExecuting: hostExecuting ? true : false,
        }),
      );
    } catch {
      /* best-effort */
    }
    return;
  }
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
      // 禁止把 getV4TimelineBusy 并进 hostExecuting——会与 SyncV4TimelineBusy 互喂成 #185。
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
  _pinBusyBindKey.set(tid, bindKey);
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
  _pinBusyBindKey.delete(tid);
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
      // 只限「在途冷 hydrate」，不限 layer.size（pin 已占名额时仍应能悬停预热第五路）。
      if (_warmColdTimestamps.length >= WARM_COLD_MAX_PER_WINDOW) return;
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
 * 用户点开会话前调用：取消其它 keep-warm 中仍在冷 hydrate 的投影，
 * 把 Gateway 订阅槽让给当前会话（仍保留已 pin 的执行中投影）。
 *
 * 对齐 ZCode：已有 snapshot 的 keep-warm 不杀——多路并跑切来切去应直接画缓存，
 * 只有「悬停预热占着冷 hydrate 槽」才需要让路。危急水位仍全清。
 */
export function focusEvoflowV4SessionForOpen(sessionId: string): void {
  const id = String(sessionId || "").trim();
  if (!id) return;
  try {
    const level = noteRendererMemoryPressure({ focus: id });
    // 危急水位：仍保 pin + 当前点开；只额外挤掉最多 1 条最大空闲 keep-warm（随后 sync 会按 pinMax 重钉）。
    const keep = [id, ..._pinnedLeases.keys()];
    const onlyWithoutSnapshot = level !== "critical";
    const closed = getSharedLayer().releaseKeepWarmExcept(keep, {
      onlyWithoutSnapshot,
      ...(level === "critical"
        ? { limit: 1, preferLargest: true }
        : {}),
    });
    if (closed > 0) {
      logV4Life({
        event: "focus_cancel_warm",
        threadId: id,
        zh: onlyWithoutSnapshot
          ? `用户打开会话：取消 ${closed} 条无快照冷 hydrate keep-warm，保留已有投影缓存。`
          : `用户打开会话（内存危急）：挤掉 ${closed} 条最大空闲 keep-warm，保留 pin/当前投影。`,
        detail: {
          closed,
          keepCount: keep.length,
          memLevel: level,
          onlyWithoutSnapshot,
        },
      });
    }
  } catch {
    /* best effort */
  }
}

/**
 * Agent 应用（无限画布等）要在同 WebView 里再挂重 iframe / 本地服务。
 * 开签前主动挤掉 keep-warm，避免对话投影 + SPA 叠爆渲染进程（点不动 / OOM）。
 */
export function prepareRendererForHeavyStage(detail?: Record<string, unknown>): void {
  try {
    const level = noteRendererMemoryPressure({
      reason: "heavy_stage",
      ...(detail || {}),
    });
    const keep = [..._pinnedLeases.keys()];
    const closed = getSharedLayer().releaseKeepWarmExcept(keep, {
      // 开重 UI：有快照的空闲投影也挤，只保 pin（执行中）。
      onlyWithoutSnapshot: false,
      preferLargest: true,
    });
    const shrunk = shrinkAllLiveProjectionWindows();
    if (level === "critical") _clearStickySnapshots();
    if (closed > 0 || shrunk > 0) {
      logV4Life({
        event: "heavy_stage_evict_warm",
        level: level === "critical" ? "error" : "warn",
        zh: `打开重型右栏前：清 keep-warm ${closed}、裁窗口 ${shrunk}，给 Agent 应用腾渲染内存。`,
        detail: {
          closed,
          shrunk,
          level,
          pinned: _pinnedLeases.size,
          ...(detail || {}),
        },
        skipDedupe: true,
      });
    }
  } catch {
    /* best-effort */
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
  const memLevel = resolveRendererMemoryLevel();
  // high：执行中+选中可能 ≥3；保底 max(水位上限, min(请求数, 4))，避免第 3/4 路被挤冷开。
  const basePinMax = pinMaxForMemoryLevel(memLevel) || PIN_MAX_SESSIONS_DEFAULT;
  const requested = targets.reduce((n, raw) => {
    const id =
      typeof raw === "string"
        ? String(raw || "").trim()
        : String(raw?.threadId || "").trim();
    return id ? n + 1 : n;
  }, 0);
  const pinMax =
    memLevel === "high"
      ? Math.max(basePinMax, Math.min(requested, 6))
      : basePinMax;
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
    if (want.length >= pinMax) break;
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
  for (const id of want) {
    const sk = sessionByThread.get(id) || _pinSessionKeyByThread.get(id) || "";
    const existing = _pinnedLeases.get(id);
    if (existing) {
      // 已钉住（含超长会话）切走主选也不释放：对齐 ZCode「有投影继续显示」。
      try {
        existing.store.ensureConnected();
      } catch {
        /* ignore */
      }
      if (sk) _pushPinBusyFromStore(id, sk, existing.store);
      continue;
    }
    try {
      // pin 集合已截断到 pinMax；长/短会话同一配额，允许冷 acquire。
      const lease = layer.acquire(id);
      const st = lease.store.getState();
      const rowCount =
        st.snapshot?.rows?.totalCount ?? st.snapshot?.rows?.window?.length ?? 0;
      const isMega = rowCount >= MEGA_PIN_ROW_SOFT_CAP;
      _pinnedLeases.set(id, lease);
      if (sk) _pushPinBusyFromStore(id, sk, lease.store);
      logV4Life({
        event: "pin_acquire",
        threadId: id,
        zh: isMega
          ? `钉住超长会话 V4 投影（行数≈${rowCount}，openKind=${lease.openKind}）→ 与普通会话同配额，切回不冷开。`
          : `钉住 V4 投影租约（openKind=${lease.openKind}，行数≈${rowCount}）→ 切回不应冷开空白。`,
        detail: {
          openKind: lease.openKind,
          rowCount,
          isMega,
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
export type LastV4CatchupSnap = {
  at: number;
  reason: string;
  hubTip?: number | null;
  clientTip?: number | null;
  notified?: number | null;
  subscriberCount?: number | null;
  changed?: boolean;
};
const _catchupStableAt = new Map<string, LastV4CatchupSnap>();
/** V4 已有投影时，旁观只做低频 soft reconcile；高频 catchup 会与 live mirror 对打（189↔351）。 */
const CATCHUP_READY_SOFT_MS = 20_000;
const CATCHUP_AFTER_REHYDRATE_MS = 12_000;
const CATCHUP_STABLE_MS = 2_800;
/**
 * 直播中 catchup 采样常比本机 delta 慢 1～几行（现场 FE=2447 hub=2445）。
 * 小于此阈值的 tip 差不当幽灵/落后，禁止 recoverFromStaleAuthority（会打飞进行中订阅 → 等不到首字）。
 */
const TIP_DIVERGE_MIN = 5;

function tipAheadBy(
  a: number | null | undefined,
  b: number | null | undefined,
): boolean {
  return (
    typeof a === "number" &&
    typeof b === "number" &&
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    a - b >= TIP_DIVERGE_MIN
  );
}

/** 视口根因对账：读最近一次 catchup 对账快照（无则 null）。 */
export function peekLastV4Catchup(
  sessionId: string,
): LastV4CatchupSnap | null {
  const id = String(sessionId || "").trim();
  if (!id) return null;
  return _catchupStableAt.get(id) ?? null;
}

function _catchupCooldownMs(reason: string, softIntervalMs = CATCHUP_READY_SOFT_MS): number {
  if (
    reason === "post-rehydrate" ||
    reason === "rehydrated" ||
    reason === "client-stale-resync" ||
    reason === "client-behind-resync"
  ) {
    return CATCHUP_AFTER_REHYDRATE_MS;
  }
  if (reason === "ready-soft") return softIntervalMs;
  return CATCHUP_STABLE_MS;
}

export type RefreshEvoflowV4Opts = {
  /**
   * 已有投影行时的 soft reconcile 最短间隔。
   * 默认 20s（飞书旁观防与 live mirror 对打）；工作流节点右栏无本机流式时可传 ~2–3s。
   */
  softIntervalMs?: number;
  /**
   * 切回校准：服务端只 settle phase / 指纹，禁止 clear_projection wipe
   *（对齐 ZCode：客户端已有投影继续显示）。
   */
  preferSettleOnly?: boolean;
};

/** 旁观/切回 catchup 是否在途（Timeline autoBackfill 避让）。 */
export function isEvoflowV4CatchupInFlight(sessionId: string): boolean {
  const id = String(sessionId || "").trim();
  return !!id && _catchupInFlight.has(id);
}

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
  const preferSettleOnly = opts?.preferSettleOnly === true;
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

  // 先读本机 tip/epoch：既用于请求体对账，也用于判断是否跳过 soft coalesce。
  let clientTipRowId: number | null = null;
  let clientLogEpoch: string | null = null;
  let clientTotalCount: number | null = null;
  let localRowCount = 0;
  try {
    const layer = getSharedLayer();
    if (layer.has(id)) {
      const lease = layer.acquire(id);
      try {
        const snap = lease.store.getState().snapshot;
        const win = snap?.rows?.window ?? [];
        const last = win.length ? win[win.length - 1] : null;
        const tip = Number(last?.rowId);
        clientTipRowId = Number.isFinite(tip) && tip > 0 ? tip : null;
        clientLogEpoch = snap?.logEpoch != null ? String(snap.logEpoch) : null;
        const total = Number(snap?.rows?.totalCount);
        clientTotalCount =
          Number.isFinite(total) && total > 0 ? Math.floor(total) : null;
        localRowCount =
          clientTotalCount ?? (win.length > 0 ? win.length : 0);
      } finally {
        try {
          lease.release();
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore local meta */
  }

  // 已有 V4 投影：旁观 tick 不要每 1.5s wipe；只低频 soft reconcile。
  // 例外：
  // - 本机 tip 高于上次 hub tip → 幽灵膨胀
  // - 本机 tip 低于上次 hub tip → frames 丢了（AG-UI 在跑、V4 钉死）
  try {
    if (localRowCount > 0) {
      const last = _catchupStableAt.get(id);
      const softDue = !last || Date.now() - last.at >= softIntervalMs;
      const tipGhostVsLastHub = tipAheadBy(clientTipRowId, last?.hubTip);
      const tipLagVsLastHub = tipAheadBy(last?.hubTip, clientTipRowId);
      if (!softDue && !tipGhostVsLastHub && !tipLagVsLastHub) {
        console.info("[observer-hw] v4 catchup skipped (ready)", {
          threadId: id,
          rows: localRowCount,
          ageMs: last ? Date.now() - last.at : null,
          softIntervalMs,
        });
        return;
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
    let serverTip: number | null = null;
    let serverRows: number | null = null;
    let serverEpoch: string | null = null;
    let subscriberCount: number | null = null;
    try {
      const resp = await evoflowFetch("/api/v4/conversation/catchup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: id,
          ...(preferSettleOnly ? { preferSettleOnly: true } : {}),
          ...(clientTipRowId != null ? { clientTipRowId } : {}),
          ...(clientLogEpoch ? { clientLogEpoch } : {}),
        }),
      });
      if (resp.ok) {
        catchupOk = true;
        try {
          const body = (await resp.json()) as {
            changed?: boolean;
            rows?: number;
            reason?: string;
            tipRowId?: number | null;
            logEpoch?: string | number | null;
            notified?: number | null;
            subscriberCount?: number | null;
          };
          catchupChanged = Boolean(body?.changed);
          catchupReason = String(body?.reason || "");
          const tipN = Number(body?.tipRowId);
          serverTip = Number.isFinite(tipN) && tipN > 0 ? tipN : null;
          const rowsN = Number(body?.rows);
          serverRows = Number.isFinite(rowsN) && rowsN >= 0 ? rowsN : null;
          serverEpoch =
            body?.logEpoch != null && String(body.logEpoch).trim()
              ? String(body.logEpoch)
              : null;
          const notifiedN = Number(body?.notified);
          const subCountN = Number(body?.subscriberCount);
          const notified =
            Number.isFinite(notifiedN) ? notifiedN : null;
          subscriberCount =
            Number.isFinite(subCountN) ? subCountN : null;
          // recovery 广播无人收（双订阅后退订光了）→ 必须当 tip 落后处理，强制重连。
          if (
            catchupChanged &&
            notified != null &&
            notified <= 0 &&
            (catchupReason === "client-behind-resync" ||
              catchupReason === "client-stale-resync" ||
              catchupReason === "rehydrated")
          ) {
            catchupReason = `${catchupReason}+notified0`;
          }
          console.info("[observer-hw] v4 catchup", {
            threadId: id,
            changed: catchupChanged,
            rows: body?.rows,
            tipRowId: body?.tipRowId,
            logEpoch: body?.logEpoch,
            notified,
            subscriberCount,
            clientTipRowId,
            clientLogEpoch,
            reason: catchupReason,
          });
          _catchupStableAt.set(id, {
            at: Date.now(),
            reason: catchupChanged
              ? catchupReason === "client-stale-resync" ||
                  catchupReason === "client-behind-resync" ||
                  catchupReason.includes("notified0")
                ? catchupReason
                : "post-rehydrate"
              : catchupReason || "ready-soft",
            hubTip: serverTip ?? serverRows,
            clientTip: clientTipRowId,
            notified,
            subscriberCount,
            changed: catchupChanged,
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
      // catchup HTTP 成功：
      // - changed=true：服务端已广播 recovery（client-stale / client-behind）
      // - 但本机 tip 仍与 hub tip 分叉 / epoch 不一致时，说明错过了帧 → 主动 recover
      // - changed=false 且 tip 对齐：禁止再 resync（防抖动）
      // 仅 catchup 失败时才无条件 recoverFromStaleAuthority。
      const hubTip = serverTip ?? serverRows;
      // 微差（< TIP_DIVERGE_MIN）= live 采样噪声，不当 clientStale。
      const tipGhost = tipAheadBy(clientTipRowId, hubTip);
      const tipLag = tipAheadBy(hubTip, clientTipRowId);
      const microTipNoise =
        clientTipRowId != null &&
        hubTip != null &&
        clientTipRowId !== hubTip &&
        !tipGhost &&
        !tipLag;
      const totalGhost =
        clientTotalCount != null &&
        serverRows != null &&
        clientTotalCount - serverRows >= TIP_DIVERGE_MIN;
      const epochMismatch =
        !!clientLogEpoch &&
        !!serverEpoch &&
        clientLogEpoch !== serverEpoch &&
        (tipGhost || tipLag);
      // hub 回报 subscriberCount=0：本机 store 以为 live，hub 侧已无订户
      // （unsubscribe 风暴后常见）→ recovery 帧没人收，必须重订。
      const hubNoSubs =
        subscriberCount != null && subscriberCount <= 0;
      const clientStale =
        tipGhost ||
        tipLag ||
        totalGhost ||
        epochMismatch ||
        hubNoSubs ||
        catchupReason === "client-stale-resync" ||
        catchupReason === "client-behind-resync" ||
        catchupReason.includes("notified0");

      // live-mirror / hub-subscribed：tip 对齐或仅微差噪声 → 别 resync（防打飞直播订阅）。
      // tip 真落后/幽灵（≥TIP_DIVERGE_MIN）或 notified0：才 recoverFromStaleAuthority。
      if (catchupOk && !clientStale) {
        if (catchupChanged) {
          console.info("[observer-hw] v4 skip resync (catchup already recovered)", {
            threadId: id,
            reason: catchupReason || "rehydrated",
          });
        } else if (microTipNoise) {
          console.info("[observer-hw] v4 skip resync (micro tip noise)", {
            threadId: id,
            clientTipRowId,
            hubTip,
            reason: catchupReason || "ready-soft",
          });
        }
        return;
      }
      if (
        catchupOk &&
        (catchupReason === "live-mirror" || catchupReason === "hub-subscribed") &&
        !tipLag &&
        !tipGhost &&
        !hubNoSubs
      ) {
        return;
      }
      const lease = layer.acquire(id);
      try {
        if (catchupOk && clientStale) {
          console.warn("[observer-hw] v4 tip diverge after catchup → recover", {
            threadId: id,
            reason: catchupReason || (tipLag ? "tip-lag" : "tip-ghost"),
            clientTipRowId,
            hubTip,
            clientTotalCount,
            serverRows,
            clientLogEpoch,
            serverEpoch,
          });
        }
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
  /**
   * 前台可见 host（主聊选中）。KeepAlive 隐藏 host 传 false：
   * 仍 acquire 常驻投影，但不抢 focus/display authority（对齐 ZCode hidden pane）。
   */
  foreground?: boolean;
  children: (payload: V4TimelinePayload | null, phase: V4BridgePhase) => ReactNode;
}): ReactNode {
  const { sessionId, enabled, children } = props;
  const foreground = props.foreground !== false;
  const layer = useMemo(() => getSharedLayer(), []);
  const [lease, setLease] = useState<SessionLease | null>(null);
  /** 重入补拉节流：sessionKey → 上次触发时间（refreshEvoflowV4Session 自身还有去重/冷却）。 */
  const switchBackCatchupAtRef = useRef<Map<string, number>>(new Map());
  /**
   * peek/lease 都 miss 时（刚被 mem 驱逐 / keep-warm 过期）仍用上一帧同 thread 快照画 ≤8s，
   * 避免 connecting 空闪——对齐 ZCode「旧投影优于空白」。
   * 模块级 Map：KeepAlive remount 后仍可命中。
   */
  const stickySnapRef = useRef<{
    sessionId: string;
    snapshot: ConversationSnapshot;
    at: number;
  } | null>(null);

  // 租约只跟 sessionId：KeepAlive 前后台切换不 release/re-acquire（对齐 ZCode pane 常驻）。
  useLayoutEffect(() => {
    if (!enabled || !sessionId) {
      setLease(null);
      return;
    }
    const acquireStartedAt = Date.now();
    const acquired = layer.acquire(sessionId);
    const acquireMs = Date.now() - acquireStartedAt;
    const st = acquired.store.getState();
    const hasSnap = Boolean(st.snapshot);
    const stickyHit = !hasSnap ? _peekStickySnapshot(sessionId) : null;
    const rowCount =
      st.snapshot?.rows?.totalCount ?? st.snapshot?.rows?.window?.length ?? 0;
    const since = v4OpenSinceClickMs({ threadId: sessionId });
    markOpenStage(
      "acquire",
      hasSnap
        ? `V4 租约已挂上（命中缓存快照，openKind=${acquired.openKind}，行数≈${rowCount}）`
        : stickyHit
          ? `V4 租约已挂上（无 store 快照，sticky 可先画，openKind=${acquired.openKind}）`
          : `V4 租约已挂上（无缓存快照，openKind=${acquired.openKind}，store=${st.status}）`,
      {
        acquireMs,
        openKind: acquired.openKind,
        hasSnapshot: hasSnap,
        stickyPaint: !!stickyHit,
        rowCount,
        storeStatus: st.status,
      },
      {
        reason: hasSnap
          ? undefined
          : stickyHit
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
        : stickyHit
          ? `点击后租约已挂上：store 无快照但 sticky 可先画（openKind=${acquired.openKind}）→ 等 subscribe 校准。`
          : `点击后租约已挂上：无缓存快照（openKind=${acquired.openKind}，store=${st.status}）→ 需等 subscribe/首帧，这是「慢」的主路径。`,
      detail: {
        openKind: acquired.openKind,
        hasSnapshot: hasSnap,
        stickyPaint: !!stickyHit,
        rowCount,
        storeStatus: st.status,
        subscriptionId: st.subscriptionId,
        ...(since != null ? { sinceClickMs: since } : {}),
      },
      skipDedupe: true,
    });
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
    };
  }, [layer, enabled, sessionId]);

  // 前台冷开可观测；后台 host keep 连接（失活 forceMount 切回不冷开）。
  // 故意不绑进 acquire effect：前后台切换不得 release/re-acquire。
  useLayoutEffect(() => {
    if (!enabled || !sessionId) return;
    const store =
      (lease && lease.sessionId === sessionId ? lease.store : null) ||
      layer.peekStore(sessionId);
    if (!store) return;
    if (!foreground) {
      try {
        store.ensureConnected();
      } catch {
        /* best-effort */
      }
      return;
    }
    const st = store.getState();
    const hasSnap = Boolean(st.snapshot);
    const stickyHit = !hasSnap ? _peekStickySnapshot(sessionId) : null;
    if (!hasSnap && !stickyHit) {
      logV4Life({
        event: "open_cold",
        level: "warn",
        threadId: sessionId,
        zh: `将冷开上屏：无 pin/keep-warm/sticky 快照（store=${st.status}）。悬停预热或 KeepAlive 可避免。`,
        detail: {
          storeStatus: st.status,
          pinned: _pinnedLeases.has(sessionId),
        },
        skipDedupe: true,
      });
    }
  }, [foreground, enabled, sessionId, lease, layer]);

  // 前台：focus 插队 + 非 live 时 soft catchup。后台 KeepAlive 不抢槽、不 catchup。
  useLayoutEffect(() => {
    if (!foreground || !enabled || !sessionId) return;
    bindV4OpenThread(sessionId);
    bindOpenTraceThread(sessionId);
    focusEvoflowV4SessionForOpen(sessionId);
    const storeForCatchup =
      (lease && lease.sessionId === sessionId ? lease.store : null) ||
      layer.peekStore(sessionId);
    if (!storeForCatchup) return;
    const st = storeForCatchup.getState();
    const hasSnap = Boolean(st.snapshot);
    const rowCount =
      st.snapshot?.rows?.totalCount ?? st.snapshot?.rows?.window?.length ?? 0;
    if (!hasSnap || rowCount <= 0) return;
    const liveSubscribed =
      st.status === "live" && Boolean(st.subscriptionId);
    // live+订阅仍可能 frames 丢了（WIRE_WITHOUT_V4_TIP：AG-UI 在跑、v4 行不涨）。
    // 现场 09:37：sub active、frames up，但 hub tip=1 / FE=2155 / subscriberCount=0；
    // 旧逻辑「无 tipLag 就 skip」在 catchup 从未跑过（hub=∅）时永久跳过对账。
    if (liveSubscribed) {
      const win = st.snapshot?.rows?.window ?? [];
      const tipN = Number(win.length ? win[win.length - 1]?.rowId : 0);
      const localTip = Number.isFinite(tipN) && tipN > 0 ? tipN : null;
      const lastCatchup = _catchupStableAt.get(String(sessionId));
      const lastHub = lastCatchup?.hubTip ?? null;
      const tipLag = tipAheadBy(lastHub, localTip);
      const tipGhost = tipAheadBy(localTip, lastHub);
      const neverCaughtUp = !lastCatchup;
      const hubSubsZero =
        lastCatchup?.subscriberCount != null &&
        lastCatchup.subscriberCount <= 0;
      const notified0 =
        lastCatchup?.notified != null && lastCatchup.notified <= 0;
      const mustReconcile =
        tipLag || tipGhost || neverCaughtUp || hubSubsZero || notified0;
      if (!mustReconcile) {
        logV4Life({
          event: "switch_back_catchup_skip",
          threadId: sessionId,
          zh: "切回会话：投影仍 live 且有订阅，跳过 catchup（避免 rehydrate 闪烁）。",
          detail: {
            rowCount,
            storeStatus: st.status,
            subscriptionId: st.subscriptionId,
          },
          skipDedupe: true,
        });
        return;
      }
      logV4Life({
        event: "switch_back_catchup_force",
        threadId: sessionId,
        zh: tipGhost
          ? "切回会话：本机 tip 高于 hub（幽灵膨胀），强制 soft catchup。"
          : neverCaughtUp
            ? "切回会话：从未 catchup 对账过，强制 soft catchup。"
            : hubSubsZero || notified0
              ? "切回会话：hub 订户为 0 / notified=0，强制 soft catchup 重订。"
              : "切回会话：live 订阅但本机 tip 落后上次 hub tip，强制 soft catchup。",
        detail: {
          localTip,
          lastHub,
          rowCount,
          subscriptionId: st.subscriptionId,
          neverCaughtUp,
          hubSubsZero,
          notified0,
        },
        skipDedupe: true,
      });
    }
    const key = String(sessionId);
    const now = Date.now();
    const last = switchBackCatchupAtRef.current.get(key) ?? 0;
    if (now - last <= 8_000) return;
    switchBackCatchupAtRef.current.set(key, now);
    if (switchBackCatchupAtRef.current.size > 64) {
      const cutoff = now - 60_000;
      for (const [k, at] of switchBackCatchupAtRef.current) {
        if (at < cutoff) switchBackCatchupAtRef.current.delete(k);
      }
    }
    const lastCatchupForSettle = _catchupStableAt.get(key);
    // tip 已分叉 / hub 无订户：不许 preferSettleOnly（否则服务端 settle-only 跳过 resync）。
    let tipMayDiverge = !lastCatchupForSettle;
    if (lastCatchupForSettle) {
      const winNow = st.snapshot?.rows?.window ?? [];
      const tipNow = Number(winNow.length ? winNow[winNow.length - 1]?.rowId : 0);
      const localNow = Number.isFinite(tipNow) && tipNow > 0 ? tipNow : null;
      if (
        tipAheadBy(localNow, lastCatchupForSettle.hubTip) ||
        tipAheadBy(lastCatchupForSettle.hubTip, localNow)
      ) {
        tipMayDiverge = true;
      }
      if (
        lastCatchupForSettle.subscriberCount != null &&
        lastCatchupForSettle.subscriberCount <= 0
      ) {
        tipMayDiverge = true;
      }
    }
    queueMicrotask(() =>
      refreshEvoflowV4Session(key, {
        softIntervalMs: 2_800,
        preferSettleOnly: !tipMayDiverge,
      }),
    );
    logV4Life({
      event: "switch_back_catchup",
      threadId: sessionId,
      zh: tipMayDiverge
        ? "切回会话：tip/订户可能分叉，catchup 对账（允许 client-stale/behind recovery）。"
        : "切回会话：缓存快照可能已冻结（非 live），settle-only catchup 校准（不 wipe）。",
      detail: {
        rowCount,
        storeStatus: st.status,
        preferSettleOnly: !tipMayDiverge,
      },
      skipDedupe: true,
    });
  }, [foreground, enabled, sessionId, lease, layer]);

  // AG-UI 在跑但 V4 帧/对账静默：每 ~4s 强制 soft catchup（不 preferSettleOnly）。
  // 现场：乐观泡「工作中」+ streamMax=∅ + hub 订户 0，切回 skip 把恢复堵死。
  useEffect(() => {
    if (!foreground || !enabled || !sessionId) return;
    const tid = String(sessionId);
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      try {
        const storeForWatch =
          (lease && lease.sessionId === sessionId ? lease.store : null) ||
          layer.peekStore(sessionId);
        if (!storeForWatch) return;
        const st = storeForWatch.getState();
        if (st.status !== "live" || !st.subscriptionId) return;
        const sessionKey = _pinSessionKeyByThread.get(tid) || tid;
        const rt = getSessionRuntime(sessionKey);
        const executing =
          getV4TimelineBusy(sessionKey) ||
          isSessionExecuting(sessionKey) ||
          isTurnBusy(rt) ||
          isLivePostStreamOpen(rt);
        const win = st.snapshot?.rows?.window ?? [];
        const hasLiveRow = win.some((r) => {
          const state = String((r as { state?: string }).state || "");
          const status = String((r as { status?: string }).status || "");
          return (
            state === "streaming" ||
            state.startsWith("running") ||
            status === "running" ||
            status === "executing"
          );
        });
        const last = _catchupStableAt.get(tid);
        const hubSubsZero =
          last?.subscriberCount != null && last.subscriberCount <= 0;
        const neverCaughtUp = !last;
        const tipN = Number(win.length ? win[win.length - 1]?.rowId : 0);
        const localTip = Number.isFinite(tipN) && tipN > 0 ? tipN : null;
        const tipGhost = tipAheadBy(localTip, last?.hubTip);
        const tipLag = tipAheadBy(last?.hubTip, localTip);
        // 健康：有直播行且 hub 有订户、无明显 tip 分叉 → 不打扰。
        if (hasLiveRow && !hubSubsZero && !tipGhost && !tipLag) return;
        // 冷闲且已对账过 → 不打扰。
        if (!executing && !hubSubsZero && !neverCaughtUp && !tipGhost && !tipLag) {
          return;
        }
        refreshEvoflowV4Session(tid, {
          softIntervalMs: 3_500,
          preferSettleOnly: false,
        });
      } catch {
        /* best effort */
      }
    };
    const id = window.setInterval(tick, 4_000);
    queueMicrotask(tick);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [foreground, enabled, sessionId, lease, layer]);

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

  const onAutoBackfill = useMemo(
    () => async () => {
      await store?.autoBackfillForRestore();
    },
    [store],
  );

  const onFollowingTip = useMemo(
    () => () => {
      try {
        store?.releaseBalloonForFollowingTip();
      } catch {
        /* best-effort */
      }
    },
    [store],
  );

  const liveSnapshot: ConversationSnapshot | null = state?.snapshot ?? null;
  // 磁盘缓存 → sticky：从未打开 / keep-warm 过期后仍能先画。
  const [diskSticky, setDiskSticky] = useState<ConversationSnapshot | null>(null);
  useEffect(() => {
    if (!sessionId || liveSnapshot) {
      setDiskSticky(null);
      return;
    }
    let cancelled = false;
    void loadV4SnapshotDiskCache(sessionId).then((snap) => {
      if (cancelled || !snap) return;
      _rememberStickySnapshot(sessionId, snap);
      setDiskSticky(snap);
      logV4Life({
        event: "open_disk_cache_hit",
        threadId: sessionId,
        zh: `磁盘投影缓存命中（行≈${snap.rows?.window?.length ?? 0}）→ 冷开可先画再等 subscribe。`,
        detail: {
          rows: snap.rows?.window?.length ?? 0,
          totalCount: snap.rows?.totalCount ?? null,
        },
        skipDedupe: true,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, liveSnapshot]);
  // 刷新 sticky（实例 + 模块级 + 磁盘）：有真快照就记，remount 后仍可先画。
  if (sessionId && liveSnapshot) {
    stickySnapRef.current = {
      sessionId,
      snapshot: liveSnapshot,
      at: Date.now(),
    };
    _rememberStickySnapshot(sessionId, liveSnapshot);
    scheduleV4SnapshotDiskCache(sessionId, liveSnapshot);
  }
  const stickyLocal =
    !liveSnapshot &&
    sessionId &&
    stickySnapRef.current &&
    stickySnapRef.current.sessionId === sessionId &&
    Date.now() - stickySnapRef.current.at <= STICKY_SNAPSHOT_MS
      ? stickySnapRef.current.snapshot
      : null;
  const sticky =
    stickyLocal ||
    (!liveSnapshot && sessionId ? _peekStickySnapshot(sessionId) : null) ||
    (!liveSnapshot ? diskSticky : null);
  const snapshot: ConversationSnapshot | null = liveSnapshot ?? sticky;
  const usedStickyPaint = !liveSnapshot && !!sticky;
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
  // 只依赖 hasSnapshot 布尔，禁止依赖 snapshot 对象引用——流式每帧新引用会
  // 触发 cleanup(−1)+setup(+1)，并在 layout 里和 SyncV4TimelineBusy / useSyncExternalStore
  // 叠成 React #185（Maximum update depth）→ 整页空白。
  const hasSnapshot = !!snapshot;
  const authorityRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    // 仅前台 host 持有 display authority；后台 KeepAlive 有快照也不抢闸门。
    const live = foreground && enabled && !!sessionId && hasSnapshot;
    const tid = live ? sessionId! : null;
    const prev = authorityRef.current;
    if (prev === tid) return;
    if (prev) publishV4DisplayAuthority({ threadId: prev, live: false });
    if (tid) publishV4DisplayAuthority({ threadId: tid, live: true });
    authorityRef.current = tid;
  }, [enabled, sessionId, hasSnapshot, foreground]);
  // 卸载 / 换会话：只在 session 边界清权威，勿绑 snapshot 引用。
  useLayoutEffect(() => {
    return () => {
      if (authorityRef.current) {
        publishV4DisplayAuthority({ threadId: authorityRef.current, live: false });
        authorityRef.current = null;
      }
    };
  }, [sessionId]);

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
  }, [pathState, sessionId, enabled, hasSnapshot, state?.status, leaseForSession]);

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
    // sticky：peek/lease 都 miss 时仍用同 thread 上一帧快照，避免 connecting 空闪。
    if (!snapshot || !sessionId) return null;
    if (!store && !usedStickyPaint) return null;
    return {
      sessionId,
      snapshot,
      status: usedStickyPaint ? "connecting" : status,
      loadingOlder: usedStickyPaint ? false : loadingOlder,
      onLoadOlder,
      onAutoBackfill,
      onFollowingTip,
    };
  }, [
    sessionId,
    snapshot,
    status,
    loadingOlder,
    onLoadOlder,
    onAutoBackfill,
    onFollowingTip,
    store,
    usedStickyPaint,
  ]);

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
