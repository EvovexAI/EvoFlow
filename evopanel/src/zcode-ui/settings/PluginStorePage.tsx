/* eslint-disable max-lines -- 插件商店容器统一编排列表/详情、市场源对话框、卸载确认、试用跳转与技能刷新收尾，集中维护保证交互一致。 */
import { PluginAddMenu } from "@/settings/PluginAddMenu.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Settings } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { usePluginStoreOrder } from "@/hooks/usePluginStoreOrder.js";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { refreshSharedSkillStoreForWorkspace } from "@/lib/skillStoreRefresh.js";
import {
  PluginDetailRow,
  PluginHookDetails,
  PluginWarningList,
} from "@/settings/InstalledPluginManagement.js";
import { AddMarketplaceSourceDialog } from "@/settings/AddMarketplaceSourceDialog.js";
import { PluginStoreListView, type PluginStoreSegment } from "@/settings/PluginStoreListView.js";
import {
  PluginStoreAdvancedSection,
  PluginStoreDetailView,
} from "@/settings/PluginStoreDetailView.js";
import { PluginStoreSourcesDialog } from "@/settings/PluginStoreSourcesDialog.js";
import type { PluginStoreActions } from "@/settings/PluginStoreCard.js";
import {
  buildStoreItems,
  canUpdatePluginItem,
  isPluginUpdatePending,
  resolveItemDisplayName,
  resolvePluginDisplayName,
  type StorePluginItem,
} from "@/settings/pluginStoreListing.js";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID } from "@zcode/shared";
import { PluginUninstallConfirmDialog } from "@/settings/PluginUninstallConfirmDialog.js";
import { usePluginUninstall } from "@/settings/usePluginUninstall.js";
import { claimMarketplaceAutoRefresh } from "@/settings/officialMarketplaceAutoRefresh.js";
import { consumePluginStoreOpenTarget } from "@/lib/pluginStoreNavigation.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import {
  buildPluginStoreTryMention,
  buildPluginStoreTryPrompt,
} from "@/settings/pluginStoreTryPrompt.js";

interface PluginStorePageProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onManageInstalled: () => void;
}

type PluginStoreView = "store" | "detail";

