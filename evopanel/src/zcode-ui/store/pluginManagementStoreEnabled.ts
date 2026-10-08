import type { IPluginManagementService } from "@zcode/services";
import type { ZCodePluginScope } from "@zcode/shared";
import { logger } from "@/logger.js";
import { loadInto } from "@/store/pluginManagementStoreLoading.js";
import type { PluginManagementState } from "@/store/pluginManagementStore.js";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let nextToggleRequestId = 0;
const activeToggleRequests = new Map<string, number>();

function buildToggleRequestKey(input: {
  workspacePath: string;
  workspaceIdentity: string | null;
  configScope: ZCodePluginScope | null;
  pluginId: string;
}): string {
  const workspaceKey = input.workspaceIdentity?.trim() || input.workspacePath;
  return `${workspaceKey}\u0000${input.configScope ?? "effective"}\u0000${input.pluginId}`;
}

export async function setPluginEnabledOptimistically(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  pluginId: string,
  enabled: boolean,
  pluginService: IPluginManagementService,
  scope: ZCodePluginScope = "user",
): Promise<boolean> {
  const { workspacePath, workspaceIdentity, configScope } = get();
  if (!workspacePath) return false;

  const requestKey = buildToggleRequestKey({
    workspacePath,
    workspaceIdentity,
    configScope,
    pluginId,
  });
  const requestId = ++nextToggleRequestId;
  activeToggleRequests.set(requestKey, requestId);
  const isCurrentRequest = (): boolean => {
    const current = get();
    return (
      activeToggleRequests.get(requestKey) === requestId &&
      current.workspacePath === workspacePath &&
      current.workspaceIdentity === workspaceIdentity &&
      current.configScope === configScope &&
      current.togglingPluginId === pluginId
    );
  };

  const previousPlugin = get().plugins.find((plugin) => plugin.id === pluginId);
  // 启停 RPC 和后续列表刷新存在可感知延迟。先投影最终状态，让开关立刻响应；失败时
  // 在 catch 中恢复快照，避免用户把正常的异步写入误判成“点了没反应”。
  set({
    togglingPluginId: pluginId,
    error: null,
    lastFailedPluginId: null,
    ...(previousPlugin
      ? {
          plugins: get().plugins.map((plugin) =>
            plugin.id === pluginId ? { ...plugin, enabled, enabledSource: scope } : plugin,
          ),
        }
      : {}),
  });

  try {
    const result = await pluginService.setPluginEnabled({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      pluginId,
      enabled,
      scope,
    });
    if (!isCurrentRequest()) return false;
    set({
      plugins: get().plugins.map((plugin) =>
        plugin.id === pluginId ? { ...plugin, ...result.plugin, enabled: result.enabled } : plugin,
      ),
    });
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity,
      configScope,
      pluginService,
    });
    return isCurrentRequest();
  } catch (error) {
    // 启停失败时必须返回 false 并恢复 optimistic projection，避免
    // 调用方继续刷新其它能力，或让界面把失败的切换误报成成功。
    logger.error("[plugins] setEnabled failed", { pluginId, enabled, error: toMessage(error) });
    if (isCurrentRequest()) {
      set({
        error: toMessage(error),
        lastFailedPluginId: pluginId,
        ...(previousPlugin
          ? {
              plugins: get().plugins.map((plugin) =>
                plugin.id === pluginId ? previousPlugin : plugin,
              ),
            }
          : {}),
      });
    }
    return false;
  } finally {
    if (isCurrentRequest()) {
      set({ togglingPluginId: null });
    }
    if (activeToggleRequests.get(requestKey) === requestId) {
      activeToggleRequests.delete(requestKey);
    }
  }
}
