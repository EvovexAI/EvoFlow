import { create } from "zustand";
import type { RemoteTarget } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { remoteAgentServiceGeneration } from "@/lib/remoteAgentServiceGeneration.js";
import { createRemoteWorkspaceDisconnectedError } from "@/lib/remoteWorkspaceServiceError.js";

export interface RemoteWorkspaceSession {
  sessionId: string;
  target?: RemoteTarget;
  services: IServiceAccessor;
  dispose?: (reason?: Error) => void;
}

interface RemoteWorkspaceSessionState {
  baseServices: IServiceAccessor | null;
  sessionsById: Record<string, RemoteWorkspaceSession>;
  sessionIdByWorkspacePath: Record<string, string>;
  // 之前只按 workspacePath 建索引，同路径不同远端会互相覆盖。
  // 这里补充 workspaceIdentity -> session 的映射，保证远程会话按“主机+路径”唯一绑定。
  sessionIdByWorkspaceIdentity: Record<string, string>;
  registerBaseServices: (services: IServiceAccessor) => void;
  registerSession: (session: RemoteWorkspaceSession) => void;
  unregisterSession: (sessionId: string) => void;
  bindWorkspacePath: (workspacePath: string, sessionId: string) => void;
  unbindWorkspacePath: (workspacePath: string) => void;
  bindWorkspaceIdentity: (workspaceIdentity: string, sessionId: string) => void;
  unbindWorkspaceIdentity: (workspaceIdentity: string) => void;
}

export const useRemoteWorkspaceSessionStore = create<RemoteWorkspaceSessionState>()((set) => ({
  baseServices: null,
  sessionsById: {},
  sessionIdByWorkspacePath: {},
  sessionIdByWorkspaceIdentity: {},
  registerBaseServices: (services) =>
    set({
      baseServices: services,
    }),
  registerSession: (session) =>
    set((state) => ({
      sessionsById: {
        ...state.sessionsById,
        [session.sessionId]: session,
      },
    })),
  unregisterSession: (sessionId) =>
    set((state) => {
      const nextSessionsById = { ...state.sessionsById };
      delete nextSessionsById[sessionId];

      const nextSessionIdByWorkspacePath = Object.fromEntries(
        Object.entries(state.sessionIdByWorkspacePath).filter(
          ([, currentSessionId]) => currentSessionId !== sessionId,
        ),
      );

      const nextSessionIdByWorkspaceIdentity = Object.fromEntries(
        Object.entries(state.sessionIdByWorkspaceIdentity).filter(
          ([, currentSessionId]) => currentSessionId !== sessionId,
        ),
      );

      return {
        sessionsById: nextSessionsById,
        sessionIdByWorkspacePath: nextSessionIdByWorkspacePath,
        sessionIdByWorkspaceIdentity: nextSessionIdByWorkspaceIdentity,
      };
    }),
  bindWorkspacePath: (workspacePath, sessionId) =>
    set((state) => ({
      sessionIdByWorkspacePath: {
        ...state.sessionIdByWorkspacePath,
        [workspacePath]: sessionId,
      },
    })),
  unbindWorkspacePath: (workspacePath) =>
    set((state) => {
      if (!(workspacePath in state.sessionIdByWorkspacePath)) {
        return state;
      }

      const nextSessionIdByWorkspacePath = {
        ...state.sessionIdByWorkspacePath,
      };
      delete nextSessionIdByWorkspacePath[workspacePath];

      return {
        ...state,
        sessionIdByWorkspacePath: nextSessionIdByWorkspacePath,
      };
    }),
  bindWorkspaceIdentity: (workspaceIdentity, sessionId) =>
    set((state) => ({
      sessionIdByWorkspaceIdentity: {
        ...state.sessionIdByWorkspaceIdentity,
        [workspaceIdentity]: sessionId,
      },
    })),
  unbindWorkspaceIdentity: (workspaceIdentity) =>
    set((state) => {
      if (!(workspaceIdentity in state.sessionIdByWorkspaceIdentity)) {
        return state;
      }

      const nextSessionIdByWorkspaceIdentity = {
        ...state.sessionIdByWorkspaceIdentity,
      };
      delete nextSessionIdByWorkspaceIdentity[workspaceIdentity];

      return {
        ...state,
        sessionIdByWorkspaceIdentity: nextSessionIdByWorkspaceIdentity,
      };
    }),
}));

