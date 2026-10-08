/* eslint-disable max-lines -- Hooks 页面聚合 Scope、插件投影、搜索与配置写入流程。 */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { Hook, HookConfig, ZCodeInstalledPluginSummary, ZCodePluginInfo } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { invalidateDeferredDraftSessionForRuntimeChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { useHooksStore } from "@/store/hooksStore.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import { HookForm } from "./HookForm.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { getWorkspaceKey } from "@/lib/workspaceKey.js";
import { HooksList, type HookScope, type PluginHookRow } from "./HooksList.js";
import { useWorkspaceHookInlineTrust } from "./useWorkspaceHookInlineTrust.js";
import { useWorkspaceHookReviewStore } from "@/store/workspaceHookReviewStore.js";
import {
  PluginScopeMenu,
  getPluginWorkspaceKey,
  isPluginScopeWorkspaceConnected,
} from "@/settings/PluginScopeMenu.js";
import { PluginLoadingState, PluginSearchEmptyState } from "@/settings/PluginInstallEmptyState.js";
import {
  resolvePluginDisplayName,
  resolveUniquePluginListingByName,
} from "@/settings/pluginStoreListing.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import {
  shouldShowWorkspaceHookTrustNotice,
  WorkspaceHookTrustNotice,
} from "@/settings/WorkspaceHookTrustNotice.js";

interface HooksSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
}

function isEditableHook(hook: Hook): boolean {
  // workspace-hook-trust：运行时 discovery 会下发 editable 标志（工作区 Hook 在
  // runtime 侧不可直接改配置），优先尊重；本地 Settings 发现路径无该标志时回退旧规则。
  return hook.editable ?? (!hook.location || hook.location.source === "zcode");
}

// workspace-hook-trust：editable=false 且 source=zcode 的行是「上游/祖先 zcode.json
// 里的只读工作区 Hook」。它们不是外部格式兼容导入源，塞进 Legacy 会让 Import 按钮
// 必然失败（importHook 拒绝 source=zcode），也违反「只读但可逐条 Trust」的约定。
// 这类行应留在 Installed 分组，由信任状态门控 Switch，走行内 Trust 流程。
function isReadOnlyZCodeHook(hook: Hook): boolean {
  return hook.editable === false && (hook.location?.source ?? "zcode") === "zcode";
}

function isInCompatibilitySection(hook: Hook): boolean {
  return !isEditableHook(hook) && !isReadOnlyZCodeHook(hook);
}

/**
 * workspace-hook-trust：解析「最新 review binding」对应的 scope 切换目标。
 * 纯函数（供 HooksSection 与单测共用）：
 * - 按 request.createdAt 取最新 binding（同一 runtime flow 的 generation 递增也会
 *   刷新 createdAt，语义是「最新出现的审核」）；
 * - identity 优先精确匹配 tab 的 scope key；无 identity 的旧本地 binding 才按
 *   workspacePath 回退（与 matchesWorkspaceBinding 的降级规则一致）；
 * - 找不到对应 tab（workspace 已关闭/未知）返回 null——调用方不得切过去。
 */
function resolveLatestReviewScopeTarget(
  bindings: Record<
    string,
    {
      request: { interactionId: string; createdAt: number; workspaceIdentity?: string };
      workspacePath: string;
    }
  >,
  workspaceTabs: readonly { workspacePath: string; workspaceIdentity?: string }[],
): { interactionId: string; scopeKey: string } | null {
  let latest: {
    interactionId: string;
    createdAt: number;
    workspaceIdentity?: string;
    workspacePath: string;
  } | null = null;
  for (const binding of Object.values(bindings)) {
    if (!latest || binding.request.createdAt > latest.createdAt) {
      latest = {
        interactionId: binding.request.interactionId,
        createdAt: binding.request.createdAt,
        workspaceIdentity: binding.request.workspaceIdentity,
        workspacePath: binding.workspacePath,
      };
    }
  }
  if (!latest) return null;
  // key 规则与 getPluginWorkspaceKey 一致（identity 优先，回退 workspacePath），
  // 这里内联而非复用，避免 helper 依赖 WorkspaceTabState 完整类型、便于单测。
  const scopeKeyOf = (tab: { workspacePath: string; workspaceIdentity?: string }) =>
    tab.workspaceIdentity?.trim() || tab.workspacePath;
  const identity = latest.workspaceIdentity?.trim();
  const tab = identity
    ? workspaceTabs.find((candidate) => scopeKeyOf(candidate) === identity)
    : workspaceTabs.find((candidate) => candidate.workspacePath === latest!.workspacePath);
  return tab ? { interactionId: latest.interactionId, scopeKey: scopeKeyOf(tab) } : null;
}

