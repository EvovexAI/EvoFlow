// V4StreamRowsBridge — 把 V4 投影订阅收在叶子桥组件里，frame 更新只重渲染
// children 子树，不牵动 ChatApp 控制器（对齐老架构"流式期间控制器不重渲染"）。
//
// - 协议客户端：vendor 树的 SessionDataLayer + ConversationProjectionStore
//   （无 UI 数据层，语义 = ZCode v4：snapshot 整体替换 / fromSeq 衔接 / 断档不猜）。
// - 渲染：render-prop 交付**协议原生快照**（rows.window 原样），由
//   V4ZCodeTimeline（ZCode ConversationTimeline）渲染——行视图/时间线/贴底
//   全部是 ZCode 显示区域的正式实现，不经过任何行适配。
// - payload = null：V4 未就绪（开关关闭/会话无 threadId/订阅中），调用方回落老链路。
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
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

export function V4StreamRowsBridge(props: {
  /** v4 session id = LangGraph threadId。 */
  sessionId: string | null;
  enabled: boolean;
  children: (payload: V4TimelinePayload | null, phase: V4BridgePhase) => ReactNode;
}): ReactNode {
  const { sessionId, enabled, children } = props;
  const layer = useMemo(() => getSharedLayer(), []);
  const [lease, setLease] = useState<SessionLease | null>(null);

  useEffect(() => {
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

  const store = lease?.store ?? null;
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

  // 显示数据源宣告：状态切换时打一条，让人一眼看清"现在以哪个为准"。
  const snapshot: ConversationSnapshot | null = state?.snapshot ?? null;
  const pathState = !enabled
    ? "legacy:off"
    : !sessionId
      ? "legacy:no-thread"
      : snapshot
        ? "v4"
        : "v4-connecting";
  const lastPathLogRef = useRef("");
  useEffect(() => {
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
        `%c[v4-path] V4 已订阅，等首帧快照中（session=${sessionId}）——到达前回落老链路`,
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

  // 稳定 payload 引用：store 同快照重复 notify 时不给 timeline 换新对象。
  const status = state?.status ?? "connecting";
  const loadingOlder = state?.loadingOlder ?? false;
  const payload = useMemo<V4TimelinePayload | null>(() => {
    if (!snapshot || !sessionId) return null;
    return {
      sessionId,
      snapshot,
      status,
      loadingOlder,
      onLoadOlder,
    };
  }, [sessionId, snapshot, status, loadingOlder, onLoadOlder]);

  if (!enabled || !sessionId) {
    return children(null, !enabled ? "disabled" : "no-thread");
  }
  // 有 threadId 即锁定 V4 渲染（connecting 阶段由调用方渲染空态，不回落老链路）。
  return children(payload, snapshot ? "ready" : "connecting");
}