export function registerRemoteWorkspaceSession(session: RemoteWorkspaceSession): void {
  // 同一 remoteSessionId 的 proxy 可连续换代，而不同 React consumer 的 effect
  // 提交顺序不可靠。session 注册是权威换代顺序，先在共享 generation 模块预分配
  // 单调代际，避免迟到的中间 proxy 把 transport 从最新代切回去。
  // Web/测试降级 accessor 可能暂未提供 agent transport；真正可订阅时 registry 仍会
  // 按首次观察分配 generation，不能为了预注册破坏这种兼容形态。
  if (session.services.zcodeAgentService) {
    remoteAgentServiceGeneration(session.services.zcodeAgentService);
  }
  const previousSession = useRemoteWorkspaceSessionStore.getState().sessionsById[session.sessionId];
  if (previousSession && previousSession !== session) {
    // 同一 remoteSessionId 的 attachment 换代时，旧 MessagePort 仍可能有挂起 RPC。
    // 先终结旧 transport，确保 provider sync 的 in-flight Promise 不会跨代永久悬置。
    previousSession.dispose?.(createRemoteWorkspaceDisconnectedError());
  }
  useRemoteWorkspaceSessionStore.getState().registerSession(session);
}

export function registerBaseWorkspaceServices(services: IServiceAccessor): void {
  useRemoteWorkspaceSessionStore.getState().registerBaseServices(services);
}

export function unregisterRemoteWorkspaceSession(sessionId: string): void {
  const session = useRemoteWorkspaceSessionStore.getState().sessionsById[sessionId];
  useRemoteWorkspaceSessionStore.getState().unregisterSession(sessionId);
  // 同步可能发生在 workspace bind 之前，无法仅靠索引清理 in-flight。
  // 注入的 disposer 直接终结 attachment，使 ChannelClient 将挂起 RPC fail-closed。
  session?.dispose?.(createRemoteWorkspaceDisconnectedError());
}

export function bindRemoteWorkspacePath(workspacePath: string, sessionId: string): void {
  useRemoteWorkspaceSessionStore.getState().bindWorkspacePath(workspacePath, sessionId);
}

export function unbindRemoteWorkspacePath(workspacePath: string): void {
  useRemoteWorkspaceSessionStore.getState().unbindWorkspacePath(workspacePath);
}

export function bindRemoteWorkspaceIdentity(workspaceIdentity: string, sessionId: string): void {
  useRemoteWorkspaceSessionStore.getState().bindWorkspaceIdentity(workspaceIdentity, sessionId);
}

export function unbindRemoteWorkspaceIdentity(workspaceIdentity: string): void {
  useRemoteWorkspaceSessionStore.getState().unbindWorkspaceIdentity(workspaceIdentity);
}

export function getRemoteWorkspaceSession(sessionId: string): RemoteWorkspaceSession | null {
  return useRemoteWorkspaceSessionStore.getState().sessionsById[sessionId] ?? null;
}

/** 当前在册代理的远程 session 身份；旧代代理不匹配，仅用于 scope 诊断。 */
export function findRemoteWorkspaceSessionIdForAgentService(agentService: object): string | null {
  for (const session of Object.values(useRemoteWorkspaceSessionStore.getState().sessionsById)) {
    if (session.services.zcodeAgentService === agentService) {
      return session.sessionId;
    }
  }
  return null;
}

export function getRemoteWorkspaceServicesForPath(workspacePath: string): IServiceAccessor | null {
  const state = useRemoteWorkspaceSessionStore.getState();
  const sessionId = state.sessionIdByWorkspacePath[workspacePath];
  if (!sessionId) {
    return null;
  }

  return state.sessionsById[sessionId]?.services ?? null;
}

export function getRemoteWorkspaceServicesForIdentity(
  workspaceIdentity: string,
): IServiceAccessor | null {
  const state = useRemoteWorkspaceSessionStore.getState();
  const sessionId = state.sessionIdByWorkspaceIdentity[workspaceIdentity];
  if (!sessionId) {
    return null;
  }

  return state.sessionsById[sessionId]?.services ?? null;
}

export function getRegisteredBaseWorkspaceServices(): IServiceAccessor | null {
  return useRemoteWorkspaceSessionStore.getState().baseServices;
}

export function resolveRegisteredWorkspaceServices(params: {
  workspacePath?: string;
  workspaceIdentity?: string;
}): IServiceAccessor | null {
  if (params.workspaceIdentity?.trim()) {
    return (
      getRemoteWorkspaceServicesForIdentity(params.workspaceIdentity) ??
      getRegisteredBaseWorkspaceServices()
    );
  }

  if (params.workspacePath?.trim()) {
    return (
      getRemoteWorkspaceServicesForPath(params.workspacePath) ??
      getRegisteredBaseWorkspaceServices()
    );
  }

  return getRegisteredBaseWorkspaceServices();
}
