/**
 * V4ChatHostStack — 对齐 ZCode V4WorkspaceChatArea / SessionPane 的 focused×visible 分离
 * + 可选双栏分屏。
 *
 * - 单槽：当前选中可见，其余 KeepAlive 隐藏挂载（+ linger）。
 *   隐藏用 styles-bridge 对 host+* 强制 visibility:hidden（保留几何测高）；
 *   不用 display:none（virtualizer 估高被压成 72 → 叠字 + sticky 输入飘顶）。
 * - 双栏：`secondaryThreadId` 与主选并排可见（ZCode split leaf 仍 layout-visible；
 *   focused 只影响 composer/快捷键，对齐 SessionPane.focused vs telemetryVisible）。
 * - 单栏 composer：由 chat-app-view 挂在 HostStack 外稳定槽（ZCode 每 pane 自带
 *   bottomDock；EvoFlow 单栏共用一个 portal，避免切 host 时 sticky 重挂）。
 */
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  V4StreamRowsBridge,
  type V4BridgePhase,
  type V4PinTarget,
  type V4TimelinePayload,
} from "./V4StreamRowsBridge.js";
import { resolveRendererMemoryLevel } from "../lib/renderer-memory-pressure.js";
import {
  dumpV4ChatLayout,
  installV4ChatLayoutDumpGlobal,
} from "./v4-chat-layout-dump.js";

/** 与 SessionDataLayer keepWarmMs 同量级：pin 列表挤掉后仍短暂保 UI 挂载。 */
const HOST_LINGER_MS = 120_000;
/** 额外 linger 路上限；high=1、critical=0，避免隐藏 host 把 heap 顶穿。 */
const HOST_LINGER_MAX = 4;

export type V4ChatHostRenderCtx = {
  threadId: string | null;
  hostSessionKey: string;
  /** 布局上可见（主栏或分屏副栏） */
  visible: boolean;
  /** 焦点栏：composer / focus / catchup / authority */
  focused: boolean;
  payload: V4TimelinePayload | null;
  phase: V4BridgePhase;
};

function normalizeHosts(
  activeThreadId: string | null,
  secondaryThreadId: string | null,
  hosts: readonly V4PinTarget[],
): Array<{ threadId: string; sessionKey: string }> {
  const out: Array<{ threadId: string; sessionKey: string }> = [];
  const seen = new Set<string>();
  const push = (threadId: string, sessionKey: string) => {
    const id = String(threadId || "").trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ threadId: id, sessionKey: String(sessionKey || "").trim() });
  };
  const active = String(activeThreadId || "").trim();
  const secondary = String(secondaryThreadId || "").trim();
  if (active) {
    const hit = hosts.find((h) => String(h.threadId || "").trim() === active);
    push(active, String(hit?.sessionKey || "").trim());
  }
  if (secondary && secondary !== active) {
    const hit = hosts.find((h) => String(h.threadId || "").trim() === secondary);
    push(secondary, String(hit?.sessionKey || "").trim());
  }
  for (const h of hosts) {
    push(String(h.threadId || "").trim(), String(h.sessionKey || "").trim());
  }
  return out;
}

