import { useState, useCallback, useMemo, useRef } from "react";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import type { ModelConnectivityResult } from "@zcode/shared";
import type { ProviderSettingsView } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { useProviderSettingsServiceView } from "@/hooks/useProviderSettingsView.js";
import {
  projectProviderSettingsViewToFormProviders,
  resolveProviderSettingsFormProviders,
  resolveProviderOrdering,
} from "@/lib/providerSettingsFormProjection.js";
import { persistProviderDisplayOrder } from "@/lib/providerDisplayOrderPersistence.js";
import { persistPersonalProviderDeletion } from "@/lib/providerPersonalPersistence.js";
import { persistPersonalProvider } from "@/lib/providerPersonalSave.js";
import type { ProviderOrderView } from "@/lib/modelProviderOrdering.js";

export function useModelProviders(target: {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 本地 Provider Settings 的连通性测试使用的本地 cwd；不复用远程激活路径。 */
  connectivityWorkspacePath?: string;
  /** 远程激活时没有本地 cwd 必须 fail-closed，不能回退到远程 workspacePath。 */
  connectivityWorkspaceRequired?: boolean;
  /** 没有本地 workspace 时展示给用户的本地化错误文案。 */
  connectivityUnavailableMessage?: string;
}) {
  const { providerSettingsService } = useServices();
  const providerSettingsRead = useProviderSettingsServiceView(providerSettingsService);
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  const effectiveModelProviders = useMemo(
    () =>
      resolveProviderSettingsFormProviders({
        view: providerSettingsView,
      }),
    [providerSettingsView],
  );
  const providerOrdering = useMemo(
    () =>
      resolveProviderOrdering({
        view: providerSettingsView,
        providers: effectiveModelProviders,
      }),
    [effectiveModelProviders, providerSettingsView],
  );
  const commitProviderSettingsView = useCallback(
    (view: ProviderSettingsView): void => {
      // 远端 mutation 的返回值是目标 Environment 已刷新后的权威 View，
      // 只依赖 onDidChange 会在 attachment 换代/事件丢失时留下删除前的 UI 快照。
      // 统一在 Hook 边界提交返回 View，仍由 useProviderSettingsServiceView 做 Service/revision 守卫。
      providerSettingsRead.commit(view);
    },
    [providerSettingsRead.commit],
  );
  const [refreshing, setRefreshing] = useState(false);
  const latestRefreshTokenRef = useRef(0);

  const refresh = useCallback(async () => {
    const refreshToken = latestRefreshTokenRef.current + 1;
    latestRefreshTokenRef.current = refreshToken;
    setRefreshing(true);
    try {
      const view = await providerSettingsService.refresh("settings-manual");
      commitProviderSettingsView(view);
    } catch (err) {
      logger.error("[useModelProviders] 加载模型供应商失败", err);
    } finally {
      // 用户连续触发刷新时，旧请求可能先返回。
      // 若不做 token 守卫，旧请求 finally 会把 refreshing 提前置 false，导致标题 loading 提示闪灭。
      if (refreshToken === latestRefreshTokenRef.current) {
        setRefreshing(false);
      }
    }
  }, [commitProviderSettingsView, providerSettingsService]);

  const saveProvider = useCallback(
    async (provider: ProviderSettingsFormProvider) => {
      // 新建 Provider 尚未进入 Registry，自然也不会出现在当前 Settings View。
      // 保存边界允许缺少继承层，并直接从新建表单构造完整配置。
      const savedView = await persistPersonalProvider({ provider, providerSettingsService });
      commitProviderSettingsView(savedView);
      return projectProviderSettingsViewToFormProviders(savedView);
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const createPersonalProvider = useCallback(
    async (input?: Parameters<typeof providerSettingsService.createPersonalProvider>[0]) => {
      const created = await providerSettingsService.createPersonalProvider(input);
      commitProviderSettingsView(created.view);
      return created;
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const addPersonalModel = useCallback(
    (
      providerId: string,
      modelId: string,
      config: ProviderSettingsFormProvider["models"][number]["personalConfig"],
      useRecommendedConfig?: boolean,
    ) =>
      providerSettingsService
        .addPersonalModel(providerId, modelId, config, useRecommendedConfig)
        .then((view) => {
          commitProviderSettingsView(view);
          return view;
        }),
    [commitProviderSettingsView, providerSettingsService],
  );

  const savePersonalModelDraft = useCallback(
    async (input: Parameters<typeof providerSettingsService.savePersonalModelDraft>[0]) => {
      const view = await providerSettingsService.savePersonalModelDraft(input);
      commitProviderSettingsView(view);
      return view;
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const setPersonalModelEnabled = useCallback(
    async (providerId: string, modelId: string, enabled: boolean) => {
      const view = await providerSettingsService.setPersonalModelEnabled(
        providerId,
        modelId,
        enabled,
      );
      commitProviderSettingsView(view);
      return view;
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const deletePersonalModel = useCallback(
    async (providerId: string, modelId: string) => {
      const view = await providerSettingsService.deletePersonalModel(providerId, modelId);
      commitProviderSettingsView(view);
      return view;
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const deleteProvider = useCallback(
    async (id: string) => {
      const view = await persistPersonalProviderDeletion({
        providerId: id,
        providerSettingsService,
      });
      commitProviderSettingsView(view);
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const reorderProviderModels = useCallback(
    async (providerId: string, modelIds: readonly string[]) => {
      const view = await providerSettingsService.reorderPersonalModels(providerId, modelIds);
      commitProviderSettingsView(view);
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const saveDisplayOrder = useCallback(
    async (state: ProviderOrderView) => {
      const normalizedState: ProviderOrderView = {
        providerIds: [...new Set(state.providerIds.map((id) => id.trim()).filter(Boolean))],
      };
      try {
        const view = await persistProviderDisplayOrder({
          state: normalizedState,
          providerSettingsService,
        });
        commitProviderSettingsView(view);
      } catch (err) {
        logger.warn("[useModelProviders] 保存 Personal Provider 顺序失败", err);
        throw err;
      }
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const testModelConnectivity = useCallback(
    async (providerId: string, modelId: string): Promise<ModelConnectivityResult> => {
      const connectivityWorkspacePath = target.connectivityWorkspacePath?.trim();
      if (
        !connectivityWorkspacePath &&
        (target.connectivityWorkspaceRequired || target.workspaceIdentity?.trim())
      ) {
        return {
          success: false,
          error: {
            message:
              target.connectivityUnavailableMessage ??
              "A local workspace is unavailable for connectivity testing.",
          },
        };
      }
      return providerSettingsService.testModelConnectivity({
        workspacePath: connectivityWorkspacePath || target.workspacePath,
        providerId,
        modelId,
      });
    },
    [
      providerSettingsService,
      target.connectivityUnavailableMessage,
      target.connectivityWorkspacePath,
      target.connectivityWorkspaceRequired,
      target.workspacePath,
      target.workspaceIdentity,
    ],
  );

  return {
    modelProviders: effectiveModelProviders,
    providerTemplates: providerSettingsView?.providerTemplates ?? [],
    displayOrder: providerOrdering.displayOrder,
    reorderableProviderIds: providerOrdering.reorderableProviderIds,
    loading: providerSettingsRead.state.status === "loading",
    loadError:
      providerSettingsRead.state.status === "error" ? providerSettingsRead.state.error : null,
    reload: providerSettingsRead.reload,
    refreshing,
    refresh,
    saveProvider,
    createPersonalProvider,
    addPersonalModel,
    savePersonalModelDraft,
    setPersonalModelEnabled,
    deletePersonalModel,
    deleteProvider,
    reorderProviderModels,
    saveDisplayOrder,
    testModelConnectivity,
    providerSettingsView,
  };
}
