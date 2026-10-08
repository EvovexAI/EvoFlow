/* eslint-disable max-lines -- 共享能力外壳聚合 Scope，并承载 Plugin tabs 与独立 Commands 入口。 */
import { PluginAddMenu } from "@/settings/PluginAddMenu.js";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  Loader2,
  Monitor,
  MoreHorizontal,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { Switch } from "@/components/ui/switch.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { TID_PLUGIN_STORE_BROWSE } from "@zcode/shared";
import type { ZCodePluginInfo, ZCodePluginScope, ZCodePluginUserConfigOption } from "@zcode/shared";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import {
  useBaseWorkspaceServices,
  useWorkspaceServicesResolution,
} from "@/hooks/useWorkspaceServices.js";
import { getPathLeaf } from "@/lib/path.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { McpSettingsSection } from "@/settings/McpSettingsSection.js";
import { SkillsSection } from "@/settings/SkillsSection.js";
import { CommandsSection } from "@/settings/CommandsSection.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import { PluginUninstallConfirmDialog } from "@/settings/PluginUninstallConfirmDialog.js";
import { PluginInstallEmptyState, PluginLoadingState } from "@/settings/PluginInstallEmptyState.js";
import {
  PluginDetailRow,
  PluginHookDetails,
  PluginWarningList,
} from "@/settings/InstalledPluginManagement.js";
import { PluginConfigControls } from "@/settings/PluginConfigControls.js";
import {
  PluginStoreAdvancedSection,
  PluginStoreDetailView,
} from "@/settings/PluginStoreDetailView.js";
import {
  PluginStoreUpdateBadge,
  PluginStoreUpdateButton,
  type PluginStoreActions,
} from "@/settings/PluginStoreCard.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { SettingsScopeBadge } from "@/settings/SettingsScopeBadge.js";
import {
  buildPluginConfigPatch,
  type PluginOptionDraftValue,
} from "@/settings/pluginConfigPatch.js";
import { formatRemoteSkillSyncTarget } from "@/settings/RemoteSkillSyncDialog.js";
import {
  buildPluginStoreTryMention,
  buildPluginStoreTryPrompt,
} from "@/settings/pluginStoreTryPrompt.js";
import { usePluginUninstall } from "@/settings/usePluginUninstall.js";
import {
  buildStoreItems,
  canUpdatePluginItem,
  resolveManagedPluginDisplay,
  resolvePluginDisplayName,
} from "@/settings/pluginStoreListing.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";
import {
  filterPluginsByQuery,
  partitionPluginsForSettings,
  selectBuiltInPlugins,
  selectPluginsForScope,
} from "@/settings/pluginCapabilityProjection.js";
import {
  isComputerUseRemoteOrLinux,
  matchesComputerUseSearch,
  resolveComputerUseAvailability,
} from "@/settings/computerUseAvailability.js";
import {
  PluginScopeMenu,
  getPluginWorkspaceKey,
  isPluginScopeWorkspaceConnected,
} from "@/settings/PluginScopeMenu.js";
import {
  RemoteSyncDialogs,
  shouldShowRemoteSyncActions,
  useRemoteSyncDialogIntent,
} from "@/settings/RemoteSyncActions.js";

type PluginTabTarget = "plugins" | "mcps" | "skills" | "commands";
type PluginTab = Exclude<PluginTabTarget, "commands">;

function normalizePluginTab(tab: PluginTabTarget): PluginTab {
  return tab === "commands" ? "plugins" : tab;
}

function getPluginTabCountClass(tab: PluginTabTarget, selectedTab: PluginTabTarget): string {
  return tab === selectedTab
    ? "text-ui-sm text-foreground-subtle"
    : "text-ui-sm text-foreground-subtlest";
}

type PluginScope =
  | { kind: "user"; key: "user" }
  | { kind: "workspace"; key: string; tab: WorkspaceTabState };

interface PluginsSectionProps {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  initialTab?: PluginTabTarget;
  initialScopeKey?: string;
  mode?: "plugin" | "mcp" | "skill" | "command";
  workspacePath?: string | null;
  workspaceIdentity?: string;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onOpenPluginStore: (returnScopeKey?: string, intent?: "add-marketplace") => void;
  showMarketplaceBreadcrumb?: boolean;
}

function workspaceKey(tab: WorkspaceTabState): string {
  return getPluginWorkspaceKey(tab);
}

