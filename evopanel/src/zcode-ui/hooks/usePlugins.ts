import { useCallback, useEffect, useMemo } from "react";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { usePluginStore } from "@/store/pluginStore.js";

export function usePlugins(workspacePath: string | null, workspaceIdentity?: string | null) {
  const { pluginsService } = useWorkspaceServices(workspacePath, undefined, workspaceIdentity);
  const storeWorkspacePath = usePluginStore((state) => state.workspacePath);
  const storeWorkspaceIdentity = usePluginStore((state) => state.workspaceIdentity);
  const loadedWorkspacePath = usePluginStore((state) => state.loadedWorkspacePath);
  const loadedWorkspaceIdentity = usePluginStore((state) => state.loadedWorkspaceIdentity);
  const marketplaces = usePluginStore((state) => state.marketplaces);
  const availablePlugins = usePluginStore((state) => state.availablePlugins);
  const installedPlugins = usePluginStore((state) => state.installedPlugins);
  const capability = usePluginStore((state) => state.capability);
  const loading = usePluginStore((state) => state.loading);
  const refreshing = usePluginStore((state) => state.refreshing);
  const error = usePluginStore((state) => state.error);
  const addingMarketplaceSource = usePluginStore((state) => state.addingMarketplaceSource);
  const removingMarketplaceName = usePluginStore((state) => state.removingMarketplaceName);
  const updatingMarketplaceName = usePluginStore((state) => state.updatingMarketplaceName);
  const installingPluginId = usePluginStore((state) => state.installingPluginId);
  const uninstallingPluginId = usePluginStore((state) => state.uninstallingPluginId);
  const settingPluginEnabledId = usePluginStore((state) => state.settingPluginEnabledId);
  const settingPluginEnabledValue = usePluginStore((state) => state.settingPluginEnabledValue);
  const initialize = usePluginStore((state) => state.initialize);
  const resetWorkspaceContext = usePluginStore((state) => state.resetWorkspaceContext);
  const refreshStore = usePluginStore((state) => state.refresh);
  const addMarketplaceStore = usePluginStore((state) => state.addMarketplace);
  const removeMarketplaceStore = usePluginStore((state) => state.removeMarketplace);
  const updateMarketplaceStore = usePluginStore((state) => state.updateMarketplace);
  const installPluginStore = usePluginStore((state) => state.installPlugin);
  const uninstallPluginStore = usePluginStore((state) => state.uninstallPlugin);
  const setPluginEnabledStore = usePluginStore((state) => state.setPluginEnabled);

  useEffect(() => {
    if (!workspacePath) {
      // 无活动工作区时保留上一份插件缓存，会让 Discover 仍可点安装但 store.workspacePath 为空而静默失败。
      resetWorkspaceContext();
      return;
    }
    if (
      storeWorkspacePath === workspacePath &&
      storeWorkspaceIdentity === (workspaceIdentity ?? null) &&
      loadedWorkspacePath === workspacePath &&
      loadedWorkspaceIdentity === (workspaceIdentity ?? null)
    ) {
      return;
    }
    void initialize(workspacePath, pluginsService, workspaceIdentity ?? undefined);
  }, [
    initialize,
    loadedWorkspacePath,
    loadedWorkspaceIdentity,
    pluginsService,
    resetWorkspaceContext,
    storeWorkspacePath,
    storeWorkspaceIdentity,
    workspaceIdentity,
    workspacePath,
  ]);

  const refresh = useCallback(async () => {
    await refreshStore(pluginsService, workspaceIdentity ?? undefined);
  }, [pluginsService, refreshStore, workspaceIdentity]);

  const addMarketplace = useCallback(
    async (source: string) => {
      return addMarketplaceStore(source, pluginsService, workspaceIdentity ?? undefined);
    },
    [addMarketplaceStore, pluginsService, workspaceIdentity],
  );

  const removeMarketplace = useCallback(
    async (marketplace: string) => {
      return removeMarketplaceStore(marketplace, pluginsService, workspaceIdentity ?? undefined);
    },
    [pluginsService, removeMarketplaceStore, workspaceIdentity],
  );

  const updateMarketplace = useCallback(
    async (marketplace?: string) => {
      return updateMarketplaceStore(
        marketplace ?? null,
        pluginsService,
        workspaceIdentity ?? undefined,
      );
    },
    [pluginsService, updateMarketplaceStore, workspaceIdentity],
  );

  const installPlugin = useCallback(
    async (pluginName: string, marketplace: string, scope: "workspace" | "user" = "user") => {
      if (!workspacePath) {
        usePluginStore.setState({ error: "请先打开一个工作区后再安装插件" });
        return false;
      }
      if (
        usePluginStore.getState().workspacePath !== workspacePath ||
        usePluginStore.getState().loadedWorkspacePath !== workspacePath
      ) {
        await initialize(workspacePath, pluginsService, workspaceIdentity ?? undefined);
      }
      return installPluginStore(
        pluginName,
        marketplace,
        scope,
        pluginsService,
        workspaceIdentity ?? undefined,
      );
    },
    [initialize, installPluginStore, pluginsService, workspaceIdentity, workspacePath],
  );

  const uninstallPlugin = useCallback(
    async (pluginName: string, marketplace: string, scope: "workspace" | "user") => {
      return uninstallPluginStore(
        pluginName,
        marketplace,
        scope,
        pluginsService,
        workspaceIdentity ?? undefined,
      );
    },
    [pluginsService, uninstallPluginStore, workspaceIdentity],
  );

  const setPluginEnabled = useCallback(
    async (
      pluginName: string,
      marketplace: string,
      scope: "workspace" | "user",
      enabled: boolean,
      nativeScope?: "user" | "project" | "local",
    ) => {
      return setPluginEnabledStore(
        pluginName,
        marketplace,
        scope,
        enabled,
        pluginsService,
        workspaceIdentity ?? undefined,
        nativeScope,
      );
    },
    [pluginsService, setPluginEnabledStore, workspaceIdentity],
  );

  return useMemo(
    () => ({
      marketplaces,
      availablePlugins,
      installedPlugins,
      capability,
      loading,
      refreshing,
      error,
      addingMarketplaceSource,
      removingMarketplaceName,
      updatingMarketplaceName,
      installingPluginId,
      uninstallingPluginId,
      settingPluginEnabledId,
      settingPluginEnabledValue,
      refresh,
      addMarketplace,
      removeMarketplace,
      updateMarketplace,
      installPlugin,
      uninstallPlugin,
      setPluginEnabled,
    }),
    [
      addMarketplace,
      availablePlugins,
      addingMarketplaceSource,
      capability,
      error,
      installPlugin,
      installedPlugins,
      loading,
      refreshing,
      marketplaces,
      removingMarketplaceName,
      refresh,
      removeMarketplace,
      setPluginEnabled,
      uninstallPlugin,
      updateMarketplace,
      updatingMarketplaceName,
      installingPluginId,
      uninstallingPluginId,
      settingPluginEnabledId,
      settingPluginEnabledValue,
    ],
  );
}
