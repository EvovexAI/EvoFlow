import type { IServiceAccessor } from "@zcode/services";
import { Event, ProxyChannel, type IChannel } from "@zcode/rpc";
import { useMemo } from "react";
import { useOptionalServices, useServices } from "@/hooks/useServices.js";
import {
  useRemoteWorkspaceSessionStore,
  type RemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import { useResolvedRemoteWorkspaceSessionId } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE } from "@/lib/remoteWorkspaceServiceError.js";

let disconnectedRemoteServices: IServiceAccessor | null = null;

interface WorkspaceServiceTargetTab {
  workspacePath: string;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  remoteTarget?: unknown;
}

function createDisconnectedRemoteServices(): IServiceAccessor {
  const createDisconnectedError = () => {
    const error = new Error(REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE) as Error & {
      code: string;
    };
    error.code = REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE;
    return error;
  };
  const disconnectedChannel: IChannel = {
    call: () => Promise.reject(createDisconnectedError()),
    listen: () => Event.None,
  };
  // 断连代理曾自行维护普通事件白名单，新增 onAgentRuntimeRestarted 后被误判成
  // RPC 方法并返回 Promise，释放订阅时触发 Promise.dispose 崩溃。这里复用真实 RPC 代理的
  // 事件分类契约：命令明确拒绝，普通/动态事件统一返回空订阅，避免两套规则再次漂移。
  const serviceProxy = ProxyChannel.toService<object>(disconnectedChannel);

  return new Proxy(Object.create(null), {
    get() {
      return serviceProxy;
    },
  }) as IServiceAccessor;
}

function getDisconnectedRemoteServices(): IServiceAccessor {
  if (!disconnectedRemoteServices) {
    disconnectedRemoteServices = createDisconnectedRemoteServices();
  }
  return disconnectedRemoteServices;
}

function resolveWorkspaceServicesForTarget(params: {
  currentContextServices: IServiceAccessor;
  resolvedRemoteSessionId: string | null;
  baseServices: IServiceAccessor | null;
  sessionsById: Record<string, Pick<RemoteWorkspaceSession, "services">>;
  isRemoteTarget: boolean;
}): IServiceAccessor {
  const resolvedServices = params.resolvedRemoteSessionId
    ? (params.sessionsById[params.resolvedRemoteSessionId]?.services ?? null)
    : params.isRemoteTarget
      ? getDisconnectedRemoteServices()
      : params.baseServices;

  if (params.isRemoteTarget && !resolvedServices) {
    return getDisconnectedRemoteServices();
  }

  return resolvedServices ?? params.currentContextServices;
}

function resolveBaseWorkspaceServices(
  contextServices: IServiceAccessor,
  registeredBaseServices: IServiceAccessor | null,
): IServiceAccessor {
  return registeredBaseServices ?? contextServices;
}

function hasRemoteWorkspaceMetadata(tab: WorkspaceServiceTargetTab | null | undefined): boolean {
  return Boolean(
    tab?.workspaceIdentity?.trim() || tab?.remoteSessionId?.trim() || tab?.remoteTarget,
  );
}

function resolveWorkspaceServiceIsRemoteTarget(params: {
  workspacePath: string | null | undefined;
  workspaceIdentity?: string | null;
  preferredRemoteSessionId?: string | null;
  activeWorkspacePath?: string | null;
  activeWorkspaceIdentity?: string | null;
  activeTab?: WorkspaceServiceTargetTab | null;
  workspaceTabs?: readonly WorkspaceServiceTargetTab[];
}): boolean {
  if (params.workspaceIdentity?.trim() || params.preferredRemoteSessionId?.trim()) {
    return true;
  }

  const workspacePath = params.workspacePath?.trim();
  if (!workspacePath) {
    return false;
  }

  if (params.activeWorkspacePath === params.workspacePath) {
    if (params.activeWorkspaceIdentity?.trim()) {
      return true;
    }

    // 日志里远程 SSH workspace 已经恢复成 tab，但草稿预热入口一度只拿到
    // workspacePath，导致 /mnt/... 被当成本地 workspace 走 base services 并在 Windows 上 spawn 本地 agent。
    // 这里用当前 tab 的远程元数据兜住这类 path-only 调用，避免远程目标误回落到本机 host。
    if (
      params.activeTab?.workspacePath === params.workspacePath &&
      hasRemoteWorkspaceMetadata(params.activeTab)
    ) {
      return true;
    }
  }

  const matchingTabs = (params.workspaceTabs ?? []).filter(
    (tab) => tab.workspacePath === params.workspacePath,
  );
  return matchingTabs.length === 1 && hasRemoteWorkspaceMetadata(matchingTabs[0]);
}