function PluginList({
  target,
  configScope,
  searchQuery,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  onAdd,
  onCreateTask,
  onDetailOpenChange,
  onOpenPluginStore,
  showMarketplaceBreadcrumb = false,
  onVisibleCountChange,
}: {
  target: WorkspaceTabState | null;
  configScope: ZCodePluginScope;
  searchQuery: string;
  isDesktop: boolean;
  isMacDesktop: boolean;
  isWindowsDesktop: boolean;
  onAdd?: () => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onDetailOpenChange?: (open: boolean) => void;
  onOpenPluginStore: (returnScopeKey?: string, intent?: "add-marketplace") => void;
  showMarketplaceBreadcrumb?: boolean;
  onVisibleCountChange?: (count: number) => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const targetServiceResolution = useWorkspaceServicesResolution(
    target?.workspacePath,
    target?.remoteSessionId,
    target?.workspaceIdentity,
    target?.remoteTarget,
  );
  const baseServices = useBaseWorkspaceServices();
  // Scope 可选择非激活 workspace，若继续从当前 ServiceProvider 取服务，
  // 会把 B 的路径发往 A 的 host。插件读写必须和 Scope target 共用同一服务解析结果。
  const { pluginManagementService } = targetServiceResolution.services;
  const plugins = usePluginManagementStore((state) => state.plugins);
  const installedPlugins = usePluginManagementStore((state) => state.installedPlugins);
  const marketplaces = usePluginManagementStore((state) => state.marketplaces);
  const marketplaceAvailabilityKnown = usePluginManagementStore(
    (state) => state.marketplaceAvailabilityKnown,
  );
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  const restorableBuiltins = usePluginManagementStore((state) => state.restorableBuiltins);
  const loading = usePluginManagementStore((state) => state.loading);
  const pluginDiagnostics = usePluginManagementStore((state) => state.diagnostics);
  const currentWorkspacePath = usePluginManagementStore((state) => state.workspacePath);
  const currentWorkspaceIdentity = usePluginManagementStore((state) => state.workspaceIdentity);
  const initialize = usePluginManagementStore((state) => state.initialize);
  const setEnabled = usePluginManagementStore((state) => state.setEnabled);
  const updatePlugin = usePluginManagementStore((state) => state.updatePlugin);
  const configurePlugin = usePluginManagementStore((state) => state.configurePlugin);
  const currentConfigScope = usePluginManagementStore((state) => state.configScope);
  const resetPluginConfig = usePluginManagementStore((state) => state.resetPluginConfig);
  const togglingPluginId = usePluginManagementStore((state) => state.togglingPluginId);
  const operationId = usePluginManagementStore((state) => state.operationId);
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
  const [pluginOptionsDrafts, setPluginOptionsDrafts] = useState<
    Record<string, Record<string, PluginOptionDraftValue>>
  >({});
  // 设置页重构后只保留了 Plugin 管理列表，漏掉了旧版插件页的远端同步入口。
  // 同步目标必须沿用当前 Scope 的 target services，不能回退到激活 workspace 的 host。
  const connectedRemoteSyncTarget =
    targetServiceResolution.rpcReady &&
    shouldShowRemoteSyncActions({
      remoteSessionId: target?.remoteSessionId,
      remoteTarget: target?.remoteTarget,
      clientMode: "desktop-continuous" as const,
      hasLocalSourceService: Boolean(baseServices.pluginSyncService),
    }) &&
    target?.workspacePath
      ? target.remoteTarget
      : null;
  // 设置页重构时只迁移了插件远程同步操作，遗漏了当前远端工作区提示，
  // 用户无法确认插件列表实际对应的是哪个远程目标。
  const remotePluginSyncTargetLabel = connectedRemoteSyncTarget
    ? formatRemoteSkillSyncTarget(connectedRemoteSyncTarget, target?.workspacePath ?? "")
    : "";
  const targetKey = target ? workspaceKey(target) : "";
  const pluginSyncTargetKey = target
    ? `${targetKey}\u0000${target.remoteSessionId?.trim() ?? ""}`
    : "";
  const { open: remotePluginSyncOpen, setOpen: setRemotePluginSyncOpen } =
    useRemoteSyncDialogIntent({
      rpcReady: targetServiceResolution.rpcReady,
      targetKey: pluginSyncTargetKey,
    });
  const storeKey = currentWorkspaceIdentity?.trim() || currentWorkspacePath || "";
  const storeMatchesTarget = storeKey === targetKey && currentConfigScope === configScope;
  const storeItemById = useMemo(
    () =>
      new Map(
        buildStoreItems({
          marketplaces,
          marketplaceAvailabilityKnown,
          availablePlugins,
          installedPlugins,
          plugins,
          restorableBuiltins,
        }).map((item) => [item.id, item]),
      ),
    [
      availablePlugins,
      installedPlugins,
      marketplaceAvailabilityKnown,
      marketplaces,
      plugins,
      restorableBuiltins,
    ],
  );
  const visiblePlugins = useMemo(() => {
    if (!storeMatchesTarget) return [];
    return filterPluginsByQuery(
      selectPluginsForScope(plugins, installedPlugins, configScope),
      searchQuery,
      storeItemById,
      locale,
    );
  }, [
    configScope,
    installedPlugins,
    locale,
    plugins,
    searchQuery,
    storeItemById,
    storeMatchesTarget,
  ]);
  const scopedPlugins = useMemo(
    () => (storeMatchesTarget ? selectPluginsForScope(plugins, installedPlugins, configScope) : []),
    [configScope, installedPlugins, plugins, storeMatchesTarget],
  );
  const builtInPluginIds = useMemo(
    () => new Set(selectBuiltInPlugins(plugins, installedPlugins).map((plugin) => plugin.id)),
    [installedPlugins, plugins],
  );
  const visiblePluginGroups = useMemo(
    () => partitionPluginsForSettings(visiblePlugins, builtInPluginIds),
    [builtInPluginIds, visiblePlugins],
  );
  const scopedPluginGroups = useMemo(
    () => partitionPluginsForSettings(scopedPlugins, builtInPluginIds),
    [builtInPluginIds, scopedPlugins],
  );
  const visibleBuiltInPlugins = visiblePluginGroups.builtIn;
  const visibleInstalledPlugins = visiblePluginGroups.installed;
  const installedPluginCount = scopedPluginGroups.installed.length;
  const computerUseAvailability = resolveComputerUseAvailability({
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
    remoteSessionId: target?.remoteSessionId,
    remoteTarget: target?.remoteTarget,
    workspaceIdentity: target?.workspaceIdentity,
  });
  const showUnavailableComputerUse = Boolean(
    configScope === "user" &&
    target &&
    !loading &&
    isComputerUseRemoteOrLinux(computerUseAvailability) &&
    matchesComputerUseSearch(searchQuery),
  );
  const hasEmptySearchResult = Boolean(
    target &&
    !loading &&
    searchQuery.trim() &&
    visibleInstalledPlugins.length === 0 &&
    visibleBuiltInPlugins.length === 0 &&
    !showUnavailableComputerUse,
  );
  const hideInstalledGroup = Boolean(searchQuery.trim() && visibleInstalledPlugins.length === 0);
  useEffect(() => {
    onVisibleCountChange?.(visibleInstalledPlugins.length + visibleBuiltInPlugins.length);
  }, [onVisibleCountChange, visibleBuiltInPlugins.length, visibleInstalledPlugins.length]);
  const refreshAfterPluginChange = useCallback(async () => {
    if (!target || !targetServiceResolution.rpcReady) return;
    await initialize({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      configScope,
      pluginService: pluginManagementService,
    });
  }, [initialize, pluginManagementService, configScope, target, targetServiceResolution.rpcReady]);
  const handleSetEnabled = useCallback(
    async (pluginId: string, enabled: boolean) => {
      const plugin = plugins.find((candidate) => candidate.id === pluginId);
      const pluginLabel = plugin
        ? resolveManagedPluginDisplay(plugin, storeItemById.get(plugin.id), locale).name
        : pluginId;
      const succeeded = await setEnabled(pluginId, enabled, pluginManagementService, configScope);
      if (!succeeded) {
        toast(
          usePluginManagementStore.getState().error ??
            intl.formatMessage({ id: "settings.plugins.toggle.failed" }, { plugin: pluginLabel }),
          { variant: "warning" },
        );
        return;
      }
      const messageId =
        configScope === "workspace"
          ? enabled
            ? "settings.plugins.toggle.workspaceEnabled"
            : "settings.plugins.toggle.workspaceDisabled"
          : enabled
            ? "settings.plugins.toggle.enabled"
            : "settings.plugins.toggle.disabled";
      toast(intl.formatMessage({ id: messageId }, { plugin: pluginLabel }));
    },
    [configScope, intl, locale, pluginManagementService, plugins, setEnabled, storeItemById],
  );
  const handleResetPluginConfig = useCallback(
    async (pluginId: string) => {
      const plugin = plugins.find((candidate) => candidate.id === pluginId);
      const pluginLabel = plugin
        ? resolveManagedPluginDisplay(plugin, storeItemById.get(plugin.id), locale).name
        : pluginId;
      const restored = await resetPluginConfig(pluginId, pluginManagementService, "workspace");
      if (!restored) {
        toast(
          usePluginManagementStore.getState().error ??
            intl.formatMessage({ id: "settings.plugins.toggle.failed" }, { plugin: pluginLabel }),
          { variant: "warning" },
        );
        return;
      }
      toast(intl.formatMessage({ id: "settings.plugins.scope.restored" }, { plugin: pluginLabel }));
    },
    [intl, locale, pluginManagementService, plugins, resetPluginConfig, storeItemById],
  );
  const uninstall = usePluginUninstall({
    pluginService: pluginManagementService,
    installedPlugins,
    plugins,
    operationId,
    onAfterUninstall: refreshAfterPluginChange,
  });
  const handleUpdatePlugin = useCallback(
    async (pluginId: string) => {
      await updatePlugin(pluginId, pluginManagementService);
      if (usePluginManagementStore.getState().error) return;
      await refreshAfterPluginChange();
    },
    [pluginManagementService, refreshAfterPluginChange, updatePlugin],
  );
  const selectedPlugin = plugins.find((plugin) => plugin.id === selectedPluginId) ?? null;
  // 插件自身 warning 诊断（如声明的技能路径扫描为空）：详情高级区展示，避免静默失败。
  const pluginWarningsForSelected = selectedPlugin
    ? pluginDiagnostics.filter(
        (diagnostic) =>
          diagnostic.pluginId === selectedPlugin.id && diagnostic.severity === "warning",
      )
    : [];
  const selectedStoreItem = selectedPluginId ? storeItemById.get(selectedPluginId) : undefined;
  const closeDetail = useCallback(() => {
    setSelectedPluginId(null);
    onDetailOpenChange?.(false);
  }, [onDetailOpenChange]);
  useEffect(() => {
    closeDetail();
  }, [closeDetail, targetKey]);
  useEffect(() => {
    if (selectedPluginId && !selectedPlugin) closeDetail();
  }, [closeDetail, selectedPlugin, selectedPluginId]);
  const setPluginOptionDraft = (
    pluginId: string,
    key: string,
    value: string | number | boolean,
  ) => {
    setPluginOptionsDrafts((current) => ({
      ...current,
      [pluginId]: { ...current[pluginId], [key]: value },
    }));
  };
  const getPluginOptionValue = (
    plugin: ZCodePluginInfo,
    key: string,
    option: ZCodePluginUserConfigOption,
  ): string | number | boolean => {
    const draft = pluginOptionsDrafts[plugin.id]?.[key];
    if (draft === null) return "";
    return (
      draft ??
      plugin.configuredOptions?.[key] ??
      option.default ??
      (option.type === "boolean" ? false : "")
    );
  };
  const savePluginOptions = async (plugin: ZCodePluginInfo) => {
    const { options, clearOptionKeys } = buildPluginConfigPatch(
      plugin,
      pluginOptionsDrafts[plugin.id] ?? {},
    );
    // 没有显式修改时不写入空的 Workspace 配置，避免无操作保存制造配置足迹。
    if (Object.keys(options).length === 0 && clearOptionKeys.length === 0) return;
    const configured = await configurePlugin(
      plugin.id,
      options,
      pluginManagementService,
      configScope,
      clearOptionKeys,
    );
    // 保存失败时保留用户输入和敏感字段清除意图，避免 RPC 错误后 UI 看起来像已提交。
    if (!configured) return;
    setPluginOptionsDrafts((current) => {
      const next = { ...current };
      delete next[plugin.id];
      return next;
    });
  };
  const actions: PluginStoreActions = useMemo(
    () => ({
      onOpenDetail: (pluginId) => {
        setSelectedPluginId(pluginId);
        onDetailOpenChange?.(true);
      },
      onInstall: () => onOpenPluginStore(),
      onUninstall: uninstall.requestUninstall,
      onSetEnabled: (pluginId, enabled) => void handleSetEnabled(pluginId, enabled),
      onResetConfig:
        configScope === "workspace"
          ? (pluginId) => void handleResetPluginConfig(pluginId)
          : undefined,
      onUpdate: (pluginId) => void handleUpdatePlugin(pluginId),
      operationId,
      togglingPluginId,
    }),
    [
      configScope,
      handleResetPluginConfig,
      handleSetEnabled,
      handleUpdatePlugin,
      onDetailOpenChange,
      onOpenPluginStore,
      operationId,
      togglingPluginId,
      uninstall.requestUninstall,
    ],
  );
  useEffect(() => {
    if (!target || !targetServiceResolution.rpcReady) return;
    void initialize({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      configScope,
      pluginService: pluginManagementService,
    });
  }, [initialize, pluginManagementService, configScope, target, targetServiceResolution.rpcReady]);

  const renderPluginRows = (items: ZCodePluginInfo[]) => (
    <div className="overflow-hidden rounded-xl bg-surface">
      {items.map((plugin, index) => (
        <Fragment key={plugin.id}>
          {index > 0 ? <div className="h-px bg-border/50" aria-hidden="true" /> : null}
          <div
            className="group/plugin-row flex min-w-0 items-center gap-3 px-4 py-3 transition-colors hover:bg-hover"
            data-testid="plugin-settings-plugin-row"
            data-plugin-id={plugin.id}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
              onClick={() => actions.onOpenDetail(plugin.id)}
            >
              <PluginStoreAvatar
                item={storeItemById.get(plugin.id) ?? { name: plugin.name }}
                className="size-9 bg-background"
              />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
                    {resolveManagedPluginDisplay(plugin, storeItemById.get(plugin.id), locale).name}
                  </span>
                  <PluginStoreUpdateBadge item={storeItemById.get(plugin.id)} />
                </div>
                {resolveManagedPluginDisplay(plugin, storeItemById.get(plugin.id), locale)
                  .description ? (
                  <div className="mt-0.5 line-clamp-1 text-ui-sm text-foreground-subtle">
                    {
                      resolveManagedPluginDisplay(plugin, storeItemById.get(plugin.id), locale)
                        .description
                    }
                  </div>
                ) : null}
                <div className="mt-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <SettingsScopeBadge
                      scope={plugin.enabledSource ?? "default"}
                      label={
                        configScope === "user" && plugin.enabledSource === "user"
                          ? intl.formatMessage({
                              id: "settings.plugins.scope.userDefault",
                            })
                          : plugin.enabledSource === "user"
                            ? intl.formatMessage({
                                id: "settings.plugins.scope.inheritedUser",
                              })
                            : plugin.enabledSource === "workspace"
                              ? intl.formatMessage({
                                  id: "settings.plugins.scope.workspaceOverride",
                                })
                              : undefined
                      }
                    />
                  </div>
                </div>
              </div>
            </button>
            <PluginStoreUpdateButton item={storeItemById.get(plugin.id)} actions={actions} />
            {plugin.packageStatus === "missing" ? null : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={intl.formatMessage({ id: "common.more" })}
                    className="text-foreground-subtle opacity-0 group-hover/plugin-row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                  >
                    <MoreHorizontal className="size-4" aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {canUpdatePluginItem(storeItemById.get(plugin.id)) ? (
                    <DropdownMenuItem
                      disabled={operationId !== null}
                      onSelect={() => void handleUpdatePlugin(plugin.id)}
                    >
                      <RefreshCw className="size-4" aria-hidden="true" />
                      {intl.formatMessage({
                        id: "settings.plugins.detail.update",
                      })}
                    </DropdownMenuItem>
                  ) : null}
                  {configScope === "workspace" && plugin.enabledSource === "workspace" ? (
                    <DropdownMenuItem
                      disabled={operationId !== null || togglingPluginId === plugin.id}
                      onSelect={() => void handleResetPluginConfig(plugin.id)}
                    >
                      <RotateCcw className="size-4" aria-hidden="true" />
                      {intl.formatMessage({
                        id: "settings.plugins.scope.restoreUserDefault",
                      })}
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={operationId !== null}
                    onSelect={() => uninstall.requestUninstall(plugin.id)}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                    {intl.formatMessage({
                      id: "settings.plugins.detail.uninstall",
                    })}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <div className="flex shrink-0 items-center gap-2">
              {togglingPluginId === plugin.id ? (
                <Loader2
                  className="size-4 animate-spin text-foreground-subtle"
                  data-testid="plugin-settings-enabled-pending"
                  aria-label={intl.formatMessage(
                    { id: "settings.plugins.toggle.pending" },
                    {
                      plugin: resolveManagedPluginDisplay(
                        plugin,
                        storeItemById.get(plugin.id),
                        locale,
                      ).name,
                    },
                  )}
                />
              ) : null}
              <Switch
                data-testid="plugin-settings-enabled-switch"
                data-plugin-id={plugin.id}
                checked={plugin.enabled}
                disabled={togglingPluginId === plugin.id}
                aria-busy={togglingPluginId === plugin.id}
                aria-label={intl.formatMessage(
                  {
                    id: plugin.enabled
                      ? "settings.plugins.toggle.disable"
                      : "settings.plugins.toggle.enable",
                  },
                  {
                    plugin: resolveManagedPluginDisplay(
                      plugin,
                      storeItemById.get(plugin.id),
                      locale,
                    ).name,
                  },
                )}
                onCheckedChange={(enabled) => {
                  actions.onSetEnabled?.(plugin.id, enabled);
                }}
              />
            </div>
          </div>
        </Fragment>
      ))}
    </div>
  );

  const renderUnavailableComputerUse = () => (
    <div className="overflow-hidden rounded-xl bg-surface">
      <div className="flex min-w-0 items-center gap-3 px-4 py-3 text-foreground-subtle">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-foreground-subtle">
          <Monitor className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.computerUse.title" })}
          </div>
          <div className="mt-0.5 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({
              id:
                computerUseAvailability.kind === "local-linux"
                  ? "settings.computerUse.unsupported.linuxDescription"
                  : "settings.computerUse.unsupported.remoteDescription",
            })}
          </div>
        </div>
        <span className="shrink-0 rounded-md bg-background px-2 py-1 text-ui-xs font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "settings.computerUse.unsupported.badge" })}
        </span>
      </div>
    </div>
  );

  if (selectedPlugin && selectedStoreItem && targetServiceResolution.rpcReady) {
    const pluginBreadcrumbLabel = resolvePluginDisplayName(selectedStoreItem, locale);
    const pluginsBreadcrumbLabel = intl.formatMessage({ id: "settings.plugins.title" });
    // Plugin 不打开仅含管理字段的简化弹窗：那会与插件商店详情形成两套内容模型，
    // 导致介绍、Hero、示例提示词与能力清单缺失。这里直接复用权威商店详情页，只注入已安装态高级配置。
    return (
      <section className="space-y-5">
        <SettingsBreadcrumbReporter
          items={
            showMarketplaceBreadcrumb
              ? [
                  { label: pluginsBreadcrumbLabel, onSelect: closeDetail },
                  { label: pluginBreadcrumbLabel },
                ]
              : [{ label: pluginBreadcrumbLabel }]
          }
          onSectionSelect={showMarketplaceBreadcrumb ? onOpenPluginStore : closeDetail}
        />
        <PluginStoreDetailView
          item={selectedStoreItem}
          actions={actions}
          onRetryDescribe={() => {}}
          onUsePrompt={(item, prompt) => {
            if (!onCreateTask) return;
            onCreateTask({
              initialPrompt: buildPluginStoreTryPrompt({
                item,
                locale,
                prompt,
              }),
              initialPromptMention: buildPluginStoreTryMention({
                item,
                locale,
              }),
            });
          }}
          advanced={
            selectedPlugin.packageStatus === "missing" ? undefined : (
              <PluginStoreAdvancedSection>
                {pluginWarningsForSelected.length > 0 ? (
                  <div>
                    <div className="mb-2 text-ui-xs font-medium text-foreground">
                      {intl.formatMessage({ id: "settings.plugins.detail.warnings" })}
                    </div>
                    <PluginWarningList warnings={pluginWarningsForSelected} />
                  </div>
                ) : null}
                <PluginDetailRow
                  label={intl.formatMessage({
                    id: "settings.plugins.detail.rootPath",
                  })}
                  value={selectedPlugin.rootPath}
                />
                {(selectedPlugin.hookDetails ?? []).length > 0 ? (
                  <PluginHookDetails hooks={selectedPlugin.hookDetails ?? []} />
                ) : null}
                <PluginConfigControls
                  getValue={getPluginOptionValue}
                  isOptionClearPending={(pluginId, key) =>
                    pluginOptionsDrafts[pluginId]?.[key] === null
                  }
                  onClearOption={(pluginId, key, clear) =>
                    setPluginOptionsDrafts((current) => {
                      const nextPluginDrafts = { ...current[pluginId] };
                      if (clear) nextPluginDrafts[key] = null;
                      else delete nextPluginDrafts[key];
                      return {
                        ...current,
                        [pluginId]: nextPluginDrafts,
                      };
                    })
                  }
                  onSave={(plugin) => void savePluginOptions(plugin)}
                  onSetDraft={setPluginOptionDraft}
                  operationId={operationId}
                  plugin={selectedPlugin}
                  scope={configScope}
                />
              </PluginStoreAdvancedSection>
            )
          }
        />
        <PluginUninstallConfirmDialog
          open={uninstall.pendingPlugin !== null}
          pluginName={
            uninstall.pendingPlugin
              ? resolvePluginDisplayName(
                  storeItemById.get(uninstall.pendingPlugin.id) ?? {
                    name: uninstall.pendingPlugin.name,
                  },
                  locale,
                )
              : ""
          }
          pending={uninstall.uninstalling}
          onCancel={uninstall.cancelUninstall}
          onConfirm={() => void uninstall.confirmUninstall()}
        />
      </section>
    );
  }

  return (
    <section className="space-y-6" aria-labelledby="plugin-installed-title">
      {hasEmptySearchResult ? (
        <EmptyState
          message={intl.formatMessage({
            id: "settings.plugin.plugins.empty",
          })}
        />
      ) : null}
      <div className={hideInstalledGroup ? "hidden" : "space-y-4"}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3
            id="plugin-installed-title"
            className="flex h-7 items-center gap-1.5 text-ui-base font-medium text-foreground"
          >
            {intl.formatMessage({ id: "settings.plugin.plugins.installed" })}
            <span className="text-ui-sm font-normal text-foreground-subtle">
              {visibleInstalledPlugins.length}
            </span>
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            {connectedRemoteSyncTarget ? (
              <ControlHintTooltip
                title={intl.formatMessage({
                  id: "settings.plugins.remoteSync.open",
                })}
              >
                <Button
                  type="button"
                  variant="outline"
                  size="icon-md"
                  aria-label={intl.formatMessage({
                    id: "settings.plugins.remoteSync.open",
                  })}
                  onClick={() => setRemotePluginSyncOpen(true)}
                >
                  <UploadCloud className="size-3.5" aria-hidden="true" />
                </Button>
              </ControlHintTooltip>
            ) : null}
            <SettingsResourceHeaderActions onRefresh={() => void refreshAfterPluginChange()} />
            {configScope === "user" ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  data-testid={TID_PLUGIN_STORE_BROWSE}
                  onClick={onAdd}
                >
                  {intl.formatMessage({ id: "settings.plugin.plugins.browse" })}
                </Button>
                <PluginAddMenu
                  testId="plugin-settings-add"
                  onCreateTask={onCreateTask}
                  onAddMarketplace={() => onOpenPluginStore(undefined, "add-marketplace")}
                />
              </>
            ) : null}
          </div>
        </div>
        {configScope === "workspace" && target ? (
          <div
            className="rounded-lg border border-border bg-card px-3 py-2 text-ui-sm text-foreground-subtle"
            data-testid="plugin-settings-workspace-scope-hint"
          >
            {intl.formatMessage({ id: "settings.plugins.scope.workspaceHint" })}
          </div>
        ) : null}
        {connectedRemoteSyncTarget ? (
          <div className="rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.plugins.remoteContext" },
              { target: remotePluginSyncTargetLabel },
            )}
          </div>
        ) : null}
        {!target ? (
          <EmptyState
            message={intl.formatMessage({
              id: "settings.plugin.noWorkspace",
            })}
          />
        ) : !targetServiceResolution.rpcReady ? (
          <PluginLoadingState label={intl.formatMessage({ id: "common.connecting" })} />
        ) : loading && visiblePlugins.length === 0 ? (
          <PluginLoadingState label={intl.formatMessage({ id: "common.loading" })} />
        ) : visibleInstalledPlugins.length > 0 ? (
          renderPluginRows(visibleInstalledPlugins)
        ) : installedPluginCount === 0 && !showUnavailableComputerUse ? (
          <PluginInstallEmptyState
            title={intl.formatMessage({
              id: "settings.plugin.plugins.emptyInstalledTitle",
            })}
            description={intl.formatMessage({
              id: "settings.plugin.plugins.emptyInstalledDescription",
            })}
            actions={
              onAdd ? (
                <Button type="button" variant="default" size="lg" onClick={onAdd}>
                  <Plus aria-hidden="true" data-icon="inline-start" />
                  {intl.formatMessage({
                    id: "settings.plugin.plugins.browse",
                  })}
                </Button>
              ) : undefined
            }
          />
        ) : null}
      </div>
      {!hasEmptySearchResult && visibleBuiltInPlugins.length > 0 ? (
        <div className="space-y-4">
          <h3 className="flex h-7 items-center gap-1.5 text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.plugin.plugins.builtIn" })}
            <span className="text-ui-sm font-normal text-foreground-subtle">
              {visibleBuiltInPlugins.length}
            </span>
          </h3>
          {renderPluginRows(visibleBuiltInPlugins)}
        </div>
      ) : null}
      {showUnavailableComputerUse ? (
        <div className="space-y-4">
          <h3 className="flex h-7 items-center text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.computerUse.unsupported.group" })}
          </h3>
          {renderUnavailableComputerUse()}
        </div>
      ) : null}
      <PluginUninstallConfirmDialog
        open={uninstall.pendingPlugin !== null}
        pluginName={
          uninstall.pendingPlugin
            ? resolvePluginDisplayName(
                storeItemById.get(uninstall.pendingPlugin.id) ?? {
                  name: uninstall.pendingPlugin.name,
                },
                locale,
              )
            : ""
        }
        pending={uninstall.uninstalling}
        onCancel={uninstall.cancelUninstall}
        onConfirm={() => void uninstall.confirmUninstall()}
      />
      <RemoteSyncDialogs
        canSyncSkills={false}
        canSyncMcp={false}
        canSyncPlugins={Boolean(connectedRemoteSyncTarget && target?.workspacePath)}
        skillOpen={false}
        mcpOpen={false}
        pluginOpen={remotePluginSyncOpen}
        onSkillOpenChange={() => {}}
        onMcpOpenChange={() => {}}
        onPluginOpenChange={setRemotePluginSyncOpen}
        localPluginSyncService={baseServices.pluginSyncService}
        remotePluginSyncService={targetServiceResolution.services.pluginSyncService}
        localZCodeAgentService={baseServices.zcodeAgentService}
        remoteZCodeAgentService={targetServiceResolution.services.zcodeAgentService}
        remoteTarget={connectedRemoteSyncTarget}
        skillWorkspacePath=""
        mcpWorkspacePath=""
        pluginWorkspacePath={target?.workspacePath ?? ""}
        pluginLocalWorkspacePath={target?.localWorkspacePath}
        workspaceIdentity={target?.workspaceIdentity}
        onSkillsSynced={() => {}}
        onMcpSynced={() => {}}
        onPluginsSynced={refreshAfterPluginChange}
      />
    </section>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-ui-base text-foreground-subtle">
      {message}
    </div>
  );
}