function buildPluginHookRows(
  plugins: readonly Pick<ZCodePluginInfo, "enabled" | "hookDetails" | "id" | "name">[],
  installedPlugins: readonly Pick<ZCodeInstalledPluginSummary, "id" | "scope">[],
  scopeMetadataKnown: boolean,
): PluginHookRow[] {
  const scopeByPluginId = new Map(
    installedPlugins.map((plugin) => [plugin.id, plugin.scope] as const),
  );
  return plugins.flatMap((plugin) =>
    (plugin.hookDetails ?? []).map((detail) => ({
      detail,
      pluginEnabled: plugin.enabled,
      pluginId: plugin.id,
      pluginName: plugin.name,
      // overview 降级时 installedPlugins=[] 表示 scope 未知，不能伪造成 User。
      pluginScope: scopeMetadataKnown ? scopeByPluginId.get(plugin.id) : undefined,
    })),
  );
}

function filterPluginHooksByScope(
  pluginHooks: readonly PluginHookRow[],
  scope: HookScope,
): PluginHookRow[] {
  const expectedScope = scope === "project" ? "workspace" : "user";
  // 未知 scope 在两个 Tab 都保留并由列表标记，避免降级时隐藏真实存在的插件 Hook。
  return pluginHooks.filter(
    (hook) => hook.pluginScope === undefined || hook.pluginScope === expectedScope,
  );
}