export function useBaseWorkspaceServices(): IServiceAccessor {
  const contextServices = useServices();
  const registeredBaseServices = useRemoteWorkspaceSessionStore((state) => state.baseServices);

  // App 会在当前激活 workspace 外层再套一层 ServiceProvider。
  // 激活远端 tab 后，useServices() 读到的是远端 host；但 timeline/search/workspace
  // 这类跨 workspace 查询里的本地 shard 必须继续查本机 host。
  // 这里优先使用 renderer 启动时注册的根 services，避免远端连接污染本地任务列表。
  return resolveBaseWorkspaceServices(contextServices, registeredBaseServices);
}

export function useOptionalBaseWorkspaceServices(): IServiceAccessor | null {
  const contextServices = useOptionalServices();
  const registeredBaseServices = useRemoteWorkspaceSessionStore((state) => state.baseServices);

  // usage entitlement 等 app-global 能力曾从当前 workspace ServiceProvider
  // 取服务；远端 tab 在 attachment ready 前会得到断连代理并产生无效 RPC。base host 才是
  // app-global 权威；Web/SSR 未注册 base services 时保留原有 context/null 降级语义。
  return registeredBaseServices ?? contextServices;
}

interface WorkspaceServicesResolution {
  services: IServiceAccessor;
  remoteSessionId: string | null;
  isRemoteTarget: boolean;
  connectionKind: "local-ready" | "remote-waiting" | "remote-ready";
  rpcReady: boolean;
}

export function useWorkspaceServicesResolution(
  workspacePath: string | null | undefined,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
  remoteTarget?: unknown,
): WorkspaceServicesResolution {
  const currentContextServices = useServices();
  const resolvedRemoteSessionId = useResolvedRemoteWorkspaceSessionId(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
    remoteTarget,
  );
  const isRemoteTarget = useTabStore((state) =>
    resolveWorkspaceServiceIsRemoteTarget({
      workspacePath,
      workspaceIdentity,
      preferredRemoteSessionId,
      activeWorkspacePath: state.activeWorkspacePath,
      activeWorkspaceIdentity: state.activeWorkspaceIdentity,
      activeTab: (() => {
        const activeTab = state.activeTabId
          ? state.tabs.find((tab) => tab.id === state.activeTabId)
          : null;
        return activeTab && isWorkspaceTab(activeTab) ? activeTab : null;
      })(),
      workspaceTabs: state.tabs.filter(isWorkspaceTab),
    }),
  );
  const resolvedServices = useRemoteWorkspaceSessionStore((state) =>
    resolveWorkspaceServicesForTarget({
      currentContextServices,
      resolvedRemoteSessionId,
      baseServices: state.baseServices,
      sessionsById: state.sessionsById,
      isRemoteTarget,
    }),
  );
  const connectionKind = isRemoteTarget
    ? resolvedRemoteSessionId
      ? "remote-ready"
      : "remote-waiting"
    : "local-ready";

  // 远程 SSH host 断开后，若在 resolvedRemoteSessionId 为空时回退到 baseServices，
  // /root 这类远程 task 会被本机 host 查询并报“task 不存在”。远程目标缺少 session 时必须保持断连态，
  // 由上面的断连代理给出可恢复错误，而不是把请求误路由到本机 workspace。
  // 启动重连期仅有 tab 元数据、真实 remote services 尚未注册时属于 remote-waiting；
  // 调用方必须暂停 workspace RPC，断连代理只保留为最终越界保护，不能把预期等待态当失败重试。
  return useMemo(
    () => ({
      services: resolvedServices,
      remoteSessionId: resolvedRemoteSessionId,
      isRemoteTarget,
      connectionKind,
      rpcReady: connectionKind !== "remote-waiting",
    }),
    [connectionKind, isRemoteTarget, resolvedRemoteSessionId, resolvedServices],
  );
}

export function useWorkspaceServices(
  workspacePath: string | null | undefined,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
  remoteTarget?: unknown,
): IServiceAccessor {
  return useWorkspaceServicesResolution(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
    remoteTarget,
  ).services;
}
