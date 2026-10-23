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
  | "ready";

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
 * 悬停预热：acquire → 立刻 release，让 SessionDataLayer 进 keep-warm（默认 30s）。
 * 点击时再次 acquire 可命中已订阅/已有快照，避免「本地 history 已到、V4 还冷」闪老面板。
 */
export function warmEvoflowV4Session(sessionId: string): void {
  const id = String(sessionId || "").trim();
  if (!id) return;
  try {
    const lease = getSharedLayer().acquire(id);
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
    const acquired = layer.acquire(sessionId);
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
  const pathState = !enabled
    ? "legacy:off"
    : !sessionId
      ? "legacy:no-thread"
      : snapshot
        ? "v4"
        : "v4-connecting";
  const lastPathLogRef = useRef("");
  useLayoutEffect(() => {
    const key = `${pathState}:${sessionId ?? ""}`;
    if (lastPathLogRef.current === key) return;
    lastPathLogRef.current = key;
    if (pathState === "v4") {
      console.info(
        `%c[v4-path] ★ 显示数据源 = V4 帧管线 → ZCode ConversationTimeline（GET /api/v4/conversation/frames）sessionId=${sessionId}`,
        "color:#2563eb;font-weight:bold",
      );
    } else if (pathState === "v4-connecting") {
      console.info(
        `%c[v4-path] V4 已订阅，等首帧快照中（session=${sessionId}）——不回落老面板`,
        "color:#9333ea;font-weight:bold",
      );
    } else {
      const reason = !enabled ? "V4 开关关闭" : "会话尚无 threadId";
      console.info(
        `%c[v4-path] 显示数据源 = 老链路（AG-UI SSE）——${reason}`,
        "color:#ca8a04;font-weight:bold",
      );
    }
  }, [pathState, sessionId, enabled]);

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
  // 有 threadId 即锁定 V4；租约未对齐或尚无快照 → connecting（调用方勿回落字墙老面板）。
  return children(payload, payload ? "ready" : "connecting");
}