export function PluginsSection({
  isDesktop = false,
  isMacDesktop = false,
  isWindowsDesktop = false,
  initialTab = "plugins",
  initialScopeKey,
  mode = "plugin",
  workspacePath,
  workspaceIdentity,
  onCreateTask,
  onOpenPluginStore,
  showMarketplaceBreadcrumb = false,
}: PluginsSectionProps) {
  const { intl } = useZCodeIntl();
  const tabs = useTabStore((state) => state.tabs);
  const storeActiveWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const storeActiveWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const activeWorkspacePath = workspacePath ?? storeActiveWorkspacePath;
  const activeWorkspaceIdentity = workspaceIdentity ?? storeActiveWorkspaceIdentity ?? undefined;
  const workspaceTabs = useMemo(() => {
    const seen = new Set<string>();
    const scopedTabs = tabs
      .filter(isWorkspaceTab)
      .filter(isPluginScopeWorkspaceConnected)
      .filter((tab) => {
        const key = workspaceKey(tab);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    if (
      activeWorkspacePath &&
      !activeWorkspaceIdentity?.trim() &&
      !scopedTabs.some(
        (tab) => workspaceKey(tab) === (activeWorkspaceIdentity?.trim() || activeWorkspacePath),
      )
    ) {
      // 启动恢复可能先恢复 activeWorkspacePath，再异步补齐 tabs；此时不能把
      // Workspace 配置范围误显示成不可用，否则用户无法读取/修改项目配置。
      scopedTabs.push({
        id: `__active_workspace__:${activeWorkspaceIdentity?.trim() || activeWorkspacePath}`,
        kind: "workspace",
        workspacePath: activeWorkspacePath,
        workspaceIdentity: activeWorkspaceIdentity ?? undefined,
        label: getPathLeaf(activeWorkspacePath) || activeWorkspacePath,
      });
    }
    return scopedTabs;
  }, [activeWorkspaceIdentity, activeWorkspacePath, tabs]);
  const preferredHost = useMemo(
    () =>
      workspaceTabs.find(
        (tab) =>
          workspaceKey(tab) === (activeWorkspaceIdentity?.trim() || activeWorkspacePath || ""),
      ) ??
      workspaceTabs[0] ??
      null,
    [activeWorkspaceIdentity, activeWorkspacePath, workspaceTabs],
  );
  const [pickedScopeKey, setPickedScopeKey] = useState(() => initialScopeKey?.trim() || "user");
  const selectedScopeKey = pickedScopeKey;
  const fixedTab: PluginTabTarget | null =
    mode === "mcp" ? "mcps" : mode === "skill" ? "skills" : mode === "command" ? "commands" : null;
  const [interactiveTab, setInteractiveTab] = useState<PluginTab>(() =>
    normalizePluginTab(initialTab),
  );
  useEffect(() => setInteractiveTab(normalizePluginTab(initialTab)), [initialTab]);
  useEffect(() => {
    setPickedScopeKey(initialScopeKey?.trim() || "user");
  }, [initialScopeKey]);
  const selectedTab = fixedTab ?? interactiveTab;
  const [searchQueries, setSearchQueries] = useState<Record<PluginTabTarget, string>>({
    plugins: "",
    mcps: "",
    skills: "",
    commands: "",
  });
  const [capabilityCounts, setCapabilityCounts] = useState<Record<PluginTabTarget, number>>({
    plugins: 0,
    mcps: 0,
    skills: 0,
    commands: 0,
  });
  const [mcpEditorOpen, setMcpEditorOpen] = useState(false);
  const [skillDetailOpen, setSkillDetailOpen] = useState(false);
  const [mcpFormScopeKey, setMcpFormScopeKey] = useState<string | null>(null);
  const [pluginDetailOpen, setPluginDetailOpen] = useState(false);
  const [commandEditorOpen, setCommandEditorOpen] = useState(false);
  const [commandFormScopeKey, setCommandFormScopeKey] = useState<string | null>(null);
  const activeSearchQuery = searchQueries[selectedTab];
  const selectedScope: PluginScope = useMemo(() => {
    const tab = workspaceTabs.find((candidate) => workspaceKey(candidate) === selectedScopeKey);
    return tab ? { kind: "workspace", key: workspaceKey(tab), tab } : { kind: "user", key: "user" };
  }, [selectedScopeKey, workspaceTabs]);
  const openPluginStoreForSelectedScope = useCallback(
    (_returnScopeKey?: string, intent?: "add-marketplace") => {
      // Workspace 是已安装 Plugin 的配置视图，不提供 Marketplace 入口；市场只在 User
      // 视图中负责 package/cache 生命周期。
      if (selectedScope.kind !== "user") return;
      onOpenPluginStore("user", intent);
    },
    [onOpenPluginStore, selectedScope.kind],
  );
  const target = selectedScope.kind === "workspace" ? selectedScope.tab : preferredHost;
  const effectiveMcpScopeKey =
    mcpEditorOpen && mcpFormScopeKey ? mcpFormScopeKey : selectedScopeKey;
  const effectiveMcpWorkspace = workspaceTabs.find(
    (tab) => workspaceKey(tab) === effectiveMcpScopeKey,
  );
  // 编辑器锁定的 Workspace 断连后，回退 preferredHost 会把保存请求发到
  // 另一个项目。失效当帧先移除写入目标，随后 effect 关闭编辑器，避免配置写错位置。
  const mcpEditorWorkspaceMissing = Boolean(
    mcpEditorOpen && mcpFormScopeKey && mcpFormScopeKey !== "user" && !effectiveMcpWorkspace,
  );
  const mcpTarget = mcpEditorWorkspaceMissing ? null : (effectiveMcpWorkspace ?? preferredHost);
  const effectiveCommandScopeKey =
    commandEditorOpen && commandFormScopeKey ? commandFormScopeKey : selectedScopeKey;
  const effectiveCommandWorkspace = workspaceTabs.find(
    (tab) => workspaceKey(tab) === effectiveCommandScopeKey,
  );
  const commandEditorWorkspaceMissing = Boolean(
    commandEditorOpen &&
    commandFormScopeKey &&
    commandFormScopeKey !== "user" &&
    !effectiveCommandWorkspace,
  );
  const commandTarget = commandEditorWorkspaceMissing
    ? null
    : (effectiveCommandWorkspace ?? preferredHost);

  useEffect(() => {
    if (!mcpEditorWorkspaceMissing) return;
    setMcpEditorOpen(false);
    setMcpFormScopeKey(null);
  }, [mcpEditorWorkspaceMissing]);

  useEffect(() => {
    if (!commandEditorWorkspaceMissing) return;
    setCommandEditorOpen(false);
    setCommandFormScopeKey(null);
  }, [commandEditorWorkspaceMissing]);

  useEffect(() => {
    if (
      pickedScopeKey !== "user" &&
      !workspaceTabs.some((tab) => workspaceKey(tab) === pickedScopeKey)
    ) {
      // 市场返回记录的是具体 workspace identity；目标已关闭或断连时，
      // 静默选中 User 会让用户误以为 Workspace 配置仍在展示，因此提示并显式切换。
      setPickedScopeKey("user");
      toast(
        intl.formatMessage({
          id: "settings.plugin.scopeUnavailableFallback",
        }),
      );
    }
  }, [intl, pickedScopeKey, workspaceTabs]);
  const selectedTargetKey = target ? workspaceKey(target) : "";

  const updatePluginCount = useCallback(
    (count: number) => {
      setCapabilityCounts((current) =>
        current.plugins === count ? current : { ...current, plugins: count },
      );
    },
    [selectedScope.key, selectedTargetKey],
  );
  const updateMcpCount = useCallback(
    (count: number) => {
      setCapabilityCounts((current) =>
        current.mcps === count ? current : { ...current, mcps: count },
      );
    },
    [selectedScope.key, selectedTargetKey],
  );
  const updateSkillCount = useCallback(
    (count: number) => {
      setCapabilityCounts((current) =>
        current.skills === count ? current : { ...current, skills: count },
      );
    },
    [selectedScope.key, selectedTargetKey],
  );
  const updateCommandCount = useCallback(
    (count: number) => {
      setCapabilityCounts((current) =>
        current.commands === count ? current : { ...current, commands: count },
      );
    },
    [selectedScope.key, selectedTargetKey],
  );
  const handleMcpEditorOpenChange = useCallback((open: boolean) => {
    setMcpEditorOpen(open);
    if (!open) setMcpFormScopeKey(null);
  }, []);

  return (
    <div className="space-y-6">
      {mode === "plugin" &&
      showMarketplaceBreadcrumb &&
      !pluginDetailOpen &&
      !mcpEditorOpen &&
      !skillDetailOpen ? (
        <SettingsBreadcrumbReporter
          items={[
            {
              label: intl.formatMessage({
                id: "settings.plugins.title",
              }),
            },
          ]}
          onSectionSelect={openPluginStoreForSelectedScope}
        />
      ) : null}
      <Tabs
        value={selectedTab}
        onValueChange={(value) => {
          if (mode === "plugin") {
            setInteractiveTab(normalizePluginTab(value as PluginTabTarget));
          }
        }}
      >
        {!mcpEditorOpen && !pluginDetailOpen && !commandEditorOpen ? (
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <PluginScopeMenu
                align="start"
                selectedScopeKey={selectedScopeKey}
                triggerTestId="plugin-settings-scope-trigger"
                userOptionTestId="plugin-settings-scope-user-option"
                workspaceOptionTestIdPrefix="plugin-settings-scope-option"
                workspaceTabs={workspaceTabs}
                onScopeKeyChange={setPickedScopeKey}
              />
              <div className="hidden h-4 w-px bg-border sm:block" aria-hidden="true" />
              {mode === "plugin" ? (
                <TabsList variant="line" className="h-7 max-w-full gap-1 overflow-x-auto p-0">
                  <TabsTrigger
                    value="plugins"
                    className="h-7 flex-none rounded-full px-3 hover:bg-hover data-active:!bg-selected data-active:hover:!bg-hover after:hidden"
                  >
                    {intl.formatMessage({
                      id: "settings.plugin.tab.plugins",
                    })}
                    <span className={getPluginTabCountClass("plugins", selectedTab)}>
                      {capabilityCounts.plugins}
                    </span>
                  </TabsTrigger>
                  <TabsTrigger
                    value="mcps"
                    className="h-7 flex-none rounded-full px-3 hover:bg-hover data-active:!bg-selected data-active:hover:!bg-hover after:hidden"
                  >
                    {intl.formatMessage({
                      id: "settings.plugin.tab.mcps",
                    })}
                    <span className={getPluginTabCountClass("mcps", selectedTab)}>
                      {capabilityCounts.mcps}
                    </span>
                  </TabsTrigger>
                  <TabsTrigger
                    value="skills"
                    className="h-7 flex-none rounded-full px-3 hover:bg-hover data-active:!bg-selected data-active:hover:!bg-hover after:hidden"
                  >
                    {intl.formatMessage({
                      id: "settings.plugin.tab.skills",
                    })}
                    <span className={getPluginTabCountClass("skills", selectedTab)}>
                      {capabilityCounts.skills}
                    </span>
                  </TabsTrigger>
                </TabsList>
              ) : (
                <div
                  data-independent-capability-count="true"
                  className="flex h-7 items-center gap-1 px-3 text-ui-base font-medium text-foreground"
                >
                  <span>
                    {intl.formatMessage({
                      id:
                        mode === "mcp"
                          ? "settings.plugin.tab.mcps"
                          : mode === "skill"
                            ? "settings.plugin.tab.skills"
                            : "settings.plugin.tab.commands",
                    })}
                  </span>
                  <span className="text-ui-sm text-foreground-subtle">
                    {mode === "mcp"
                      ? capabilityCounts.mcps
                      : mode === "skill"
                        ? capabilityCounts.skills
                        : capabilityCounts.commands}
                  </span>
                </div>
              )}
            </div>
            <SettingsSearchInput
              data-testid="plugin-settings-search"
              containerClassName="w-full sm:ml-auto sm:w-64"
              clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
              value={activeSearchQuery}
              onClear={() => {
                setSearchQueries((current) => ({
                  ...current,
                  [selectedTab]: "",
                }));
              }}
              onChange={(event) => {
                const value = event.target.value;
                setSearchQueries((current) => ({
                  ...current,
                  [selectedTab]: value,
                }));
              }}
              placeholder={intl.formatMessage({
                id:
                  selectedTab === "plugins"
                    ? "settings.plugin.plugins.searchPlaceholder"
                    : selectedTab === "mcps"
                      ? "settings.mcp.searchPlaceholder"
                      : selectedTab === "skills"
                        ? "settings.skills.searchPlaceholder"
                        : "settings.commands.searchPlaceholder",
              })}
            />
          </div>
        ) : null}
        {mode === "plugin" ? (
          <TabsContent
            forceMount
            value="plugins"
            className={
              pluginDetailOpen
                ? "data-[state=inactive]:hidden"
                : "mt-6 data-[state=inactive]:hidden"
            }
          >
            <PluginList
              target={target}
              configScope={selectedScope.kind === "user" ? "user" : "workspace"}
              isDesktop={isDesktop}
              isMacDesktop={isMacDesktop}
              isWindowsDesktop={isWindowsDesktop}
              searchQuery={searchQueries.plugins}
              onAdd={selectedScope.kind === "user" ? openPluginStoreForSelectedScope : undefined}
              onCreateTask={onCreateTask}
              onDetailOpenChange={setPluginDetailOpen}
              onOpenPluginStore={openPluginStoreForSelectedScope}
              showMarketplaceBreadcrumb={showMarketplaceBreadcrumb}
              onVisibleCountChange={updatePluginCount}
            />
          </TabsContent>
        ) : null}
        {mode === "plugin" || mode === "mcp" ? (
          <TabsContent
            forceMount
            value="mcps"
            className={
              mcpEditorOpen ? "data-[state=inactive]:hidden" : "mt-6 data-[state=inactive]:hidden"
            }
          >
            {mcpTarget ? (
              <McpSettingsSection
                workspacePath={mcpTarget.workspacePath}
                workspaceIdentity={mcpTarget.workspaceIdentity}
                remoteSessionId={mcpTarget.remoteSessionId}
                remoteTarget={mcpTarget.remoteTarget}
                localWorkspacePath={mcpTarget.localWorkspacePath}
                scopeFilter={effectiveMcpScopeKey === "user" ? "user" : "workspace"}
                parentScopeKey={selectedScopeKey}
                workspaceTabs={workspaceTabs}
                searchQuery={searchQueries.mcps}
                onVisibleCountChange={updateMcpCount}
                onEditorOpenChange={handleMcpEditorOpenChange}
                onFormScopeKeyChange={setMcpFormScopeKey}
                onOpenPluginStore={
                  selectedScope.kind === "user" ? openPluginStoreForSelectedScope : undefined
                }
                showMarketplaceBreadcrumb={showMarketplaceBreadcrumb}
              />
            ) : (
              <EmptyState
                message={intl.formatMessage({
                  id: "settings.plugin.noWorkspace",
                })}
              />
            )}
          </TabsContent>
        ) : null}
        {mode === "plugin" || mode === "skill" ? (
          <TabsContent forceMount value="skills" className="mt-6 data-[state=inactive]:hidden">
            {target ? (
              <SkillsSection
                workspacePath={target.workspacePath}
                workspaceIdentity={target.workspaceIdentity}
                remoteSessionId={target.remoteSessionId}
                remoteTarget={target.remoteTarget}
                scopeFilter={selectedScope.kind === "user" ? "user" : "workspace"}
                searchQuery={searchQueries.skills}
                onCreateTask={onCreateTask}
                onDetailOpenChange={setSkillDetailOpen}
                onOpenPluginStore={
                  selectedScope.kind === "user" ? openPluginStoreForSelectedScope : undefined
                }
                showMarketplaceBreadcrumb={showMarketplaceBreadcrumb}
                reportDetailBreadcrumb={mode === "plugin"}
                onVisibleCountChange={updateSkillCount}
              />
            ) : (
              <EmptyState
                message={intl.formatMessage({
                  id: "settings.plugin.noWorkspace",
                })}
              />
            )}
          </TabsContent>
        ) : null}
        {mode === "command" ? (
          <TabsContent
            forceMount
            value="commands"
            className={
              commandEditorOpen
                ? "data-[state=inactive]:hidden"
                : "mt-6 data-[state=inactive]:hidden"
            }
          >
            {commandTarget ? (
              <CommandsSection
                workspacePath={commandTarget.workspacePath}
                workspaceIdentity={commandTarget.workspaceIdentity}
                scopeFilter={effectiveCommandScopeKey === "user" ? "user" : "workspace"}
                parentScopeKey={selectedScopeKey}
                workspaceTabs={workspaceTabs}
                searchQuery={searchQueries.commands}
                onVisibleCountChange={updateCommandCount}
                onEditorOpenChange={setCommandEditorOpen}
                onFormScopeKeyChange={setCommandFormScopeKey}
              />
            ) : (
              <EmptyState
                message={intl.formatMessage({
                  id: "settings.plugin.noWorkspace",
                })}
              />
            )}
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  );
}
