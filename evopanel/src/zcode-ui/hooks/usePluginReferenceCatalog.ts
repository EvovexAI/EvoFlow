import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ZCodePluginReferenceCatalogEntry,
  ZCodePluginsReferenceCatalogResult,
} from "@zcode/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

interface PluginReferenceCatalogState {
  entries: ZCodePluginReferenceCatalogEntry[];
  authority: "session" | "workspace" | null;
  loading: boolean;
  error: string | null;
}

const EMPTY_STATE: PluginReferenceCatalogState = {
  entries: [],
  authority: null,
  loading: false,
  error: null,
};

interface ScopedPluginReferenceCatalogState {
  scope: object | null;
  value: PluginReferenceCatalogState;
}

const EMPTY_SCOPED_STATE: ScopedPluginReferenceCatalogState = {
  scope: null,
  value: EMPTY_STATE,
};

interface PluginReferenceCatalogOptions {
  preferredRemoteSessionId?: string;
  /** 显式重试代次；菜单重开时重新查询，关闭菜单不清空已加载的目录。 */
  refreshRevision?: number;
  /** 仅合并当前 runtime 内尚未完成的同一 Session 请求；settle 后立即释放。 */
  dedupeSessionRequest?: boolean;
  suppressErrorLog?: boolean;
}

let sessionCatalogRequests = new WeakMap<
  object,
  Map<string, Promise<ZCodePluginsReferenceCatalogResult>>
>();

function releaseSessionCatalogRequest(
  services: object,
  serviceCache: Map<string, Promise<ZCodePluginsReferenceCatalogResult>>,
  requestKey: string,
  request: Promise<ZCodePluginsReferenceCatalogResult>,
): void {
  // 成功 Promise 曾永久驻留，并在 Agent runtime 换代后继续冒充新
  // runtime 的 Session authority。缓存只能做挂载期的 in-flight 单飞；旧请求
  // settle/unmount 时也不能误删同 key 下已经替换的新请求。
  if (serviceCache.get(requestKey) !== request) return;
  serviceCache.delete(requestKey);
  if (serviceCache.size === 0) {
    sessionCatalogRequests.delete(services);
  }
}

function releaseSessionCatalogRequestWhenSettled(
  services: object,
  serviceCache: Map<string, Promise<ZCodePluginsReferenceCatalogResult>>,
  requestKey: string,
  request: Promise<ZCodePluginsReferenceCatalogResult>,
): void {
  const release = () => releaseSessionCatalogRequest(services, serviceCache, requestKey, request);
  void request.then(release, release);
}

/**
 * Plugin 对话引用 catalog。
 * authority 由 sessionId 决定：null（新建草稿）→ workspace 当前 catalog；
 * 非 null（已有 Session）→ 该 Session 创建时冻结的 session-owned catalog。
 * 异步结果按 `workspaceKey + sessionId + runtime restart 代次 + 请求序号` 校验：key 变化或新请求发出后，
 * 旧 workspace/session/进程代次的返回一律丢弃，不得回填到新目标。
 */
