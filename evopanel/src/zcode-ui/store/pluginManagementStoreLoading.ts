import type { IPluginManagementService } from "@zcode/services";
import type { ZCodePluginScope } from "@zcode/shared";
import { logger } from "@/logger.js";
import type { PluginManagementState } from "@/store/pluginManagementStore.js";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildWorkspaceKey(workspacePath: string, workspaceIdentity: string | null): string {
  return workspaceIdentity?.trim() || workspacePath;
}

const inFlightLoads = new Map<string, Promise<void>>();

export async function runWorkspaceOperation(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  pluginService: IPluginManagementService,
  operationId: string,
  operation: (workspace: { workspacePath: string; workspaceIdentity?: string }) => Promise<void>,
): Promise<boolean> {
  const { workspacePath, workspaceIdentity, configScope } = get();
  if (!workspacePath) return false;
  const operationVersion = get().operationVersion + 1;
  set({ operationId, operationVersion, error: null, lastFailedPluginId: null });
  const isCurrentContext = (): boolean => {
    const current = get();
    return (
      current.workspacePath === workspacePath &&
      current.workspaceIdentity === workspaceIdentity &&
      current.configScope === configScope
    );
  };
  const ownsVisibleOperation = (): boolean =>
    isCurrentContext() && get().operationId === operationId;
  try {
    await operation({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    });
    // operationId 只是共享的 UI 忙碌指示器。自动刷新可能在当前操作完成前覆盖它，
    // 但不能因此把已经成功落盘的添加/安装操作报告成失败，否则调用方会保留弹窗。
    if (!isCurrentContext()) return false;
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity,
      configScope,
      pluginService,
    });
    return isCurrentContext();
  } catch (error) {
    // marketplace add/update 等通用操作失败：无插件目标，归属清空。
    logger.error("[plugins] operation failed", { operationId, error: toMessage(error) });
    // 旧操作不能覆盖同一配置层中新操作的错误态；只有仍持有可见 operationId 的操作才回写。
    if (ownsVisibleOperation()) {
      set({ error: toMessage(error), lastFailedPluginId: null });
    }
    return false;
  } finally {
    // 防止旧操作结束时清掉后来操作的忙碌态。
    // Scope/workspace 切换后当前上下文可能已经变化，不能再用 isCurrentContext 判断；
    // 只要 operationId 仍然属于这次已结束的操作，就应该清掉它。否则用户在 User
    // 配置保存完成、刷新尚未结束时切到 Workspace，新的配置视图会一直被旧操作锁成只读。
    if (get().operationId === operationId && get().operationVersion === operationVersion) {
      set({ operationId: null });
    }
  }
}

export async function loadInto(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  params: {
    workspacePath: string;
    workspaceIdentity: string | null;
    configScope: ZCodePluginScope | null;
    pluginService: IPluginManagementService;
  },
): Promise<void> {
  const workspaceKey = buildWorkspaceKey(params.workspacePath, params.workspaceIdentity);
  const loadKey = `${workspaceKey}\u0000${params.configScope ?? "effective"}`;
  const existing = inFlightLoads.get(loadKey);
  if (existing) {
    logger.debug("[plugins] join in-flight list", {
      configScope: params.configScope,
      workspaceKey,
    });
    await existing;
    return;
  }
  const loadTask = runLoadInto(set, get, { ...params, workspaceKey });
  inFlightLoads.set(loadKey, loadTask);
  try {
    await loadTask;
  } finally {
    if (inFlightLoads.get(loadKey) === loadTask) {
      inFlightLoads.delete(loadKey);
    }
  }
}

async function runLoadInto(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  params: {
    workspacePath: string;
    workspaceIdentity: string | null;
    configScope: ZCodePluginScope | null;
    workspaceKey: string;
    pluginService: IPluginManagementService;
  },
): Promise<void> {
  const setIfCurrent = (partial: Partial<PluginManagementState>): void => {
    const current = get();
    if (
      current.workspacePath !== params.workspacePath ||
      current.workspaceIdentity !== params.workspaceIdentity ||
      current.configScope !== params.configScope
    ) {
      return;
    }
    set(partial);
  };
  try {
    // React StrictMode、settings service 引用刷新或快速切换设置页时，
    // 同一 workspace 会并发触发 initialize。每次触发都发成独立 plugins/list 的话，
    // agent 已经 stale 时这些请求会排队产生多个 30s timeout。按 workspaceKey 复用 in-flight
    // 请求，并在仍处于同一 workspace 时才回写结果，避免过期响应覆盖当前设置页。
    const [listResult, overviewResult] = await Promise.all([
      params.pluginService.listPlugins({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        ...(params.configScope ? { configScope: params.configScope } : {}),
      }),
      params.pluginService.getPluginsOverview({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        ...(params.configScope ? { configScope: params.configScope } : {}),
      }),
    ]);
    const diagnostics = [...listResult.diagnostics, ...overviewResult.diagnostics];
    setIfCurrent({
      plugins: listResult.plugins,
      marketplaces: overviewResult.marketplaces,
      marketplaceAvailabilityKnown: true,
      availablePlugins: overviewResult.availablePlugins,
      installedPlugins: overviewResult.installedPlugins,
      restorableBuiltins: overviewResult.restorableBuiltins,
      diagnostics,
      loading: false,
    });
  } catch (error) {
    logger.error("[plugins] overview/list failed", {
      workspacePath: params.workspacePath,
      workspaceKey: params.workspaceKey,
      lastFailedPluginId: null,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      const result = await params.pluginService.listPlugins({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        ...(params.configScope ? { configScope: params.configScope } : {}),
      });
      setIfCurrent({
        plugins: result.plugins,
        marketplaces: [],
        // overview 失败时空数组表示“来源状态未知”，而不是“所有来源已删除”。
        // 保留该边界，避免 list fallback 返回的 official/cache 插件被批量误判为孤立安装。
        marketplaceAvailabilityKnown: false,
        availablePlugins: [],
        installedPlugins: [],
        restorableBuiltins: [],
        diagnostics: result.diagnostics,
        loading: false,
      });
      return;
    } catch (listError) {
      logger.error("[plugins] list fallback failed", {
        workspacePath: params.workspacePath,
        workspaceKey: params.workspaceKey,
        lastFailedPluginId: null,
        error: listError instanceof Error ? listError.message : String(listError),
      });
      setIfCurrent({
        loading: false,
        marketplaceAvailabilityKnown: false,
        lastFailedPluginId: null,
        error: listError instanceof Error ? listError.message : String(listError),
      });
    }
  }
}
