import { create } from "zustand";
import type {
  ZCodeAvailablePluginSummary,
  ZCodeInstalledPluginSummary,
  ZCodePluginDiagnostic,
  ZCodePluginInfo,
  ZCodePluginMarketplaceSummary,
  ZCodePluginScope,
  ZCodePluginsDescribeResult,
} from "@zcode/shared";
import type { IPluginManagementService } from "@zcode/services";
import { logger } from "@/logger.js";
import { loadInto, runWorkspaceOperation } from "@/store/pluginManagementStoreLoading.js";
import { setPluginEnabledOptimistically } from "@/store/pluginManagementStoreEnabled.js";

// 市场详情按需拉取的组件清单缓存：按 pluginId 记 loading/data/error，避免重复请求与切换闪烁。
export interface PluginDescribeEntry {
  status: "loading" | "loaded" | "error";
  data?: ZCodePluginsDescribeResult;
  error?: string;
}

// 设置页「插件管理」的数据源: 经 IPluginManagementService 薄服务由 zcode-cli 提供 (list + enable/disable)。
// UI 不再直触 IZCodeAgentService，plugins/* 旧协议词的消费收拢到服务实现一处。
// 与已 retired 的 marketplace pluginStore 无关, 故单独建一个精简 store。
export interface PluginManagementState {
  workspacePath: string | null;
  workspaceIdentity: string | null;
  configScope: ZCodePluginScope | null;
  plugins: ZCodePluginInfo[];
  marketplaces: ZCodePluginMarketplaceSummary[];
  /** 最近一次 overview 是否成功；false 表示来源存在性未知，不能推导孤立状态。 */
  marketplaceAvailabilityKnown: boolean;
  availablePlugins: ZCodeAvailablePluginSummary[];
  installedPlugins: ZCodeInstalledPluginSummary[];
  restorableBuiltins: ZCodeAvailablePluginSummary[];
  diagnostics: ZCodePluginDiagnostic[];
  loading: boolean;
  error: string | null;
  /**
   * 最近一次失败操作的归属插件：带 pluginId 的操作（如 setEnabled）失败写该
   * id；无插件目标的操作（marketplace add/update/validate、列表加载、refresh）写 null。
   * 消费方（CUA 输入框按钮等）只应把「目标是自己」的 error 当成自身错误，避免共享
   * error 字段把无关失败误映射成自己的错误态。
   */
  lastFailedPluginId: string | null;
  togglingPluginId: string | null;
  operationId: string | null;
  operationVersion: number;
  describeCache: Record<string, PluginDescribeEntry>;
  initialize: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    configScope?: ZCodePluginScope;
    pluginService: IPluginManagementService;
  }) => Promise<void>;
  refresh: (pluginService: IPluginManagementService) => Promise<void>;
  addMarketplace: (source: string, pluginService: IPluginManagementService) => Promise<boolean>;
  updateMarketplace: (
    marketplace: string | null,
    pluginService: IPluginManagementService,
  ) => Promise<boolean>;
  removeMarketplace: (
    marketplace: string,
    pluginService: IPluginManagementService,
  ) => Promise<void>;
  installPlugin: (
    pluginName: string,
    marketplace: string,
    pluginService: IPluginManagementService,
    scope?: ZCodePluginScope,
  ) => Promise<void>;
  uninstallPlugin: (
    pluginId: string,
    pluginService: IPluginManagementService,
    removeCache?: boolean,
  ) => Promise<void>;
  updatePlugin: (pluginId: string, pluginService: IPluginManagementService) => Promise<void>;
  restoreBuiltin: (pluginId: string, pluginService: IPluginManagementService) => Promise<void>;
  configurePlugin: (
    pluginId: string,
    options: Record<string, string | number | boolean>,
    pluginService: IPluginManagementService,
    scope?: ZCodePluginScope,
    clearOptionKeys?: string[],
  ) => Promise<boolean>;
  resetPluginConfig: (
    pluginId: string,
    pluginService: IPluginManagementService,
    scope?: ZCodePluginScope,
  ) => Promise<boolean>;
  validateSource: (source: string, pluginService: IPluginManagementService) => Promise<void>;
  setEnabled: (
    pluginId: string,
    enabled: boolean,
    pluginService: IPluginManagementService,
    scope?: ZCodePluginScope,
  ) => Promise<boolean>;
  // 按需拉取插件组件清单（名称+描述）；force 跳过缓存重试。
  describePlugin: (
    pluginId: string,
    pluginName: string,
    marketplace: string,
    pluginService: IPluginManagementService,
    force?: boolean,
  ) => Promise<void>;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwForErrorDiagnostic(diagnostics: ZCodePluginDiagnostic[]): void {
  const blockingDiagnostic = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (blockingDiagnostic) {
    throw new Error(blockingDiagnostic.message);
  }
}