export function HooksSection({ workspacePath, workspaceIdentity }: HooksSectionProps) {
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const hooksState = useHooksStore();
  const plugins = usePluginManagementStore((state) => state.plugins);
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  const installedPlugins = usePluginManagementStore((state) => state.installedPlugins);
  const marketplaceAvailabilityKnown = usePluginManagementStore(
    (state) => state.marketplaceAvailabilityKnown,
  );
  const pluginsLoading = usePluginManagementStore((state) => state.loading);
  const pluginsError = usePluginManagementStore((state) => state.error);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  const [viewMode, setViewMode] = useState<"list" | "form">("list");
  const [editingHook, setEditingHook] = useState<Hook | null>(null);
  const [query, setQuery] = useState("");
  const tabs = useTabStore((state) => state.tabs);
  const workspaceTabs = useMemo(() => {
    const seen = new Set<string>();
    return tabs
      .filter(isWorkspaceTab)
      .filter(isPluginScopeWorkspaceConnected)
      .filter((tab) => {
        const key = getPluginWorkspaceKey(tab);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [tabs]);
  const [selectedScopeKey, setSelectedScopeKey] = useState("user");
  const deferredQuery = useDeferredValue(query);
  const selectedWorkspace = workspaceTabs.find(
    (tab) => getPluginWorkspaceKey(tab) === selectedScopeKey,
  );
  const activeScope: HookScope = selectedWorkspace ? "project" : "user";
  const targetWorkspacePath = selectedWorkspace?.workspacePath ?? workspacePath;
  const targetWorkspaceIdentity = selectedWorkspace?.workspaceIdentity ?? workspaceIdentity;
  const targetWorkspaceKey = targetWorkspacePath
    ? getWorkspaceKey(targetWorkspacePath, targetWorkspaceIdentity)
    : null;
  const targetServiceResolution = useWorkspaceServicesResolution(
    targetWorkspacePath,
    selectedWorkspace?.remoteSessionId,
    targetWorkspaceIdentity,
    selectedWorkspace?.remoteTarget,
  );
  // Scope 切到另一个远程 workspace 后，路径已切换但 hooks/plugin 服务仍来自
  // 当前激活 workspace。这里让服务 host 与 target 身份同源，等待连接时不发送越界 RPC。
  const { hooksService, pluginManagementService } = targetServiceResolution.services;
  const zcodeSessionService = useZCodeSessionService(
    targetWorkspacePath ?? undefined,
    undefined,
    targetWorkspaceIdentity,
  );
  // workspace-hook-trust：信任操作绑定到当前选中的 workspace（多 workspace scope 场景
  // 下 review binding 可能属于其他 workspace，此时切换 scope 菜单到对应 workspace）。
  // hooksService 必须传 target 解析结果：scope 选中远程 workspace 时 context 服务指向
  // 激活 tab 的 host，越界 RPC 会打到错误 host。
  const { trustActionAvailable, trustingHookId, trustHook } = useWorkspaceHookInlineTrust({
    workspacePath: targetWorkspacePath,
    workspaceIdentity: targetWorkspaceIdentity,
    hooksService: targetServiceResolution.rpcReady ? hooksService : undefined,
    rpcReady: targetServiceResolution.rpcReady,
  });
  const reviewBindings = useWorkspaceHookReviewStore((state) => state.bindings);

  const editableHooks = useMemo(
    () =>
      hooksState.hooks.filter(
        (hook) =>
          (isEditableHook(hook) || isReadOnlyZCodeHook(hook)) &&
          (hook.location?.scope ?? "user") === activeScope,
      ),
    [activeScope, hooksState.hooks],
  );
  const compatibilityHooks = useMemo(
    () =>
      hooksState.hooks.filter(
        (hook) =>
          isInCompatibilitySection(hook) && (hook.location?.scope ?? "user") === activeScope,
      ),
    [activeScope, hooksState.hooks],
  );
  const pluginHooks = useMemo(
    () => buildPluginHookRows(plugins, installedPlugins, marketplaceAvailabilityKnown),
    [installedPlugins, marketplaceAvailabilityKnown, plugins],
  );
  const pluginListingById = useMemo(
    () => new Map(availablePlugins.map((plugin) => [plugin.id, plugin.listing])),
    [availablePlugins],
  );
  const scopedPluginHooks = useMemo(
    () =>
      filterPluginHooksByScope(pluginHooks, activeScope).map((hook) => ({
        ...hook,
        pluginIconItem: {
          name: hook.pluginName,
          listing: pluginListingById.get(hook.pluginId),
        },
      })),
    [activeScope, pluginHooks, pluginListingById],
  );
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const filteredEditableHooks = useMemo(
    () => editableHooks.filter((hook) => hookMatchesQuery(hook, normalizedQuery)),
    [editableHooks, normalizedQuery],
  );
  const filteredCompatibilityHooks = useMemo(
    () => compatibilityHooks.filter((hook) => hookMatchesQuery(hook, normalizedQuery)),
    [compatibilityHooks, normalizedQuery],
  );
  const filteredPluginHooks = useMemo(
    () =>
      scopedPluginHooks.filter((hook) =>
        [
          hook.pluginName,
          hook.detail.event,
          hook.detail.type,
          hook.detail.matcher,
          hook.detail.command,
          hook.detail.sourcePath,
        ].some((value) => value?.toLowerCase().includes(normalizedQuery)),
      ),
    [normalizedQuery, scopedPluginHooks],
  );

  useEffect(() => {
    if (!targetServiceResolution.rpcReady) return;
    void hooksState.initialize(
      targetWorkspacePath ?? undefined,
      targetWorkspaceIdentity,
      hooksService,
    );
  }, [
    hooksService,
    hooksState.initialize,
    targetServiceResolution.rpcReady,
    targetWorkspaceIdentity,
    targetWorkspacePath,
  ]);

  useEffect(() => {
    if (!targetWorkspacePath || !targetServiceResolution.rpcReady) return;
    void initializePlugins({
      workspacePath: targetWorkspacePath,
      workspaceIdentity: targetWorkspaceIdentity,
      pluginService: pluginManagementService,
    });
  }, [
    initializePlugins,
    pluginManagementService,
    targetServiceResolution.rpcReady,
    targetWorkspaceIdentity,
    targetWorkspacePath,
  ]);

  const handleRefresh = useCallback(async () => {
    if (!targetServiceResolution.rpcReady) return;
    await Promise.all([
      hooksState.initialize(
        targetWorkspacePath ?? undefined,
        targetWorkspaceIdentity,
        hooksService,
      ),
      targetWorkspacePath
        ? initializePlugins({
            workspacePath: targetWorkspacePath,
            workspaceIdentity: targetWorkspaceIdentity,
            pluginService: pluginManagementService,
          })
        : Promise.resolve(),
    ]);
  }, [
    hooksService,
    hooksState.initialize,
    initializePlugins,
    pluginManagementService,
    targetServiceResolution.rpcReady,
    targetWorkspaceIdentity,
    targetWorkspacePath,
  ]);

  useEffect(() => {
    if (
      selectedScopeKey !== "user" &&
      !workspaceTabs.some((tab) => getPluginWorkspaceKey(tab) === selectedScopeKey)
    ) {
      setSelectedScopeKey("user");
    }
  }, [selectedScopeKey, workspaceTabs]);

  // workspace-hook-trust（修复）：会话区对 workspace B 发起审核时，把 scope 菜单
  // 自动切到 B 一次。两条硬约束：
  // 1. 只在「新 interaction 出现」时切——B 的 review 仍 pending 期间用户手动切去
  //    A/User 属于主动选择，不得被持续抢回（否则 pending 期间设置页被锁死在 B）。
  // 2. 目标 workspace 必须仍存在于 workspaceTabs——binding 指向已关闭/断连的
  //    workspace 时切过去只会停在 Connecting，还会与上面的「失效 scope 重置 user」
  //    effect 形成乒乓循环。
  const latestReviewScopeTarget = useMemo(
    () => resolveLatestReviewScopeTarget(reviewBindings, workspaceTabs),
    [reviewBindings, workspaceTabs],
  );
  const handledReviewInteractionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!latestReviewScopeTarget) return;
    if (handledReviewInteractionRef.current === latestReviewScopeTarget.interactionId) return;
    handledReviewInteractionRef.current = latestReviewScopeTarget.interactionId;
    if (latestReviewScopeTarget.scopeKey !== selectedScopeKey) {
      setSelectedScopeKey(latestReviewScopeTarget.scopeKey);
    }
  }, [latestReviewScopeTarget, selectedScopeKey]);

  const invalidateDraft = useCallback(
    async (reason: string) => {
      await invalidateDeferredDraftSessionForRuntimeChange({
        logScope: "hooks",
        reason,
        workspaceIdentity: targetWorkspaceIdentity,
        workspacePath: targetWorkspacePath,
        zcodeSessionService,
      });
    },
    [targetWorkspaceIdentity, targetWorkspacePath, zcodeSessionService],
  );

  const handleSaveHook = useCallback(
    async (config: HookConfig) => {
      try {
        if (editingHook) {
          await hooksState.updateHook(editingHook.id, config, hooksService);
          await invalidateDraft("hook-updated");
        } else {
          await hooksState.addHook(config, hooksService);
          await invalidateDraft("hook-added");
        }
        setViewMode("list");
        setEditingHook(null);
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      }
    },
    [editingHook, hooksService, hooksState.addHook, hooksState.updateHook, invalidateDraft],
  );
  const handleCreateHook = useCallback(() => {
    setEditingHook(null);
    setViewMode("form");
  }, []);

  const handleDelete = useCallback(
    async (hook: Hook) => {
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "settings.hooks.delete" }),
        description: intl.formatMessage(
          { id: "settings.hooks.deleteDescription" },
          { event: hook.event },
        ),
        confirmLabel: intl.formatMessage({ id: "common.delete" }),
      });
      if (!confirmed) return;
      try {
        await hooksState.deleteHook(hook.id, hooksService);
        await invalidateDraft("hook-deleted");
        setEditingHook(null);
        setViewMode("list");
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      }
    },
    [confirmDialog, hooksService, hooksState.deleteHook, intl, invalidateDraft],
  );

  const handleToggle = useCallback(
    async (hook: Hook, enabled: boolean) => {
      try {
        await hooksState.toggleHook(hook.id, enabled, hooksService);
        await invalidateDraft(enabled ? "hook-enabled" : "hook-disabled");
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      }
    },
    [hooksService, hooksState.toggleHook, invalidateDraft],
  );

  const handleImport = useCallback(
    async (hook: Hook) => {
      try {
        await hooksState.importHook(hook.id, hooksService);
        await invalidateDraft("hook-imported");
        toast(intl.formatMessage({ id: "settings.hooks.imported" }));
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      }
    },
    [hooksService, hooksState.importHook, intl, invalidateDraft],
  );

  if (viewMode === "form" && targetServiceResolution.rpcReady) {
    return (
      <>
        <SettingsBreadcrumbReporter
          items={[
            {
              label: editingHook?.event ?? intl.formatMessage({ id: "settings.hooks.add" }),
            },
          ]}
          onSectionSelect={() => {
            setEditingHook(null);
            setViewMode("list");
          }}
        />
        <HookForm
          hook={editingHook ?? undefined}
          workspaceAvailable={Boolean(targetWorkspacePath)}
          defaultStorageLevel={activeScope}
          selectedScopeKey={selectedScopeKey}
          workspaceTabs={workspaceTabs}
          onScopeKeyChange={setSelectedScopeKey}
          onSave={handleSaveHook}
          onDelete={editingHook ? handleDelete : undefined}
          onCancel={() => {
            setEditingHook(null);
            setViewMode("list");
          }}
          isEditing={Boolean(editingHook)}
        />
      </>
    );
  }

  const loading = hooksState.loading || pluginsLoading;
  const error = hooksState.error || pluginsError;
  const visibleCount =
    filteredEditableHooks.length + filteredCompatibilityHooks.length + filteredPluginHooks.length;
  const totalCount = editableHooks.length + compatibilityHooks.length + scopedPluginHooks.length;
  const hasSearchResultEmpty = Boolean(normalizedQuery) && visibleCount === 0;
  const showWorkspaceHookTrustNotice = shouldShowWorkspaceHookTrustNotice({
    hooks: editableHooks,
    loadedWorkspaceKey: hooksState.loadedWorkspaceKey,
    rpcReady: targetServiceResolution.rpcReady,
    targetWorkspaceKey,
  });
  return (
    <div className="space-y-6" data-testid="hooks-settings-section">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <PluginScopeMenu
            align="start"
            selectedScopeKey={selectedScopeKey}
            workspaceTabs={workspaceTabs}
            onScopeKeyChange={setSelectedScopeKey}
          />
          <div className="hidden h-4 w-px bg-border sm:block" aria-hidden="true" />
          <div
            data-independent-capability-count="true"
            className="flex h-7 items-center gap-1 px-3 text-ui-base font-medium text-foreground"
          >
            <span>{intl.formatMessage({ id: "settings.hooks.title" })}</span>
            <span className="text-ui-sm text-foreground-subtle">{visibleCount}</span>
          </div>
        </div>
        <SettingsSearchInput
          containerClassName="w-full sm:ml-auto sm:w-64"
          clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
          value={query}
          onClear={() => setQuery("")}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={intl.formatMessage({
            id: "settings.hooks.searchPlaceholder",
          })}
        />
      </div>

      {showWorkspaceHookTrustNotice ? <WorkspaceHookTrustNotice hooks={editableHooks} /> : null}

      {targetServiceResolution.rpcReady && error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
          {error}
        </div>
      ) : null}

      {!targetServiceResolution.rpcReady ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.connecting" })} />
      ) : loading && totalCount === 0 ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.loading" })} />
      ) : hasSearchResultEmpty ? (
        <PluginSearchEmptyState label={intl.formatMessage({ id: "settings.hooks.searchEmpty" })} />
      ) : (
        <HooksList
          compatibilityHooks={filteredCompatibilityHooks}
          editableHooks={filteredEditableHooks}
          operatingHookId={hooksState.operatingHookId}
          pluginHooks={filteredPluginHooks}
          showInstalledSection={!normalizedQuery}
          installedEmptyTitle={intl.formatMessage({
            id: "settings.plugin.hooks.emptyInstalledTitle",
          })}
          installedEmptyDescription={intl.formatMessage({
            id: "settings.plugin.hooks.emptyInstalledDescription",
          })}
          installedEmptyActions={
            <Button type="button" variant="default" size="lg" onClick={handleCreateHook}>
              <Plus data-icon="inline-start" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.hooks.add" })}
            </Button>
          }
          installedAction={
            <SettingsResourceHeaderActions
              onRefresh={() => void handleRefresh()}
              onNew={handleCreateHook}
              newActionId="settings.hooks.add"
            />
          }
          formatPluginName={(name, pluginId) =>
            resolvePluginDisplayName(
              {
                name,
                listing:
                  (pluginId ? pluginListingById.get(pluginId) : undefined) ??
                  resolveUniquePluginListingByName(availablePlugins, name),
              },
              locale,
            )
          }
          onEdit={(target) => {
            setEditingHook(target);
            setViewMode("form");
          }}
          onImport={handleImport}
          onTrust={trustHook}
          trustActionAvailable={trustActionAvailable}
          trustingHookId={trustingHookId}
          onToggle={handleToggle}
        />
      )}
    </div>
  );
}

function hookMatchesQuery(hook: Hook, normalizedQuery: string): boolean {
  if (!normalizedQuery) {
    return true;
  }
  return [
    hook.event,
    hook.type,
    hook.matcher,
    hook.command,
    ...(hook.args ?? []),
    hook.location?.directoryPath,
  ].some((value) => value?.toLowerCase().includes(normalizedQuery));
}