export function usePluginReferenceCatalog(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  sessionId: string | null,
  enabled: boolean,
  options?: PluginReferenceCatalogOptions,
): PluginReferenceCatalogState {
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    options?.preferredRemoteSessionId,
    workspaceIdentity,
  );
  const [scopedState, setScopedState] =
    useState<ScopedPluginReferenceCatalogState>(EMPTY_SCOPED_STATE);
  const [runtimeRevision, setRuntimeRevision] = useState(0);
  const requestSeqRef = useRef(0);
  // 身份/隔离语义统一 workspaceKey = workspaceIdentity?.trim() || workspacePath。
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const remoteSessionId =
    resolution.remoteSessionId ?? options?.preferredRemoteSessionId ?? undefined;
  // remote attachment 也是 authority 边界。同一 workspace/session 切换远端 runtime 时
  // 不得复用旧进程冻结的 catalog Promise。
  const requestKey = `${workspaceKey}|${remoteSessionId ?? "local"}|${sessionId ?? "draft"}|runtime:${runtimeRevision}|refresh:${options?.refreshRevision ?? 0}`;
  const services = resolution.services;
  const rpcReady = resolution.rpcReady;

  useEffect(() => {
    if (!enabled || !workspacePath || !sessionId || !rpcReady) return;
    const subscription = services.zcodeAgentService.onAgentRuntimeRestarted((event) => {
      if (event.workspaceKey !== workspaceKey) return;
      // Runtime restart 后 workspace/session/attachment 都可能保持不变；显式推进代次，
      // 让旧 authority 首帧失效并保证新 runtime 必须重新执行 RPC。
      setRuntimeRevision((current) => current + 1);
    });
    return () => subscription.dispose();
  }, [enabled, rpcReady, services, sessionId, workspaceKey, workspacePath]);
  // 每次 Picker 重新打开、workspace/session/remote attachment 改变，或 services
  // 实例重连时都创建新的请求身份。渲染只接受同一 scope 的结果，因此 effect 尚未
  // 发出新请求的首帧也不会短暂泄露上一 authority 的 catalog。
  const requestScope = useMemo(
    () => ({}),
    [enabled, remoteSessionId, requestKey, rpcReady, services, workspacePath],
  );

  useEffect(() => {
    if (!enabled || !workspacePath || !rpcReady) {
      return;
    }
    const seq = ++requestSeqRef.current;
    let cancelled = false;
    setScopedState({
      scope: requestScope,
      value: { entries: [], authority: null, loading: true, error: null },
    });
    const params = {
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
    let request: Promise<ZCodePluginsReferenceCatalogResult>;
    let requestServiceCache: Map<string, Promise<ZCodePluginsReferenceCatalogResult>> | undefined;
    if (options?.dedupeSessionRequest && sessionId) {
      let serviceCache = sessionCatalogRequests.get(services);
      if (!serviceCache) {
        serviceCache = new Map();
        sessionCatalogRequests.set(services, serviceCache);
      }
      const cached = serviceCache.get(requestKey);
      request = cached ?? services.pluginManagementService.getPluginReferenceCatalog(params);
      requestServiceCache = serviceCache;
      if (!cached) {
        serviceCache.set(requestKey, request);
        releaseSessionCatalogRequestWhenSettled(services, serviceCache, requestKey, request);
      }
    } else {
      request = services.pluginManagementService.getPluginReferenceCatalog(params);
    }
    request
      .then((result) => {
        if (cancelled || seq !== requestSeqRef.current) return;
        setScopedState({
          scope: requestScope,
          value: {
            entries: result.plugins,
            authority: result.authority,
            loading: false,
            error: null,
          },
        });
      })
      .catch((error: unknown) => {
        if (cancelled || seq !== requestSeqRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        // fail closed：查询失败时 Picker 显示错误态，不回退到其它 authority 的数据。
        if (!options?.suppressErrorLog) {
          logger.warn("[usePluginReferenceCatalog] 拉取 Plugin 引用 catalog 失败", {
            error: message,
            requestKey,
          });
        }
        setScopedState({
          scope: requestScope,
          value: {
            entries: [],
            authority: null,
            loading: false,
            error: message,
          },
        });
      });
    return () => {
      cancelled = true;
      if (requestServiceCache) {
        releaseSessionCatalogRequest(services, requestServiceCache, requestKey, request);
      }
    };
    // requestKey 已涵盖 workspaceKey 与 sessionId 的组合变化。
  }, [
    enabled,
    options?.dedupeSessionRequest,
    options?.suppressErrorLog,
    remoteSessionId,
    requestKey,
    requestScope,
    rpcReady,
    services,
    sessionId,
    workspaceIdentity,
    workspacePath,
  ]);

  if (!enabled || !workspacePath || !rpcReady || scopedState.scope !== requestScope) {
    return EMPTY_STATE;
  }
  return scopedState.value;
}