export const usePluginManagementStore = create<PluginManagementState>((set, get) => ({
  workspacePath: null,
  workspaceIdentity: null,
  configScope: null,
  plugins: [],
  marketplaces: [],
  marketplaceAvailabilityKnown: false,
  availablePlugins: [],
  installedPlugins: [],
  restorableBuiltins: [],
  diagnostics: [],
  loading: false,
  error: null,
  lastFailedPluginId: null,
  togglingPluginId: null,
  operationId: null,
  operationVersion: 0,
  describeCache: {},

  async initialize({ workspacePath, workspaceIdentity, configScope, pluginService }) {
    const normalizedIdentity = workspaceIdentity?.trim() || null;
    const normalizedConfigScope = configScope ?? null;
    const current = get();
    const contextChanged =
      current.workspacePath !== workspacePath ||
      current.workspaceIdentity !== normalizedIdentity ||
      current.configScope !== normalizedConfigScope;
    const hasCache =
      current.plugins.length > 0 &&
      current.workspacePath === workspacePath &&
      current.workspaceIdentity === normalizedIdentity &&
      current.configScope === normalizedConfigScope;
    set({
      workspacePath,
      workspaceIdentity: normalizedIdentity,
      configScope: normalizedConfigScope,
      // 有缓存时后台刷新、保留列表, 避免切换 workspace 时闪烁; 无缓存才显示阻塞 loading。
      loading: !hasCache,
      marketplaceAvailabilityKnown: hasCache ? current.marketplaceAvailabilityKnown : false,
      error: null,
      lastFailedPluginId: null,
      // 配置保存后的 overview 刷新可能还没结束，用户已切到另一层配置视图；
      // 旧层的 operationId 不能继续把新层的输入控件置灰。旧操作结束时由版本号防止
      // 它误清理新层后来启动的同名操作。
      ...(contextChanged ? { operationId: null } : {}),
    });
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity: normalizedIdentity,
      configScope: normalizedConfigScope,
      pluginService,
    });
  },

  async refresh(pluginService) {
    const { workspacePath, workspaceIdentity, configScope } = get();
    if (!workspacePath) {
      return;
    }
    set({ error: null, lastFailedPluginId: null });
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity,
      configScope,
      pluginService,
    });
  },

  async addMarketplace(source, pluginService) {
    return runWorkspaceOperation(
      set,
      get,
      pluginService,
      `marketplace:add:${source}`,
      async (workspace) => {
        await pluginService.addPluginMarketplace({
          ...workspace,
          source,
        });
      },
    );
  },

  async updateMarketplace(marketplace, pluginService) {
    let refreshError: string | null = null;
    const succeeded = await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `marketplace:update:${marketplace ?? "__all__"}`,
      async (workspace) => {
        const result = await pluginService.updatePluginMarketplace({
          ...workspace,
          ...(marketplace ? { marketplace } : {}),
        });
        // 刷新允许部分成功，因此仍要 reload overview 保留成功来源；但仅 warn
        // 并返回 true，桌面与手机 Web 都会把旧快照误报成刷新成功。先记住错误，reload 后再写入
        // 共用 store 的可见错误态，同时返回 false，让所有入口获得一致的部分失败语义。
        const blockingDiagnostic = result.diagnostics?.find(
          (diagnostic) => diagnostic.severity === "error",
        );
        if (blockingDiagnostic) {
          refreshError = blockingDiagnostic.message;
          logger.warn("[plugins] marketplace refresh partially failed", {
            diagnostics: result.diagnostics,
          });
        }
      },
    );
    if (succeeded && refreshError) {
      // 列表刷新失败无插件目标，归属清空（不指向任何插件）。
      set({ error: refreshError, lastFailedPluginId: null });
      return false;
    }
    return succeeded;
  },

  async removeMarketplace(marketplace, pluginService) {
    await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `marketplace:remove:${marketplace}`,
      async (workspace) => {
        await pluginService.removePluginMarketplace({
          ...workspace,
          marketplace,
        });
      },
    );
  },

  async installPlugin(pluginName, marketplace, pluginService, scope = "user") {
    await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `plugin:install:${pluginName}@${marketplace}`,
      async (workspace) => {
        const result = await pluginService.installPlugin({
          ...workspace,
          pluginName,
          marketplace,
          scope,
        });
        // CLI 为了保留结构化诊断，安装失败会返回成功的 RPC envelope，
        // 并把实际错误放进 diagnostics。旧 UI 忽略返回值后继续刷新，看起来像按钮无响应，
        // 也没有错误和重试入口；这里将 error diagnostic 收敛到既有 operation 错误态。
        throwForErrorDiagnostic(result.diagnostics);
      },
    );
  },

  async uninstallPlugin(pluginId, pluginService, removeCache = true) {
    await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `plugin:uninstall:${pluginId}`,
      async (workspace) => {
        await pluginService.uninstallPlugin({
          ...workspace,
          pluginId,
          removeCache,
        });
      },
    );
  },

  async updatePlugin(pluginId, pluginService) {
    await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `plugin:update:${pluginId}`,
      async (workspace) => {
        const result = await pluginService.updatePlugin({ ...workspace, pluginId });
        // update 与 install 共享同一诊断式失败契约。抛入 runWorkspaceOperation 后不会
        // 覆盖当前 overview，因此旧版本和 update badge 会一直保留到用户重试成功。
        throwForErrorDiagnostic(result.diagnostics);
      },
    );
  },

  async restoreBuiltin(pluginId, pluginService) {
    await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `plugin:restore:${pluginId}`,
      async (workspace) => {
        await pluginService.restoreBuiltinPlugin({ ...workspace, pluginId });
      },
    );
  },

  async configurePlugin(pluginId, options, pluginService, scope = "user", clearOptionKeys = []) {
    return await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `plugin:configure:${pluginId}`,
      async (workspace) => {
        await pluginService.configurePlugin({
          ...workspace,
          pluginId,
          options,
          scope,
          ...(clearOptionKeys.length > 0 ? { clearOptionKeys } : {}),
        });
      },
    );
  },

  async resetPluginConfig(pluginId, pluginService, scope = "workspace") {
    return await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `plugin:reset-config:${pluginId}`,
      async (workspace) => {
        await pluginService.resetPluginConfig({
          ...workspace,
          pluginId,
          scope,
        });
      },
    );
  },

  async validateSource(source, pluginService) {
    const { workspacePath, workspaceIdentity } = get();
    if (!workspacePath) return;
    set({ operationId: `marketplace:validate:${source}`, error: null });
    try {
      const result = await pluginService.validatePlugin({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        source,
      });
      set({ diagnostics: result.diagnostics });
    } catch (error) {
      logger.error("[plugins] validate source failed", { source, error: toMessage(error) });
      set({ error: toMessage(error), lastFailedPluginId: null });
    } finally {
      set({ operationId: null });
    }
  },

  async setEnabled(pluginId, enabled, pluginService, scope = "user") {
    return setPluginEnabledOptimistically(set, get, pluginId, enabled, pluginService, scope);
  },

  async describePlugin(pluginId, pluginName, marketplace, pluginService, force = false) {
    const { workspacePath, workspaceIdentity, describeCache } = get();
    if (!workspacePath) return;
    const cached = describeCache[pluginId];
    // 已加载或正在加载时命中缓存，不重复请求；force 时强制重试。
    if (!force && cached && cached.status !== "error") return;
    set({
      describeCache: { ...get().describeCache, [pluginId]: { status: "loading" } },
    });
    try {
      const data = await pluginService.describePlugin({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        marketplace,
        pluginName,
      });
      const blockingDiagnostic = data.diagnostics?.find(
        (diagnostic) => diagnostic.severity === "error",
      );
      if (data.components.length === 0 && blockingDiagnostic) {
        // CLI 的 describe 对不可解析来源采用 diagnostics 回包而非 RPC reject。
        // 旧 UI 把该回包缓存为 loaded，详情只显示空白且永远没有重试入口；这里将无组件的
        // error diagnostic 映射成可恢复错误态，同时保留正常的部分成功回包。
        set({
          describeCache: {
            ...get().describeCache,
            [pluginId]: { status: "error", error: blockingDiagnostic.message },
          },
        });
        return;
      }
      set({
        describeCache: {
          ...get().describeCache,
          [pluginId]: { status: "loaded", data },
        },
      });
    } catch (error) {
      logger.error("[plugins] describe failed", {
        pluginId,
        marketplace,
        error: toMessage(error),
      });
      set({
        describeCache: {
          ...get().describeCache,
          [pluginId]: { status: "error", error: toMessage(error) },
        },
      });
    }
  },
}));
