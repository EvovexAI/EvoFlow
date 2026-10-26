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
import { publishV4DisplayAuthority } from "./v4Gate.js";

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

/**
 * 悬停预热限流：每个未命中快照的预热 = 一条完整 V4 快照订阅（单帧 370–854KB，
 * 主线程 JSON.parse）。鼠标扫过会话列表会连续触发，实测一次滑过 8+ 会话可在
 * 1s 内产生 ~4MB 解析导致整窗卡死（2026-10-27 00:44 复现）。
 * 命中已有快照的预热零成本，不受限；冷启动订阅按滑动窗口限量 + 总数封顶。
 */
const WARM_COLD_WINDOW_MS = 3_000;
const WARM_COLD_MAX_PER_WINDOW = 2;
const WARM_MAX_LIVE_SESSIONS = 6;
let _warmColdTimestamps: number[] = [];

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
      _warmColdTimestamps.push(now);
    }
    const lease = layer.acquire(id);
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
    const acquired = layer.acquire(sessionId);
    const st = acquired.store.getState();
    const hasSnap = Boolean(st.snapshot);
    const rowCount =
      st.snapshot?.rows?.totalCount ?? st.snapshot?.rows?.window?.length ?? 0;
    const since = v4OpenSinceClickMs({ threadId: sessionId });
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
    setLease(acquired);
    return () => {
      acquired.release();
      setLease(null);
    };
  }, [layer, enabled, sessionId]);

  // sessionId 已变但 effect 尚未提交时，绝不能读上一会话的 store（会 ready 错配 → 误 hold 老面板）。
  const leaseForSession =
    lease && sessionId && lease.sessionId === sessionId ? lease : null;
  const store = leaseForSession?.store ?? null;
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

  // connecting 每秒打进度；满 5s 再 warn + recovery（与发消息触发的自愈同路径）。
  useLayoutEffect(() => {
    if (pathState !== "v4-connecting" || !sessionId) return;
    const started = connectingSinceRef.current || Date.now();
    connectingSinceRef.current = started;
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
      try {
        if (!st?.snapshot) {
          if (st?.subscriptionId) {
            store?.recoverFromStaleAuthority();
          } else if (sessionId) {
            // store=error 且无 subscription：re-acquire 走 keep-warm 再试一次
            // （用户正在看的会话，绕过预热限流）
            warmEvoflowV4Session(sessionId, { force: true });
          }
        }
      } catch {
        /* best-effort */
      }
    }, 5_000);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(stuck);
    };
  }, [pathState, sessionId, state?.status, leaseForSession, store]);

  const status = state?.status ?? "connecting";
  const loadingOlder = state?.loadingOlder ?? false;
  const payload = useMemo<V4TimelinePayload | null>(() => {
    if (!snapshot || !sessionId || !leaseForSession) return null;
    return {
      sessionId,
      snapshot,
      status,
      loadingOlder,
      onLoadOlder,
    };
  }, [sessionId, snapshot, status, loadingOlder, onLoadOlder, leaseForSession]);

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
