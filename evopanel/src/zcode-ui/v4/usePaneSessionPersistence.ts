// pane ↔ session 绑定的本地持久化（pane 绑定属 Layout 层本地 UI 态）。
// 动机：旧链路靠 useTaskRestore（已删）
// 恢复选中 task；v4 下 renderer 刷新后 zustand 选择态归零，若不持久化，刷新会把用户
// 踢回 draft pane，正在输出的会话"消失"。CLI/host 进程在 renderer 刷新时继续运行，
// 恢复选择态后 pane 重订阅即可拿到 snapshot+续流。
// 只有同一 renderer reload 的首个 workspace 会恢复；app 冷启动和 workspace-only
// 入口保持草稿，不消费上一次运行留下的 session 绑定。
import { useEffect, useRef } from "react";
import { isRendererReloadNavigation } from "@/lib/rendererNavigation.js";

const STORAGE_PREFIX = "zcode-v4-last-session:v1:";

function storageKey(workspaceKey: string): string {
  return `${STORAGE_PREFIX}${workspaceKey}`;
}

function readPersistedPaneSession(workspaceKey: string): string | null {
  try {
    return localStorage.getItem(storageKey(workspaceKey));
  } catch {
    return null;
  }
}

function persistPaneSession(workspaceKey: string, sessionId: string | null): void {
  try {
    if (sessionId) {
      localStorage.setItem(storageKey(workspaceKey), sessionId);
    } else {
      localStorage.removeItem(storageKey(workspaceKey));
    }
  } catch {
    // 无 storage 环境（测试/隐身）静默降级：刷新恢复不可用，但不影响正常会话。
  }
}

interface UsePaneSessionPersistenceParams {
  workspaceKey: string;
  activeSessionId: string | null;
  /** startDraft 的显式用户意图代次；大于 0 时 null 表示草稿，不是待恢复。 */
  draftFocusVersion: number;
  /** 手机 /remote 不消费 desktop pane 的本地恢复状态。 */
  enabled?: boolean;
  /** 恢复入口：与用户点击任务列表同一条选择路径，保证副作用（已读清理等）一致。 */
  selectSession: (sessionId: string) => void;
}

function shouldRestorePersistedPaneSession(params: {
  activeSessionId: string | null;
  draftFocusVersion: number;
  enabled: boolean;
  rendererReload: boolean;
}): boolean {
  return (
    params.enabled &&
    params.rendererReload &&
    params.activeSessionId === null &&
    params.draftFocusVersion === 0
  );
}

/**
 * 挂载时恢复上次绑定的 session；此后跟随选择态写入/清除。
 * 只在每个 workspaceKey 首次挂载时恢复一次——用户显式回到 draft（新任务）
 * 属于选择变化，会把持久化键清掉，不会被反复拉回旧会话。
 */
export function usePaneSessionPersistence({
  workspaceKey,
  activeSessionId,
  draftFocusVersion,
  enabled = true,
  selectSession,
}: UsePaneSessionPersistenceParams): void {
  const restoredKeysRef = useRef<Set<string>>(new Set());
  // 只有 reload 后首个 workspace 可以消费刷新前的 pane 绑定；之后打开其它
  // workspace 仍是 workspace-only 入口，必须进入草稿，不能逐个恢复旧 session。
  const rendererReloadRestoreAvailableRef = useRef(isRendererReloadNavigation());
  const pendingRestoreRef = useRef<{
    workspaceKey: string;
    sessionId: string;
  } | null>(null);
  const selectSessionRef = useRef(selectSession);
  selectSessionRef.current = selectSession;

  useEffect(() => {
    if (!enabled) return;
    if (restoredKeysRef.current.has(workspaceKey)) return;
    restoredKeysRef.current.add(workspaceKey);
    const rendererReload = rendererReloadRestoreAvailableRef.current;
    rendererReloadRestoreAvailableRef.current = false;
    if (
      !shouldRestorePersistedPaneSession({
        activeSessionId,
        draftFocusVersion,
        enabled,
        rendererReload,
      })
    ) {
      // 冷启动和 workspace-only 入口都必须是草稿。旧 last-session
      // 即使来自上次 app 运行，也不能在本次挂载反写 activeTaskId。
      if (activeSessionId === null) {
        persistPaneSession(workspaceKey, null);
      }
      return;
    }
    const stored = readPersistedPaneSession(workspaceKey);
    if (stored) {
      pendingRestoreRef.current = { workspaceKey, sessionId: stored };
      selectSessionRef.current(stored);
    }
    // activeSessionId/draftFocusVersion 故意不进依赖：恢复只看 workspace 首次挂载瞬间，
    // 之后的显式新建与选择变化走下面的持久化 effect。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, workspaceKey]);

  useEffect(() => {
    if (!enabled) return;
    // 恢复完成前不要把初始 null 写进去（会覆盖掉待恢复的值）。
    if (!restoredKeysRef.current.has(workspaceKey)) return;
    const pendingRestore = pendingRestoreRef.current;
    if (pendingRestore?.workspaceKey === workspaceKey) {
      if (activeSessionId === null) {
        return;
      }
      // 恢复 effect 和持久化 effect 属于同一次 commit，后者闭包仍可能
      // 读到恢复前的 null。等选择态真正回填后再允许写，避免先删掉 reload 恢复键。
      pendingRestoreRef.current = null;
    }
    persistPaneSession(workspaceKey, activeSessionId);
  }, [activeSessionId, enabled, workspaceKey]);
}
