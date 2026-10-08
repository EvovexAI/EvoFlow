import type { IServiceAccessor } from "@zcode/services";
import { createUuid } from "@zcode/shared";

export interface TerminalSessionDescriptor {
  id: string;
  workspaceKey: string;
  services: IServiceAccessor;
  cwd?: string;
  index: number;
  shellLabel: string | null;
}

export interface TerminalWorkspaceState {
  sessionIds: string[];
  activeSessionId: string;
}

export interface TerminalPanelState {
  sessions: Record<string, TerminalSessionDescriptor>;
  workspaces: Record<string, TerminalWorkspaceState>;
}

export function createTerminalSession(params: {
  workspaceKey: string;
  services: IServiceAccessor;
  cwd?: string;
  index: number;
}): TerminalSessionDescriptor {
  return {
    id: createUuid(),
    workspaceKey: params.workspaceKey,
    services: params.services,
    cwd: params.cwd,
    index: params.index,
    shellLabel: null,
  };
}

export function createWorkspaceTerminalState(params: {
  workspaceKey: string;
  services: IServiceAccessor;
  cwd?: string;
}): {
  session: TerminalSessionDescriptor;
  workspace: TerminalWorkspaceState;
} {
  const session = createTerminalSession({
    workspaceKey: params.workspaceKey,
    services: params.services,
    cwd: params.cwd,
    index: 1,
  });

  return {
    session,
    workspace: {
      sessionIds: [session.id],
      activeSessionId: session.id,
    },
  };
}

export function getNextTerminalSessionIndex(
  state: TerminalPanelState,
  workspaceKey: string,
): number {
  const workspace = state.workspaces[workspaceKey];
  const usedIndices = new Set(
    workspace?.sessionIds
      .map((sessionId) => state.sessions[sessionId]?.index)
      .filter((index): index is number => typeof index === "number") ?? [],
  );

  // 把 nextIndex 作为只增不减的派生状态保存，会让关闭编号 2 后再新建错误地得到 3。
  // 编号事实已经存在于 session descriptor 中，创建时从现存 session 推导最小空位，避免两份状态漂移。
  for (let index = 1; ; index += 1) {
    if (!usedIndices.has(index)) {
      return index;
    }
  }
}

export function formatTerminalTabTitle(projectName: string, index: number): string {
  return index === 1 ? projectName : `${projectName} ${index}`;
}

type TerminalSessionCloseAction = "none" | "close-panel" | "close-session";

interface TerminalSessionExitResult {
  state: TerminalPanelState;
  action: TerminalSessionCloseAction;
}

export function getTerminalSessionCloseAction(
  state: TerminalPanelState,
  sessionId: string,
): TerminalSessionCloseAction {
  const session = state.sessions[sessionId];
  const workspace = session ? state.workspaces[session.workspaceKey] : undefined;
  if (!session || !workspace?.sessionIds.includes(sessionId)) {
    return "none";
  }

  return workspace.sessionIds.length === 1 ? "close-panel" : "close-session";
}

export function closeTerminalSession(
  state: TerminalPanelState,
  sessionId: string,
): TerminalPanelState {
  if (getTerminalSessionCloseAction(state, sessionId) !== "close-session") {
    return state;
  }

  const session = state.sessions[sessionId];
  const workspace = session ? state.workspaces[session.workspaceKey] : undefined;
  if (!session || !workspace) {
    return state;
  }

  const closingIndex = workspace.sessionIds.indexOf(sessionId);
  const nextSessionIds = workspace.sessionIds.filter((id) => id !== sessionId);
  const fallbackSessionId = nextSessionIds[Math.max(0, closingIndex - 1)] ?? nextSessionIds[0];
  if (!fallbackSessionId) {
    return state;
  }

  const { [sessionId]: _closedSession, ...nextSessions } = state.sessions;
  return {
    sessions: nextSessions,
    workspaces: {
      ...state.workspaces,
      [session.workspaceKey]: {
        sessionIds: nextSessionIds,
        activeSessionId:
          workspace.activeSessionId === sessionId ? fallbackSessionId : workspace.activeSessionId,
      },
    },
  };
}

export function exitTerminalSession(
  state: TerminalPanelState,
  sessionId: string,
  activeWorkspaceKey: string,
): TerminalSessionExitResult {
  const session = state.sessions[sessionId];
  const workspace = session ? state.workspaces[session.workspaceKey] : undefined;
  if (!session || !workspace?.sessionIds.includes(sessionId)) {
    return { state, action: "none" };
  }

  if (workspace.sessionIds.length > 1) {
    return {
      state: closeTerminalSession(state, sessionId),
      action: "close-session",
    };
  }

  // PTY 自身已经退出时，最后一个 tab 不能像手动关闭那样只收起面板并保活。
  // 这里同时删除 session/workspace 记录；重新打开该 workspace 时再由 ensure 懒创建新 PTY。
  const { [sessionId]: _exitedSession, ...nextSessions } = state.sessions;
  const { [session.workspaceKey]: _exitedWorkspace, ...nextWorkspaces } = state.workspaces;
  return {
    state: {
      sessions: nextSessions,
      workspaces: nextWorkspaces,
    },
    action: session.workspaceKey === activeWorkspaceKey ? "close-panel" : "close-session",
  };
}

export function ensureWorkspaceTerminalState(
  state: TerminalPanelState,
  params: {
    workspaceKey: string;
    services: IServiceAccessor;
    cwd?: string;
  },
): TerminalPanelState {
  const existingWorkspace = state.workspaces[params.workspaceKey];
  if (existingWorkspace?.sessionIds.some((sessionId) => state.sessions[sessionId])) {
    return state;
  }

  const { session, workspace } = createWorkspaceTerminalState(params);
  return {
    sessions: {
      ...state.sessions,
      [session.id]: session,
    },
    workspaces: {
      ...state.workspaces,
      [params.workspaceKey]: workspace,
    },
  };
}