export function PluginStorePage({
  workspacePath,
  workspaceIdentity,
  onCreateTask,
  onManageInstalled,
}: PluginStorePageProps) {
  const { intl, locale } = useZCodeIntl();
  const { order: storeOrder, refresh: refreshStoreOrder } = usePluginStoreOrder();
  const { pluginManagementService, skillsService } = useServices();
  const zcodeSessionService = useZCodeSessionService(
    workspacePath ?? undefined,
    undefined,
    workspaceIdentity,
  );
  const plugins = usePluginManagementStore((state) => state.plugins);
  const pluginDiagnostics = usePluginManagementStore((state) => state.diagnostics);
  const marketplaces = usePluginManagementStore((state) => state.marketplaces);
  const marketplaceAvailabilityKnown = usePluginManagementStore(
    (state) => state.marketplaceAvailabilityKnown,
  );
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  const installedPlugins = usePluginManagementStore((state) => state.installedPlugins);
  const restorableBuiltins = usePluginManagementStore((state) => state.restorableBuiltins);
  const loading = usePluginManagementStore((state) => state.loading);
  const loadedWorkspacePath = usePluginManagementStore((state) => state.workspacePath);
  const loadedWorkspaceIdentity = usePluginManagementStore((state) => state.workspaceIdentity);
  const error = usePluginManagementStore((state) => state.error);
  const operationId = usePluginManagementStore((state) => state.operationId);
  const describeCache = usePluginManagementStore((state) => state.describeCache);
  const initialize = usePluginManagementStore((state) => state.initialize);
  const updateMarketplace = usePluginManagementStore((state) => state.updateMarketplace);
  const addMarketplace = usePluginManagementStore((state) => state.addMarketplace);
  const removeMarketplace = usePluginManagementStore((state) => state.removeMarketplace);
  const installPlugin = usePluginManagementStore((state) => state.installPlugin);
  const describePlugin = usePluginManagementStore((state) => state.describePlugin);
  const updatePlugin = usePluginManagementStore((state) => state.updatePlugin);
  const restoreBuiltin = usePluginManagementStore((state) => state.restoreBuiltin);

  const [view, setView] = useState<PluginStoreView>("store");
  const [detailPluginId, setDetailPluginId] = useState<string | null>(null);
  const [segment, setSegment] = useState<PluginStoreSegment>("public");
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [addSourceOpen, setAddSourceOpen] = useState(false);
  const [addMarketplaceError, setAddMarketplaceError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // 返回列表页时恢复进入详情前的滚动位置（设置页 main 容器滚动）。
  const storeScrollTopRef = useRef(0);
  const [initialNavigationTarget] = useState(() => consumePluginStoreOpenTarget());
  const initialNavigationTargetRef = useRef(initialNavigationTarget);
  useEffect(() => {
    if (initialNavigationTarget?.intent === "add-marketplace") setAddSourceOpen(true);
  }, [initialNavigationTarget]);

  const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || null;

  useEffect(() => {
    if (!workspacePath) {
      return;
    }
    // Marketplace 只管理 Host User inventory；即使从 Workspace 当前窗口打开，也不能把
    // Workspace config 投影带入市场，否则会让项目配置看起来像安装 scope。
    void initialize({
      workspacePath,
      workspaceIdentity,
      configScope: "user",
      pluginService: pluginManagementService,
    });
  }, [initialize, pluginManagementService, workspaceIdentity, workspacePath]);

  // 目录自动刷新（Catalog Auto-Refresh）：只针对 ZCode 官方市场。每次进入商店页都刷新 CDN 目录，
  // 否则新上架插件要等用户手动点刷新才可见；以 10 分钟窗口节流，并在发起时占位防抖（失败/在飞不重复），
  // 判据见 officialMarketplaceAutoRefresh。状态放模块级而非组件 ref，因为每次进入都是重新挂载。
  useEffect(() => {
    const official = marketplaces.find((item) => item.id === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID);
    if (
      official &&
      claimMarketplaceAutoRefresh(ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID, official.lastUpdated)
    ) {
      void updateMarketplace(ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID, pluginManagementService);
    }
  }, [marketplaces, pluginManagementService, updateMarketplace]);

  const items = useMemo(
    () =>
      buildStoreItems({
        marketplaces,
        marketplaceAvailabilityKnown,
        availablePlugins,
        installedPlugins,
        plugins,
        restorableBuiltins,
      }),
    [
      availablePlugins,
      installedPlugins,
      marketplaceAvailabilityKnown,
      marketplaces,
      plugins,
      restorableBuiltins,
    ],
  );
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const detailItem = detailPluginId ? (itemById.get(detailPluginId) ?? null) : null;
  // 插件自身 warning 诊断（如声明的技能路径扫描为空）：详情高级区展示，避免静默失败。
  const detailPluginInfo = detailItem?.info;
  const detailPluginWarnings = detailPluginInfo
    ? pluginDiagnostics.filter(
        (diagnostic) =>
          diagnostic.pluginId === detailPluginInfo.id && diagnostic.severity === "warning",
      )
    : [];

  // 详情页数据补齐：无运行时信息的条目（未安装候选）按需 describe，拿组件清单 + manifest 回退字段。
  useEffect(() => {
    if (view !== "detail" || !detailItem || detailItem.info) return;
    void describePlugin(
      detailItem.id,
      detailItem.name,
      detailItem.marketplace,
      pluginManagementService,
    );
  }, [describePlugin, detailItem, pluginManagementService, view]);

  // 详情条目消失（卸载可恢复内置后 restorable 记录被移除等）时回到列表，避免空详情。
  useEffect(() => {
    if (view === "detail" && detailPluginId && !itemById.has(detailPluginId)) {
      setView("store");
      setDetailPluginId(null);
    }
  }, [detailPluginId, itemById, view]);

  const scrollContainer = (): HTMLElement | null => rootRef.current?.closest("main") ?? null;

  const openDetail = useCallback((pluginId: string) => {
    storeScrollTopRef.current =
      (rootRef.current?.closest("main") as HTMLElement | null)?.scrollTop ?? 0;
    setDetailPluginId(pluginId);
    setView("detail");
    requestAnimationFrame(() => {
      const main = rootRef.current?.closest("main");
      if (main) main.scrollTop = 0;
    });
  }, []);

  useEffect(() => {
    const target = initialNavigationTargetRef.current;
    if (
      !target?.pluginId ||
      loading ||
      loadedWorkspacePath !== workspacePath ||
      loadedWorkspaceIdentity !== normalizedWorkspaceIdentity
    ) {
      return;
    }
    initialNavigationTargetRef.current = null;
    if (itemById.has(target.pluginId)) {
      openDetail(target.pluginId);
      return;
    }
    // 刷新后候选仍不存在时保留 stable ID 搜索，让用户看到明确的空结果而不是错误详情。
    setView("store");
    setQuery(target.pluginId);
  }, [
    itemById,
    loadedWorkspaceIdentity,
    loadedWorkspacePath,
    loading,
    normalizedWorkspaceIdentity,
    openDetail,
    workspacePath,
  ]);

  const backToStore = useCallback(() => {
    setView("store");
    setDetailPluginId(null);
    requestAnimationFrame(() => {
      const main = scrollContainer();
      if (main) main.scrollTop = storeScrollTopRef.current;
    });
  }, []);

  // 顶栏刷新 = 真网络更新：updateMarketplace(null) 重拉全部市场 manifest（含 CDN 与 git 源，
  // 操作内部完成后会重载概览），随后按更新徽标数量给完成提示。只做本地重载时，
  // 用户点了刷新看不到 CDN 新插件（与规格「刷新→update(null)」不符）。
  const handleRefresh = async () => {
    void refreshStoreOrder(true);
    setRefreshing(true);
    try {
      await handleCheckForUpdates();
    } finally {
      setRefreshing(false);
    }
  };

  // 插件 package 变更（安装 / 卸载 / 更新）后统一收尾：失效草稿会话并刷新技能，
  // 避免会话里残留悬挂或旧版本能力。
  const refreshAfterPluginChange = useCallback(async () => {
    await invalidateDeferredDraftSessionForSkillChange({
      zcodeSessionService,
      workspacePath,
      workspaceIdentity: normalizedWorkspaceIdentity ?? undefined,
      reason: "settings-plugin-enabled",
    });
    await refreshSharedSkillStoreForWorkspace({
      workspacePath,
      workspaceIdentity: normalizedWorkspaceIdentity,
      skillsService,
    });
  }, [normalizedWorkspaceIdentity, skillsService, workspacePath, zcodeSessionService]);

  const uninstall = usePluginUninstall({
    pluginService: pluginManagementService,
    installedPlugins,
    plugins,
    operationId,
    onAfterUninstall: async () => {
      await refreshAfterPluginChange();
    },
  });

  const handleInstall = useCallback(
    async (item: StorePluginItem) => {
      if (item.restorable) {
        await restoreBuiltin(item.id, pluginManagementService);
      } else {
        await installPlugin(item.name, item.marketplace, pluginManagementService, "user");
      }
      // 安装/恢复会引入新技能与命令，与启停/卸载一样做一次收尾刷新。
      await refreshAfterPluginChange();
    },
    [installPlugin, pluginManagementService, refreshAfterPluginChange, restoreBuiltin],
  );

  const handleUpdatePlugin = useCallback(
    async (pluginId: string) => {
      await updatePlugin(pluginId, pluginManagementService);
      if (usePluginManagementStore.getState().error) {
        return;
      }
      // 升级会同时替换 Skill、Command 与 MCP 定义；旧入口只刷新商店列表，
      // 已预热的草稿 session 继续携带旧版本甚至空能力，导致“升级成功”后新会话仍不可用。
      await refreshAfterPluginChange();
    },
    [pluginManagementService, refreshAfterPluginChange, updatePlugin],
  );

  const handleCheckForUpdates = useCallback(async () => {
    const succeeded = await updateMarketplace(null, pluginManagementService);
    if (!succeeded) {
      const message = usePluginManagementStore.getState().error;
      if (message) {
        toast(message);
      }
      return;
    }
    const pendingCount = usePluginManagementStore
      .getState()
      .installedPlugins.filter((item) => isPluginUpdatePending(item.updateStatus)).length;
    if (pendingCount > 0) {
      toast(
        intl.formatMessage(
          { id: "settings.plugins.checkForUpdates.found" },
          { count: String(pendingCount) },
        ),
      );
      return;
    }
    toast(intl.formatMessage({ id: "settings.plugins.checkForUpdates.none" }));
  }, [intl, pluginManagementService, updateMarketplace]);

  const handleAddMarketplace = useCallback(
    async (source: string) => {
      const succeeded = await addMarketplace(source, pluginManagementService);
      // 添加市场源的错误要和提交入口同层展示；否则全局错误条会被 Dialog 遮罩压到下面。
      setAddMarketplaceError(
        succeeded ? null : (usePluginManagementStore.getState().error ?? null),
      );
      // 自定义市场不属于公开分段；添加成功后直接切到「个人」，让用户立刻看到刚加的来源。
      if (succeeded) setSegment("personal");
      return succeeded;
    },
    [addMarketplace, pluginManagementService],
  );

  const handleUsePrompt = useCallback(
    (item: StorePluginItem, prompt: string) => {
      // 未安装时点提示词先引导安装，不新建会话。
      if (!item.installed) {
        void handleInstall(item);
        return;
      }
      if (!workspacePath || !onCreateTask) {
        return;
      }
      // 原入口绕过 Root 的标准新建任务编排，只写 session store，
      // Settings 遮罩不会退出，composer remount 还可能覆盖预填。现在统一委托 Root，
      // 同时复用 @ Picker 的 canonical Plugin 链接，不新增第二套引用语义。
      onCreateTask({
        initialPrompt: buildPluginStoreTryPrompt({ item, locale, prompt }),
        initialPromptMention: buildPluginStoreTryMention({ item, locale }),
      });
    },
    [handleInstall, locale, onCreateTask, workspacePath],
  );

  const actions: PluginStoreActions = useMemo(
    () => ({
      onOpenDetail: openDetail,
      onInstall: (item) => void handleInstall(item),
      onUninstall: uninstall.requestUninstall,
      onUpdate: (pluginId) => void handleUpdatePlugin(pluginId),
      operationId,
      togglingPluginId: null,
    }),
    [handleInstall, handleUpdatePlugin, openDetail, operationId, uninstall.requestUninstall],
  );

  if (!workspacePath) {
    return (
      <div className="rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.plugins.noWorkspace" })}
      </div>
    );
  }

  const detailUpdatePending = canUpdatePluginItem(detailItem);

  return (
    <div ref={rootRef} className="space-y-5" data-testid="plugin-store-root" data-view={view}>
      <SettingsBreadcrumbReporter
        items={
          view === "detail" && detailItem
            ? [{ label: resolveItemDisplayName(detailItem, locale) }]
            : []
        }
        onSectionSelect={backToStore}
      />
      {view === "store" ? (
        <h1
          data-testid="plugin-store-title"
          className="text-2xl font-semibold tracking-tight text-foreground lg:text-3xl"
        >
          {intl.formatMessage({ id: "workspace.openPluginsSettings" })}
        </h1>
      ) : null}
      {view === "store" ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="min-w-0 flex-1 text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({ id: "settings.plugins.store.subtitle" })}
          </p>
          {/* 顶栏动作：刷新 / 市场源管理（齿轮）/ 新建市场源。 */}
          <div className="flex shrink-0 items-center gap-2">
            <ControlHintTooltip
              title={
                refreshing
                  ? intl.formatMessage({ id: "settings.plugins.refreshing" })
                  : intl.formatMessage({ id: "settings.plugins.refresh" })
              }
            >
              <Button
                type="button"
                data-testid="plugin-store-refresh"
                variant="outline"
                size="icon-lg"
                aria-label={
                  refreshing
                    ? intl.formatMessage({ id: "settings.plugins.refreshing" })
                    : intl.formatMessage({ id: "settings.plugins.refresh" })
                }
                onClick={() => void handleRefresh()}
                disabled={refreshing}
              >
                <RefreshCw
                  className={refreshing ? "size-3.5 animate-spin" : "size-3.5"}
                  aria-hidden="true"
                />
              </Button>
            </ControlHintTooltip>
            <ControlHintTooltip
              title={intl.formatMessage({ id: "settings.plugins.store.sources.title" })}
            >
              <Button
                type="button"
                data-testid="plugin-store-sources-open"
                variant="outline"
                size="icon-lg"
                aria-label={intl.formatMessage({ id: "settings.plugins.store.sources.title" })}
                onClick={() => setSourcesOpen(true)}
              >
                <Settings className="size-3.5" aria-hidden="true" />
              </Button>
            </ControlHintTooltip>
            <PluginAddMenu
              testId="plugin-store-create"
              onCreateTask={onCreateTask}
              onAddMarketplace={() => {
                setAddMarketplaceError(null);
                setAddSourceOpen(true);
              }}
            />
          </div>
        </div>
      ) : null}

      {error && !addSourceOpen ? (
        <div
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive"
          data-testid="plugin-store-error"
        >
          {error}
        </div>
      ) : null}

      {view === "detail" && detailItem ? (
        <PluginStoreDetailView
          item={detailItem}
          actions={actions}
          describeEntry={describeCache[detailItem.id]}
          onRetryDescribe={() =>
            void describePlugin(
              detailItem.id,
              detailItem.name,
              detailItem.marketplace,
              pluginManagementService,
              true,
            )
          }
          onUsePrompt={handleUsePrompt}
          advanced={
            detailItem.info ? (
              <div className="space-y-4">
                {detailUpdatePending ? (
                  <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-ui-base font-medium text-foreground">
                        {detailItem.installedMeta?.updateStatus === "update-available"
                          ? intl.formatMessage(
                              { id: "settings.plugins.detail.updateAvailable" },
                              { version: detailItem.installedMeta?.latestVersion ?? "" },
                            )
                          : intl.formatMessage({ id: "settings.plugins.detail.versionChanged" })}
                      </p>
                      <p className="text-ui-xs text-foreground-subtle">
                        {intl.formatMessage({
                          id: "settings.plugins.detail.updateNewSessionsNote",
                        })}
                      </p>
                    </div>
                    <Button
                      type="button"
                      data-testid="plugin-store-detail-update"
                      variant="outline"
                      size="sm"
                      disabled={operationId === `plugin:update:${detailItem.id}`}
                      onClick={() => void handleUpdatePlugin(detailItem.id)}
                    >
                      {intl.formatMessage({ id: "settings.plugins.detail.update" })}
                    </Button>
                  </div>
                ) : null}
                <PluginStoreAdvancedSection>
                  {detailPluginWarnings.length > 0 ? (
                    <div>
                      <div className="mb-2 text-ui-xs font-medium text-foreground">
                        {intl.formatMessage({ id: "settings.plugins.detail.warnings" })}
                      </div>
                      <PluginWarningList warnings={detailPluginWarnings} />
                    </div>
                  ) : null}
                  <PluginDetailRow
                    label={intl.formatMessage({ id: "settings.plugins.detail.rootPath" })}
                    value={detailItem.info.rootPath}
                  />
                  {(detailItem.info.hookDetails ?? []).length > 0 ? (
                    <PluginHookDetails hooks={detailItem.info.hookDetails ?? []} />
                  ) : null}
                </PluginStoreAdvancedSection>
              </div>
            ) : undefined
          }
        />
      ) : (
        <PluginStoreListView
          order={storeOrder}
          items={items}
          marketplaces={marketplaces}
          actions={actions}
          loading={loading || (operationId?.startsWith("marketplace:update:") ?? false)}
          query={query}
          onQueryChange={setQuery}
          segment={segment}
          onSegmentChange={setSegment}
          onOpenManage={onManageInstalled}
        />
      )}

      <PluginUninstallConfirmDialog
        open={uninstall.pendingPlugin !== null}
        pluginName={
          uninstall.pendingPlugin
            ? resolvePluginDisplayName(
                itemById.get(uninstall.pendingPlugin.id) ?? {
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
      <PluginStoreSourcesDialog
        open={sourcesOpen}
        onOpenChange={setSourcesOpen}
        marketplaces={marketplaces}
        onUpdateMarketplace={(marketplace) =>
          void updateMarketplace(marketplace, pluginManagementService)
        }
        onRemoveMarketplace={(marketplace) =>
          void removeMarketplace(marketplace, pluginManagementService)
        }
        operationId={operationId}
      />
      <AddMarketplaceSourceDialog
        open={addSourceOpen}
        onOpenChange={setAddSourceOpen}
        onAddMarketplace={handleAddMarketplace}
        operationId={operationId}
        error={addMarketplaceError}
      />
    </div>
  );
}