export function V4ChatHostStack(props: {
  enabled: boolean;
  activeThreadId: string | null;
  /** 双栏分屏右侧 thread（与 ZCode split leaf 对齐的最小面）。 */
  secondaryThreadId?: string | null;
  /** 与 syncEvoflowV4PinnedSessions 同一组：selected + executing + recent */
  hosts: readonly V4PinTarget[];
  children: (ctx: V4ChatHostRenderCtx) => ReactNode;
  /** 关闭分屏副栏（可选 UI）。 */
  onCloseSecondary?: () => void;
}): ReactNode {
  const {
    enabled,
    activeThreadId,
    secondaryThreadId = null,
    hosts,
    children,
    onCloseSecondary,
  } = props;
  const active = String(activeThreadId || "").trim() || null;
  const secondary = String(secondaryThreadId || "").trim() || null;
  const splitMode = !!(secondary && active && secondary !== active);
  const desired = useMemo(
    () => normalizeHosts(active, secondary, hosts),
    [active, secondary, hosts],
  );
  const desiredIds = useMemo(
    () => desired.map((h) => h.threadId),
    [desired],
  );
  const lingerTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const lingerSessionKeyRef = useRef(new Map<string, string>());
  const sessionKeyByThread = useMemo(() => {
    const m = new Map<string, string>();
    for (const [id, sk] of lingerSessionKeyRef.current) {
      if (sk) m.set(id, sk);
    }
    for (const h of desired) {
      if (h.sessionKey) m.set(h.threadId, h.sessionKey);
      lingerSessionKeyRef.current.set(h.threadId, h.sessionKey);
    }
    return m;
  }, [desired]);

  const [mountedIds, setMountedIds] = useState<string[]>(desiredIds);
  useLayoutEffect(() => {
    const desiredSet = new Set(desiredIds);
    for (const id of desiredIds) {
      const t = lingerTimersRef.current.get(id);
      if (t != null) {
        clearTimeout(t);
        lingerTimersRef.current.delete(id);
      }
    }
    setMountedIds((prev) => {
      const next: string[] = [];
      const seen = new Set<string>();
      for (const id of desiredIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        next.push(id);
      }
      const lingerCandidates: string[] = [];
      for (const id of prev) {
        if (seen.has(id) || desiredSet.has(id)) continue;
        lingerCandidates.push(id);
      }
      const memLevel = resolveRendererMemoryLevel();
      const lingerMax =
        memLevel === "critical" ? 0 : memLevel === "high" ? 1 : HOST_LINGER_MAX;
      const keepLinger = lingerCandidates.slice(-lingerMax);
      const keepLingerSet = new Set(keepLinger);
      for (const id of lingerCandidates) {
        if (keepLingerSet.has(id)) continue;
        const t = lingerTimersRef.current.get(id);
        if (t != null) clearTimeout(t);
        lingerTimersRef.current.delete(id);
        lingerSessionKeyRef.current.delete(id);
      }
      for (const id of keepLinger) {
        if (!lingerTimersRef.current.has(id)) {
          lingerTimersRef.current.set(
            id,
            setTimeout(() => {
              lingerTimersRef.current.delete(id);
              lingerSessionKeyRef.current.delete(id);
              setMountedIds((cur) =>
                cur.includes(id) ? cur.filter((x) => x !== id) : cur,
              );
            }, HOST_LINGER_MS),
          );
        }
        seen.add(id);
        next.push(id);
      }
      if (
        next.length === prev.length &&
        next.every((id, i) => id === prev[i])
      ) {
        return prev;
      }
      return next;
    });
  }, [desiredIds]);

  useLayoutEffect(() => {
    return () => {
      for (const t of lingerTimersRef.current.values()) clearTimeout(t);
      lingerTimersRef.current.clear();
    };
  }, []);

  useLayoutEffect(() => {
    installV4ChatLayoutDumpGlobal();
  }, []);

  // 切会话后采一帧排版快照（叠字时 frontend 日志会出现 !STACK）。
  useLayoutEffect(() => {
    if (!enabled || !active) return;
    const t = window.setTimeout(() => {
      dumpV4ChatLayout(`host-stack active=${active.slice(0, 8)} n=${mountedIds.length}`);
    }, 80);
    return () => window.clearTimeout(t);
  }, [enabled, active, mountedIds, secondary, splitMode]);

  if (!enabled) {
    return (
      <>
        {children({
          threadId: active,
          hostSessionKey: "",
          visible: true,
          focused: true,
          payload: null,
          phase: "disabled",
        })}
      </>
    );
  }

  if (!active) {
    return (
      <>
        {children({
          threadId: null,
          hostSessionKey: "",
          visible: true,
          focused: true,
          payload: null,
          phase: "no-thread",
        })}
      </>
    );
  }

  const layers = mountedIds.length > 0 ? mountedIds : [active];
  const visibleOrder = splitMode
    ? [active, secondary!].filter((id, i, arr) => arr.indexOf(id) === i)
    : [active];

  return (
    <div
      className={
        splitMode
          ? "flex h-full min-h-0 w-full gap-px bg-border"
          : "relative h-full min-h-0 w-full"
      }
      data-v4-chat-host-stack=""
      data-v4-host-count={layers.length}
      data-v4-split={splitMode ? "1" : "0"}
    >
      {layers.map((tid) => {
        const focused = tid === active;
        const visible = visibleOrder.includes(tid);
        const isSecondary = splitMode && tid === secondary;
        const hostSessionKey =
          sessionKeyByThread.get(tid) ||
          lingerSessionKeyRef.current.get(tid) ||
          "";
        // 隐藏策略见 styles-bridge `[data-v4-chat-host-visible="0"]`：
        // - 不用 display:none：KeepAlive 隐藏时 virtualizer 会把行高测成 0，再显示时
        //   全部 absolute turn 叠在 translateY(0) →「密密麻麻」。
        // - 不用单层 invisible：子树 visibility:visible（styles-bridge navigator 等）会穿透。
        // CSS 对 host+* 强制 visibility:hidden !important，并保留几何供测高。
        const hostClass = splitMode
          ? visible
            ? "relative flex min-h-0 min-w-0 flex-1 flex-col bg-card"
            : "absolute inset-0 flex min-h-0 flex-col pointer-events-none"
          : "absolute inset-0 flex min-h-0 flex-col";
        return (
          <div
            key={tid}
            data-v4-chat-host={tid}
            data-v4-chat-host-session-key={hostSessionKey || undefined}
            data-v4-chat-host-visible={visible ? "1" : "0"}
            data-v4-chat-host-focused={focused ? "1" : "0"}
            className={hostClass}
            aria-hidden={visible ? undefined : true}
            inert={visible ? undefined : true}
          >
            {isSecondary && onCloseSecondary ? (
              <div className="flex h-7 shrink-0 items-center justify-between border-b border-border px-2 text-[11px] text-foreground-subtlest">
                <span className="truncate">分屏对照</span>
                <button
                  type="button"
                  className="rounded px-1.5 py-0.5 hover:bg-hover hover:text-foreground"
                  onClick={onCloseSecondary}
                >
                  关闭
                </button>
              </div>
            ) : null}
            <div className="min-h-0 flex-1">
              <V4StreamRowsBridge
                enabled
                sessionId={tid}
                foreground={focused}
              >
                {(payload, phase) =>
                  children({
                    threadId: tid,
                    hostSessionKey,
                    visible,
                    focused,
                    payload,
                    phase,
                  })
                }
              </V4StreamRowsBridge>
            </div>
          </div>
        );
      })}
    </div>
  );
}
