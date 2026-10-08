/* eslint-disable max-lines -- Root 当前集中编排启动和 workspace shell wiring，先保持入口收口避免跨层状态拆散。 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LucideProvider, RefreshCw } from "lucide-react";
import {
  APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL,
  DesktopCommandIds,
  appRuntimePreferencesChangedBroadcastPayloadSchema,
  type RemoteTarget,
} from "@zcode/shared";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { Button } from "@/components/ui/button.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useDynamicWorkflowAvailabilityLoader } from "@/hooks/useDynamicWorkflowAvailability.js";
import { DirectoryBrowser } from "@/DirectoryBrowser.js";
import { useTabPersistence } from "@/hooks/useTabPersistence.js";
import { useTokenRefresh } from "@/hooks/useTokenRefresh.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SSHDialog } from "@/SSHDialog.js";
import { SettingsPage } from "@/SettingsPage.js";
import { CodingPlanUpgradeDialogProvider } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { WelcomeScreen, type LoginCompleteReason } from "@/WelcomeScreen.js";
import { setDefaultFileDisplayBasePath } from "@/lib/fileDisplay.js";
import { readRendererLaunchTimings, shouldReportLaunchToInput } from "@/lib/launchToInputReport.js";
import { reportUiLaunchToInput } from "@/lib/uiPerfArmsTelemetry.js";
import { countAllUnreadTasks } from "@/lib/unreadTaskCount.js";
import {
  isProviderStartupSyncPending,
  shouldEnableProviderAvailabilityLoginEntryGuard,
  shouldResolveProviderStartupState,
  shouldBlockRootRender,
  shouldShowRootStartupLoading,
  shouldOpenFallbackWorkspaceAfterCreate,
} from "@/lib/rootStartupGate.js";
import { StoreProvider, useZCodeStore } from "@/store/StoreProvider.js";
import { setMcpStorePlatform } from "@/store/mcpStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { TabStoreProvider, useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { isSettingsTab, isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";
import { logger } from "@/logger.js";
import { RootShell } from "@/root/RootShell.js";
import { RootWorkspaceContent } from "@/root/RootWorkspaceContent.js";
import { resolveRootWorkspaceShellTarget } from "@/root/rootWorkspaceShellTarget.js";
import { OccupationOnboarding } from "@/onboarding/OccupationOnboarding.js";
import { OnboardingDialog } from "@/onboarding/OnboardingDialog.js";
import { useRemoteWorkspaceHistory } from "@/root/useRemoteWorkspaceHistory.js";
import { useRemoteWorkspaceTabLifecycle } from "@/root/useRemoteWorkspaceTabLifecycle.js";
import { useRootProviderStateRefresh } from "@/root/useRootProviderStateRefresh.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useRootProviderSettingsSnapshot } from "@/root/useRootProviderSettingsSnapshot.js";
import { useRootOAuthEffects } from "@/root/useRootOAuthEffects.js";
import { consumeZcodeJwtInvalidRestartMarker } from "@/root/zcodeJwtInvalidRestartMarker.js";
import { useDesktopNativeThemeSync } from "@/root/useDesktopNativeThemeSync.js";
import { useRootPlatformEffects } from "@/root/useRootPlatformEffects.js";
import { useRootWorkspaceActions } from "@/root/useRootWorkspaceActions.js";
import { useBotBroadcastEffects } from "@/root/useBotBroadcastEffects.js";
import { registerBaseWorkspaceServices } from "@/store/remoteWorkspaceSessionStore.js";
import type { RootProps } from "@/root/types.js";
import { DiffsWorkerPoolProvider } from "@/root/DiffsWorkerPoolProvider.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { useRemoteConnectionLogs } from "@/hooks/useRemoteConnectionLogs.js";
import {
  CODE_COMMENT_REMOVE_BROADCAST_CHANNEL,
  CODE_COMMENT_PREVIEW_RESTORE_BROADCAST_CHANNEL,
  isCodeCommentPayload,
  isCodeCommentRemovePayload,
  markCodeCommentRemoved,
} from "@/lib/codeCommentContext.js";
import { useCodeCommentPreviewStore } from "@/store/codeCommentPreviewStore.js";
import { setUiPerfArmsReporter } from "@/lib/uiPerfArmsTelemetry.js";
import { setSessionOpenArmsReporter } from "@/lib/sessionOpenArmsTelemetry.js";
import { setSendFunnelArmsReporter } from "@/lib/sendFunnelArmsTelemetry.js";
import { RootStartupLoading } from "@/root/RootStartupLoading.js";
import { resolveProviderAvailabilityState } from "@/lib/modelProviderAvailability.js";
import { useProviderAvailabilityLoginEntryGuard } from "@/root/useProviderAvailabilityLoginEntryGuard.js";
import { ensureProviderFamilyDomainMigration } from "@/lib/providerFamilyDomainMigration.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT } from "@/lib/closeActiveContext.js";
import { AssistantCodeCommentFeatureProvider } from "@/AssistantCodeCommentFeatureProvider.js";
import {
  disposeConversationTelemetrySupervisors,
  reconcileConversationTelemetryWorkspaceScopes,
} from "@/v4/telemetry/ConversationTelemetryAttachment.js";

const DEFAULT_LUCIDE_STROKE_WIDTH = 1.5;
interface RemoteConnectionOpenPreference {
  preferredKind?: RemoteTarget["kind"];
  preferredWslDistro?: string;
}

type WelcomeScreenOpenReason =
  | "startup-provider-required"
  | "manual-login"
  | "provider-request"
  | "logout-provider-required"
  | "session-expired";

/**
 * Root —— 应用根组件
 *
 * 外层挂载 StoreProvider（连接广播服务）+ TabStoreProvider，内层处理认证和路由。
 */
export function Root(props: RootProps) {
  return (
    <LucideProvider strokeWidth={DEFAULT_LUCIDE_STROKE_WIDTH}>
      {/*
       * 之前通过 lucide.tsx 包装每个图标，把默认 strokeWidth 固定成 1.5。
       * 现在移除包装文件后，如果不在根层统一注入，按钮、列表和工具栏里的 Lucide 图标会回退到 2，
       * 导致同一套 size class 下视觉显得更粗、更挤。这里改用官方 LucideProvider 保持默认值，
       * 同时保留个别图标显式传入 strokeWidth 时的覆盖能力。
       */}
      <TooltipProvider>
        {/*
         * 大会话消息动作里会出现大量 tooltip。Provider 如果跟随每个 tooltip 实例创建，
         * React 点击切换任务时会同步构造数量级相同的 Radix 上下文树；根层共享一次即可保留零延迟配置。
         */}
        <ServiceProvider services={props.services}>
          <PlatformProvider platform={props.platform}>
            <StoreProvider
              broadcastService={props.services.broadcastService}
              initialIsRestoringOAuthSession
            >
              <TabStoreProvider>
                <DiffsWorkerPoolProvider>
                  <AssistantCodeCommentFeatureProvider
                    enabled={props.assistantCodeCommentCardsEnabled}
                  >
                    <CodingPlanUpgradeDialogProvider>
                      <RootInner {...props} />
                    </CodingPlanUpgradeDialogProvider>
                  </AssistantCodeCommentFeatureProvider>
                </DiffsWorkerPoolProvider>
              </TabStoreProvider>
            </StoreProvider>
          </PlatformProvider>
        </ServiceProvider>
      </TooltipProvider>
    </LucideProvider>
  );
}

function RootInner({
  services,
  platform,
  initialWorkspaceAbsPath,
  unavailableWorkspacePath,
  initialWorkspaceIdentity,
  initialWorkspacePurpose,
  initialTaskId,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  restoreSession = true,
  supportsSettings = true,
  allowOpenWorkspace = true,
  preferDirectoryBrowser,
  supportsEmbeddedBrowser: explicitSupportsEmbeddedBrowser,
  allowRemoteWorkspace = true,
  initialWorkspaceLoadingFallback,
}: RootProps) {
  useEffect(() => {
    setMcpStorePlatform(platform);
    // 对话 UI perf 只属于 desktop-continuous；Web/mobile 即使能看到权威状态也不装 reporter。
    setUiPerfArmsReporter(isDesktop ? platform : null);
    setSessionOpenArmsReporter(isDesktop ? platform : null);
    // 发送漏斗同理：只在 Electron 桌面端上报，Web/mobile 的 reportArmsCustomEvent 是空实现。
    setSendFunnelArmsReporter(isDesktop ? platform : null);
    return () => {
      setMcpStorePlatform(null);
      setUiPerfArmsReporter(null);
      setSessionOpenArmsReporter(null);
      setSendFunnelArmsReporter(null);
    };
  }, [isDesktop, platform]);

  useEffect(
    () => () => {
      disposeConversationTelemetrySupervisors();
    },
    [],
  );

  // 动态工作流灰度快照的唯一取数点：
  // 放在 app 级 ServiceProvider 这一层取一次，自动化页与 run 面板只读。消费方可能位于
  // 工作区级 ServiceProvider 内（远程 Host 的 accessor），由它们取数会拿到另一台 Host 的答案。
  useDynamicWorkflowAvailabilityLoader(services.codingPlanSubscriptionService);

  const { intl, locale } = useZCodeIntl();
  const theme = useZCodeStore((state) => state.theme);
  const user = useZCodeStore((state) => state.user);
  const isRestoringOAuthSession = useZCodeStore((state) => state.isRestoringOAuthSession);
  const setUser = useZCodeStore((state) => state.setUser);
  const setIsRestoringOAuthSession = useZCodeStore((state) => state.setIsRestoringOAuthSession);
  const setOAuthError = useZCodeStore((state) => state.setOAuthError);
  const oauthPollingActive = useZCodeStore((state) => state.oauthPollingActive);
  const setOAuthPollingActive = useZCodeStore((state) => state.setOAuthPollingActive);
  const markOAuthSuccess = useZCodeStore((state) => state.markOAuthSuccess);
  const {
    settings: appSettings,
    refresh: refreshAppSettings,
    update: updateAppSettings,
  } = useSettings();
  const [welcomeScreenOpenReason, setWelcomeScreenOpenReason] =
    useState<WelcomeScreenOpenReason | null>(() =>
      consumeZcodeJwtInvalidRestartMarker() ? "session-expired" : null,
    );
  const [providerFamilyDomainMigrationComplete, setProviderFamilyDomainMigrationComplete] =
    useState(false);
  const loginEntryRequest = useZCodeStore((state) => state.loginEntryRequest);
  const rootModelSelectionRead = useModelSelectionServiceView(services.modelSelectionService);
  const rootModelSelectionView =
    rootModelSelectionRead.state.status === "ready" ? rootModelSelectionRead.state.view : null;
  const rootModelSelectionErrorNode =
    rootModelSelectionRead.state.status === "error" ? (
      <div className="fixed right-4 bottom-4 z-50 flex max-w-sm items-center gap-3 rounded-lg border border-destructive/30 bg-surface-raised px-3 py-2 text-ui-base text-foreground shadow-lg">
        <span className="min-w-0 flex-1">
          {intl.formatMessage({ id: "root.modelSelection.loadFailed" })}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={rootModelSelectionRead.reload}>
          <RefreshCw className="size-3.5" aria-hidden="true" />
          {intl.formatMessage({ id: "common.retry" })}
        </Button>
      </div>
    ) : null;
  const readRootModelSelectionView = useCallback(
    () => services.modelSelectionService.getView(),
    [services.modelSelectionService],
  );
  const [remoteConnectionDialogOpen, setRemoteConnectionDialogOpen] = useState(false);
  const [remoteConnectionOpenPreference, setRemoteConnectionOpenPreference] =
    useState<RemoteConnectionOpenPreference | null>(null);
  const [directoryBrowserOpen, setDirectoryBrowserOpen] = useState(false);
  const [remoteConnectionInProgress, setRemoteConnectionInProgress] = useState(false);
  const [remoteConnectionRequestId, setRemoteConnectionRequestId] = useState<string | null>(null);
  const [isCreatingFallbackWorkspace, setIsCreatingFallbackWorkspace] = useState(false);
  const { connectionLogs: remoteConnectionLogs, resetConnectionLogs: resetRemoteConnectionLogs } =
    useRemoteConnectionLogs(remoteConnectionRequestId);
  const [isBootstrappingInitialWorkspace, setIsBootstrappingInitialWorkspace] = useState(
    Boolean(initialWorkspaceAbsPath),
  );
  const acknowledgingReleaseNotesVersionRef = useRef<string | null>(null);
  const previousRemoteConnectionInProgressRef = useRef(false);
  const didRequestFallbackWorkspaceRef = useRef(false);
  const rootInnerMountedRef = useRef(true);
  const [hasEnteredNativeThemeSyncSurface, setHasEnteredNativeThemeSyncSurface] = useState(false);

  useEffect(() => {
    return () => {
      rootInnerMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const disposable = services.broadcastService.onMessage((message) => {
      if (message.channel === APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL) {
        const parsed = appRuntimePreferencesChangedBroadcastPayloadSchema.safeParse(
          message.payload,
        );
        if (!parsed.success) {
          logger.warn("[settings] 丢弃无效的运行时偏好广播", {
            issues: parsed.error.issues,
          });
          return;
        }
        void refreshAppSettings();
        void services.zcodeAgentService.syncAppRuntimePreferences(parsed.data).catch((error) => {
          logger.warn("[settings] 同步跨窗口运行时偏好失败", error);
        });
        void services.botsService.syncAppRuntimePreferences(parsed.data).catch((error) => {
          logger.warn("[settings] 同步跨窗口 Bot 运行时偏好失败", error);
        });
        return;
      }

      if (message.channel === CODE_COMMENT_PREVIEW_RESTORE_BROADCAST_CHANNEL) {
        if (!isCodeCommentPayload(message.payload) || !message.payload.id) {
          return;
        }
        useCodeCommentPreviewStore.getState().restoreCommentFromAttachment({
          ...message.payload,
          id: message.payload.id,
        });
        return;
      }

      if (message.channel !== CODE_COMMENT_REMOVE_BROADCAST_CHANNEL) {
        return;
      }

      if (!isCodeCommentRemovePayload(message.payload)) {
        return;
      }

      // 关闭文件 tab 后 PreviewPane 会卸载，不能再依赖 PreviewPane 自己监听跨窗口清理事件。
      // 这里在 Root 生命周期内同步清理 renderer 级 preview store，避免发送后重新打开文件又恢复旧 comment。
      markCodeCommentRemoved(message.payload);
      useCodeCommentPreviewStore.getState().removeCommentBySource(message.payload);
    });

    return () => {
      disposable.dispose();
    };
  }, [
    refreshAppSettings,
    services.botsService,
    services.broadcastService,
    services.zcodeAgentService,
  ]);

  useEffect(() => {
    if (!appSettings) {
      return;
    }
    void services.zcodeAgentService
      .syncAppRuntimePreferences({
        askUserQuestionAutoResolutionEnabled:
          appSettings.askUserQuestionAutoResolutionEnabled !== false,
        modelIoFullRetentionEnabled: appSettings.modelIoFullRetentionEnabled === true,
      })
      .catch((error) => {
        logger.warn("[settings] 初始化运行时偏好失败", error);
      });
    void services.botsService
      .syncAppRuntimePreferences({
        askUserQuestionAutoResolutionEnabled:
          appSettings.askUserQuestionAutoResolutionEnabled !== false,
        modelIoFullRetentionEnabled: appSettings.modelIoFullRetentionEnabled === true,
      })
      .catch((error) => {
        logger.warn("[settings] 初始化 Bot 运行时偏好失败", error);
      });
  }, [
    appSettings?.askUserQuestionAutoResolutionEnabled,
    appSettings?.modelIoFullRetentionEnabled,
    services.botsService,
    services.zcodeAgentService,
  ]);

  const tabs = useTabStore((state) => state.tabs);
  const windowWorkspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  const activeTabId = useTabStore((state) => state.activeTabId);
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const activeWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const activeTab = activeTabId ? (tabs.find((tab) => tab.id === activeTabId) ?? null) : null;
  const activeWorkspaceTab = activeTab && isWorkspaceTab(activeTab) ? activeTab : null;
  const isSettingsTabActive = activeTab ? isSettingsTab(activeTab) : false;
  const {
    workspaceShellPath,
    workspaceIdentity: workspaceShellIdentity,
    workspaceRemoteSessionId: workspaceShellRemoteSessionId,
  } = resolveRootWorkspaceShellTarget({
    activeWorkspaceTab,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    // Settings 覆盖时仍使用被覆盖 tab 的完整远程身份，避免通知与侧栏建立重复订阅。
    workspaceTabs: windowWorkspaceTabs,
  });
  const workspaceScopedServices = useWorkspaceServices(
    workspaceShellPath,
    workspaceShellRemoteSessionId,
    workspaceShellIdentity,
  );

  const localWorkspacePathForRemoteConnection = useTabStore((state) => {
    const activeTab = state.activeTabId
      ? state.tabs.find((tab) => tab.id === state.activeTabId)
      : null;
    if (
      !activeTab ||
      !isWorkspaceTab(activeTab) ||
      activeTab.remoteSessionId ||
      activeTab.remoteTarget ||
      activeTab.workspaceIdentity ||
      activeTab.workspacePurpose === "conversation"
    ) {
      return undefined;
    }
    return activeTab.workspacePath;
  });
  const totalUnreadTaskCount = useZCodeSessionStore((state) =>
    countAllUnreadTasks(state.workspaces),
  );
  const addTab = useTabStore((state) => state.addTab);
  const activateTabByPath = useTabStore((state) => state.activateTabByPath);
  const tabStoreApi = useTabStoreApi();
  const refreshProviderState = useRootProviderStateRefresh(services);
  useRootProviderSettingsSnapshot(services);
  useEffect(() => {
    let disposed = false;

    void (async () => {
      try {
        await ensureProviderFamilyDomainMigration(services);
      } catch (error) {
        logger.warn("[Root] provider family domain 迁移失败，继续启动", {
          error,
        });
      } finally {
        if (!disposed) {
          setProviderFamilyDomainMigrationComplete(true);
          try {
            await refreshAppSettings();
            await refreshProviderState();
          } catch (refreshError) {
            logger.warn("[Root] provider family domain 迁移后刷新状态失败", {
              error: refreshError,
            });
          }
        }
      }
    })();

    return () => {
      disposed = true;
    };
  }, [refreshAppSettings, refreshProviderState, services]);

  const shouldPreferDirectoryBrowser = Boolean(preferDirectoryBrowser);
  const supportsEmbeddedBrowser = explicitSupportsEmbeddedBrowser ?? Boolean(isDesktop);
  const isResolvingStartupAuthState = isRestoringOAuthSession;
  const rootProviderAvailability = resolveProviderAvailabilityState({
    modelSelectionView: rootModelSelectionView,
  });
  const providerStartupSyncPending = isProviderStartupSyncPending({
    providerFamilyDomainMigrationComplete,
    modelSelectionViewHydrated:
      rootProviderAvailability.hydrated || rootModelSelectionRead.state.status === "error",
  });
  const providerAvailabilityLoginEntryGuardEnabled =
    shouldEnableProviderAvailabilityLoginEntryGuard();
  const { startupCheckCompleted: providerAvailabilityStartupCheckCompleted } =
    useProviderAvailabilityLoginEntryGuard({
      enabled: providerAvailabilityLoginEntryGuardEnabled,
      user,
      isRestoringOAuthSession: isResolvingStartupAuthState || providerStartupSyncPending,
      providerFamilyDomain: appSettings?.providerFamilyDomain,
      modelSelectionView: rootModelSelectionView,
      modelSelectionError:
        rootModelSelectionRead.state.status === "error"
          ? rootModelSelectionRead.state.error
          : undefined,
      refreshProviderState,
      readModelSelectionView: readRootModelSelectionView,
      setLoginEntryOpen: (open) => {
        setWelcomeScreenOpenReason((currentReason) => {
          if (open) {
            return "startup-provider-required";
          }
          // JWT 过期提示确认后会先写入 session-expired，随后 provider
          // 启动门禁以 open=false 收尾。这里若无条件清空，会覆盖重新登录页并回到工作区。
          // 门禁只能关闭自己拥有的启动登录态，不能清理其它交互来源的 reason。
          return currentReason === "startup-provider-required" ? null : currentReason;
        });
      },
    });
  const isResolvingProviderStartupState = shouldResolveProviderStartupState({
    providerStartupSyncPending,
    providerAvailabilityStartupCheckCompleted,
  });
  const isStartupProviderLoginEntryOpen = welcomeScreenOpenReason === "startup-provider-required";
  // 首次安装时 provider 登录入口判定晚于 workspace 注入，ChatView 会先 mount 并触发草稿预热。
  // 这里把 provider 启动检查纳入 workspace 恢复门禁，避免未连接账号前启动 ZCode session。
  const canRestoreWorkspaceSession =
    !isResolvingStartupAuthState &&
    !isResolvingProviderStartupState &&
    !isStartupProviderLoginEntryOpen;

  useEffect(() => {
    // 跨 workspace 任务列表需要一个稳定的“本地/root services”入口。
    // 桌面端 renderer 启动时会注册一次，但 Web 和测试入口也会直接挂 Root；
    // 这里再以 Root props 兜底注册，避免当前激活远端 workspace 时本地列表误用远端 host。
    registerBaseWorkspaceServices(services);
  }, [services]);

  useBotBroadcastEffects(services, tabStoreApi);

  const handleOpenRemoteConnection = useCallback((preference?: RemoteConnectionOpenPreference) => {
    setRemoteConnectionOpenPreference(preference ?? null);
    setRemoteConnectionDialogOpen(true);
  }, []);
  const handleOpenDirectoryBrowser = useCallback(() => {
    setDirectoryBrowserOpen(true);
  }, []);
  const handleReauthenticationRequired = useCallback(() => {
    setWelcomeScreenOpenReason("session-expired");
  }, []);
  const {
    setWorkspaceActionError,
    startDraftInWorkspace,
    startNewTaskFromActiveWorkspace,
    handleLogout,
    handleSelectProject,
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask,
    handleOpenWorkspace,
    handleOpenFolderFromWorkspaceMenu,
    handleCreateScratchWorkspace,
    handleCreateTask,
    handleBackFromSettings,
  } = useRootWorkspaceActions({
    intl,
    platform,
    services,
    tabStoreApi,
    addTab,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    supportsSettings,
    allowOpenWorkspace,
    preferDirectoryBrowser: shouldPreferDirectoryBrowser,
    openDirectoryBrowser: handleOpenDirectoryBrowser,
    refreshProviderState,
    updateAppSettings,
    setOAuthError,
    setUser,
    onProviderFamilyDomainClearedAfterLogout: () => {
      setWelcomeScreenOpenReason("logout-provider-required");
    },
    userId: user?.id,
    onOpenRemoteConnection: allowRemoteWorkspace ? handleOpenRemoteConnection : undefined,
  });
  const handleRemoteWorkspaceActivated = useCallback(
    ({
      workspacePath,
      workspaceIdentity,
    }: {
      workspacePath: string;
      workspaceIdentity: string;
    }) => {
      startDraftInWorkspace(workspacePath, workspaceIdentity);
    },
    [startDraftInWorkspace],
  );

  const {
    remoteWorkspaceSessions,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceErrorByWorkspaceKey,
    reconnectingRemoteWorkspaceLogsByWorkspaceKey,
    buildPersistedTabPatch,
    restorePersistedSession,
    handleCancelRemoteProject,
    handleSelectRemoteProject,
    handleConnectRemote,
    handleReconnectRemoteWorkspace,
    handleRemoteWorkspaceTabsClosed,
  } = useRemoteWorkspaceHistory({
    intl,
    services,
    platform,
    supportsSettings,
    allowRemoteWorkspace,
    // conversation backing workspace 只属于本地桌面主恢复链路；远程窗口和手机
    // shared-host attachment 不能因此创建独立本地 runtime 或改变 replayable 边界。
    ensureConversationWorkspaceOnRestore: isDesktop && restoreSession && !initialWorkspaceIdentity,
    deferInactiveWorkspaceRestore: isDesktop && restoreSession && !initialWorkspaceIdentity,
    unavailableWorkspacePath,
    tabStoreApi,
    activateTabByPath,
    addTab,
    onWorkspaceActivated: handleRemoteWorkspaceActivated,
  });

  useEffect(() => {
    // fileDisplay 默认不传 basePath 时需要落到“当前激活 workspace”。
    // 之前纯工具层拿不到窗口内的 workspace 上下文，只能退回绝对路径，导致 mention / 文件展示在输入框里不够简洁。
    // 这里由 Root 在 workspace 切换时同步一份当前上下文，既保留工具层复用性，也不把 Zustand 依赖硬塞进工具函数。
    setDefaultFileDisplayBasePath(activeWorkspacePath);
  }, [activeWorkspacePath]);

  useEffect(() => {
    if (!activeWorkspacePath) {
      return;
    }

    setWorkspaceActionError(null);
  }, [activeWorkspacePath, setWorkspaceActionError]);

  const { isRestoring, hasCompletedInitialRestore, hasCompletedFullRestore } = useTabPersistence({
    settingService: supportsSettings ? services.settingService : undefined,
    // 首次安装未连接账号时，provider 登录入口判定会晚于 workspace 恢复。
    // 如果这里先恢复 workspace，ChatView mount 会触发草稿 session 预热并在登录页背后报错。
    restoreSession: restoreSession && canRestoreWorkspaceSession,
    persistSession: restoreSession && canRestoreWorkspaceSession,
    restorePersistedSession,
    buildPersistPatch: buildPersistedTabPatch,
  });

  useEffect(() => {
    if (!isDesktop || !hasCompletedFullRestore) return;
    // Bug 原因：active-first 的单 workspace 只是 Renderer 首屏投影，若立刻对外同步，
    // 会短暂撤销其他 workspace 的 telemetry scope。完整补齐后才能发布全量集合。
    reconcileConversationTelemetryWorkspaceScopes(
      windowWorkspaceTabs.map((tab) => ({
        workspacePath: tab.workspacePath,
        ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
        ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
      })),
    );
  }, [hasCompletedFullRestore, isDesktop, windowWorkspaceTabs]);

  const { tryRefresh, clearCredentials } = useTokenRefresh();
  void tryRefresh;
  void clearCredentials;
  // 启动阻塞是桌面窗口保护期，手机 Web 远控在进入 Root 前已有配对/加载页。
  // Web 端继续使用该 gate 会在 workspace tab 注入前渲染空 RootShell，露出浏览器白底。
  const isStartupRenderBlocked = shouldShowRootStartupLoading({
    isDesktop,
    welcomeScreenOpen: Boolean(welcomeScreenOpenReason),
    isResolvingStartupAuthState,
    isResolvingProviderStartupState,
    isRestoring,
    isBootstrappingInitialWorkspace: isBootstrappingInitialWorkspace || isCreatingFallbackWorkspace,
  });

  const launchReportedRef = useRef(false);
  useEffect(() => {
    if (
      !shouldReportLaunchToInput({
        isStartupRenderBlocked,
        welcomeScreenOpen: Boolean(welcomeScreenOpenReason),
        alreadyReported: launchReportedRef.current,
      })
    ) {
      return;
    }
    launchReportedRef.current = true;
    const timings = readRendererLaunchTimings();
    if (!timings || !timings.marks) {
      return; // 锚点缺失(非桌面/未注入 marks),整批跳过
    }
    reportUiLaunchToInput({
      marks: timings.marks,
      rendererStart: timings.rendererStart,
      reactCommit: timings.reactCommit,
      inputReady: Date.now(), // T6
      sessionId: `launch-${timings.marks.createdAt}`,
    });
  }, [isStartupRenderBlocked, welcomeScreenOpenReason]);

  useRootPlatformEffects({
    initialWorkspaceAbsPath,
    initialWorkspaceIdentity,
    initialWorkspacePurpose,
    initialTaskId,
    // 系统右键/Service 冷启动传入 initialWorkspacePath 时，必须先恢复历史 tabs，
    // 再把目标 workspace 合并并激活。否则先 addTab 会被 restoreTabs 整体替换掉；
    // 直接禁用 restoreSession 又会让其他 workspace 全部消失。
    canBootstrapInitialWorkspace: canRestoreWorkspaceSession && hasCompletedInitialRestore,
    addTab,
    setIsBootstrappingInitialWorkspace,
    platform,
    activateTabByPath,
    startDraftInWorkspace,
    startNewTaskFromActiveWorkspace,
    openWorkspace: handleOpenWorkspace,
    openWorkspacePath: (path) => {
      void handleSelectProject(path);
    },
    setWorkspaceActionError,
    allowOpenWorkspace,
    isDesktop,
    locale,
    tabs,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceErrorByWorkspaceKey,
    totalUnreadTaskCount,
    hasCompletedFullTabRestore: hasCompletedFullRestore,
    intl,
    isRestoringOAuthSession: isResolvingStartupAuthState || providerStartupSyncPending,
  });

  useEffect(() => {
    if (!platform.onCloseActiveContextRequest) {
      return;
    }

    return platform.onCloseActiveContextRequest(() => {
      const event = new Event(CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT, { cancelable: true });
      window.dispatchEvent(event);
      if (event.defaultPrevented) {
        return;
      }

      // 关闭请求先广播给 workspace 层判断 side pane active tab。
      // 没有可见 workspace 或没有可关闭的 side pane tab 时，才回落到关窗口语义。
      void platform.executeDesktopCommand(DesktopCommandIds.CloseWindow);
    });
  }, [platform]);

  useRootOAuthEffects({
    accountIntentKey: JSON.stringify([
      user?.id,
      appSettings?.providerFamilyDomain,
      appSettings?.providerFamilyConnectionSelections,
    ]),
    platform,
    services,
    refreshProviderState,
    refreshAppSettings,
    setUser,
    setIsRestoringOAuthSession,
    setOAuthError,
    oauthPollingActive,
    setOAuthPollingActive,
    markOAuthSuccess,
    onReauthenticationRequired: handleReauthenticationRequired,
  });

  useEffect(
    () =>
      platform.onPostUpdateReleaseNotes((payload) => {
        logger.info("[Root] 收到更新说明，改为静默确认", {
          version: payload.version,
          title: payload.title,
        });
        if (acknowledgingReleaseNotesVersionRef.current === payload.version) {
          return;
        }

        // 自动更新每次命中待展示 release notes 都会走到这里，
        // 之前 Root 会立刻把 payload 送进对话框状态，导致用户每次更新都被强制弹窗打断。
        // 这次需求只移除弹窗本身，因此这里改成收到后直接静默 ack，
        // 既不影响“更新已下载”按钮/菜单/安装链路，也避免 pending 状态残留到下次启动后再次触发。
        acknowledgingReleaseNotesVersionRef.current = payload.version;
        void platform
          .acknowledgePostUpdateReleaseNotes(payload.version)
          .then(() => {
            logger.info("[Root] 更新说明已静默确认", {
              version: payload.version,
            });
          })
          .catch((error) => {
            logger.error("[Root] 更新说明静默确认失败", {
              version: payload.version,
              error,
            });
          })
          .finally(() => {
            if (acknowledgingReleaseNotesVersionRef.current === payload.version) {
              acknowledgingReleaseNotesVersionRef.current = null;
            }
          });
      }),
    [platform],
  );

  const canEnterNativeThemeSyncSurface = Boolean(
    !isStartupRenderBlocked &&
    !welcomeScreenOpenReason &&
    (workspaceShellPath || isSettingsTabActive),
  );

  useEffect(() => {
    if (!canEnterNativeThemeSyncSurface) {
      return;
    }

    // macOS nativeTheme 会影响窗口 vibrancy。这里等 RootStartupLoading
    // 真正退出并进入主界面/设置页后一轮再允许同步，避免启动壳背景被应用主题提前改写。
    setHasEnteredNativeThemeSyncSurface(true);
  }, [canEnterNativeThemeSyncSurface]);

  useDesktopNativeThemeSync({
    enabled: hasEnteredNativeThemeSyncSurface,
    isDesktop,
    platform,
    theme,
  });

  useRemoteWorkspaceTabLifecycle({
    tabs,
    activeWorkspaceTab,
    platform,
    onRemoteWorkspaceTabsClosed: handleRemoteWorkspaceTabsClosed,
  });

  useEffect(() => {
    if (
      shouldBlockRootRender({
        isResolvingStartupAuthState,
        isResolvingProviderStartupState,
        isRestoring,
        isBootstrappingInitialWorkspace,
      }) ||
      isStartupProviderLoginEntryOpen ||
      workspaceShellPath ||
      isSettingsTabActive ||
      !allowOpenWorkspace ||
      didRequestFallbackWorkspaceRef.current
    ) {
      return;
    }

    didRequestFallbackWorkspaceRef.current = true;
    setIsCreatingFallbackWorkspace(true);
    // 以前 tab store 的默认空态会把 Root 带到打开工作区中间页。
    // 删除整页流程后，启动恢复为空或入口没有传 initialWorkspacePath 时必须在 Root
    // 兜底落到默认 workspace，避免用户先看到一张“打开工作区”中间页或空白页。
    // 这里不能用当前 effect 的 cleanup 作为异步取消标记：setIsCreatingFallbackWorkspace
    // 或 addTab 后的 workspaceShellPath 变化都会让 React 先跑 cleanup，若因此跳过 finally，
    // 启动 loading gate 会永远保持 true。
    services.fileService
      .ensureConversationWorkspace()
      .then((result) => {
        // 启动兜底创建目录可能早于会话恢复发起、晚于恢复完成返回。
        // 返回后必须按 tab store 最新 active workspace 再判一次，避免迟到的默认项目抢走上次恢复的 tab。
        if (
          !shouldOpenFallbackWorkspaceAfterCreate({
            isMounted: rootInnerMountedRef.current,
            activeWorkspacePath: tabStoreApi.getState().activeWorkspacePath,
          })
        ) {
          return;
        }
        handleSelectConversationWorkspace(result.path);
      })
      .catch((error) => {
        if (!rootInnerMountedRef.current) {
          return;
        }
        logger.error("[Root] 启动兜底创建默认 workspace 失败", { error });
        setWorkspaceActionError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (rootInnerMountedRef.current) {
          setIsCreatingFallbackWorkspace(false);
        }
      });
  }, [
    allowOpenWorkspace,
    handleSelectConversationWorkspace,
    isBootstrappingInitialWorkspace,
    isResolvingProviderStartupState,
    isResolvingStartupAuthState,
    isRestoring,
    isSettingsTabActive,
    isStartupProviderLoginEntryOpen,
    services.fileService,
    setWorkspaceActionError,
    tabStoreApi,
    workspaceShellPath,
  ]);

  useEffect(() => {
    if (!workspaceShellPath) {
      return;
    }

    logger.info(
      `[Root] settings view ${isSettingsTabActive ? "open" : "closed"} workspace=${workspaceShellPath}`,
    );
  }, [isSettingsTabActive, workspaceShellPath]);

  useEffect(() => {
    if (!loginEntryRequest) {
      return;
    }
    // 登录入口已从模态弹窗收敛为 WelcomeScreen。
    // provider 连接请求仍要先退出首次启动引导语义，避免连接完成后误创建默认 workspace。
    setWelcomeScreenOpenReason("provider-request");
  }, [loginEntryRequest]);

  const handleOpenLoginEntry = () => {
    setWelcomeScreenOpenReason("manual-login");
  };
  const handleWelcomeScreenComplete = useCallback(
    async (reason: LoginCompleteReason) => {
      await refreshAppSettings();
      if (
        welcomeScreenOpenReason !== "startup-provider-required" ||
        workspaceShellPath ||
        !allowOpenWorkspace
      ) {
        setWelcomeScreenOpenReason(null);
        return;
      }

      try {
        await handleEnsureConversationWorkspace();
      } catch (error) {
        logger.error("[Root] 登录后创建默认 workspace 失败", {
          error,
          reason,
        });
      } finally {
        setWelcomeScreenOpenReason(null);
      }
    },
    [
      allowOpenWorkspace,
      handleEnsureConversationWorkspace,
      refreshAppSettings,
      welcomeScreenOpenReason,
      workspaceShellPath,
    ],
  );
  const handleRemoteConnectionDialogOpenChange = useCallback((open: boolean) => {
    setRemoteConnectionDialogOpen(open);
    if (!open) {
      setRemoteConnectionOpenPreference(null);
    }
  }, []);

  const remoteConnectionDialog = allowRemoteWorkspace ? (
    <SSHDialog
      onConnect={handleConnectRemote}
      onSelectProject={handleSelectRemoteProject}
      onCancelSession={handleCancelRemoteProject}
      localWorkspacePath={localWorkspacePathForRemoteConnection}
      isWindowsDesktop={isWindowsDesktop}
      remoteWorkspaceSessions={remoteWorkspaceSessions}
      open={remoteConnectionDialogOpen}
      onOpenChange={handleRemoteConnectionDialogOpenChange}
      onFlowActiveChange={setRemoteConnectionInProgress}
      onFlowRequestIdChange={setRemoteConnectionRequestId}
      preferredKind={remoteConnectionOpenPreference?.preferredKind}
      preferredWslDistro={remoteConnectionOpenPreference?.preferredWslDistro}
      hideTriggerWhenClosed
    />
  ) : null;
  const directoryBrowserDialog = directoryBrowserOpen ? (
    <ScopedErrorBoundary
      scope="directory-browser"
      resetKeys={["directory-browser"]}
      variant="silent"
    >
      <DirectoryBrowser
        services={services}
        onCancel={() => setDirectoryBrowserOpen(false)}
        onSelect={(path) => {
          setDirectoryBrowserOpen(false);
          void handleSelectProject(path);
        }}
      />
    </ScopedErrorBoundary>
  ) : null;

  useEffect(() => {
    const wasInProgress = previousRemoteConnectionInProgressRef.current;
    if (!wasInProgress && remoteConnectionInProgress) {
      resetRemoteConnectionLogs();
    }
    previousRemoteConnectionInProgressRef.current = remoteConnectionInProgress;
  }, [remoteConnectionInProgress, resetRemoteConnectionLogs]);

  const settingsLayerProps = {
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
    captionWorkspacePath: activeWorkspacePath,
    onBack: activeWorkspacePath ? handleBackFromSettings : undefined,
    onCreateTask: handleCreateTask,
    onOpenWorkspace: handleOpenWorkspace,
    allowOpenWorkspace,
    onLogin: !user ? handleOpenLoginEntry : undefined,
    onLogout: user ? handleLogout : undefined,
    user,
  };

  if (isStartupRenderBlocked) {
    const loadingLabel = intl.formatMessage({ id: "common.loading" });
    return (
      <RootShell>
        {rootModelSelectionErrorNode}
        {remoteConnectionDialog}
        {directoryBrowserDialog}
        {/* HTML 启动壳已经展示 ZCode SVG，但 React 接管 root 后旧壳会被整棵替换。
            之前阻塞恢复 tab / 初始 workspace 注入时重新渲染纯文字“加载中...”，所以启动被拆成两套 loading。
            这里复用同一套 SVG 启动画面，只把文案保留到 aria-label，保证视觉始终连续且不牺牲可访问性。 */}
        <RootStartupLoading label={loadingLabel} />
      </RootShell>
    );
  }

  if (welcomeScreenOpenReason) {
    return (
      <RootShell>
        {rootModelSelectionErrorNode}
        {remoteConnectionDialog}
        {directoryBrowserDialog}
        <WelcomeScreen onComplete={handleWelcomeScreenComplete} />
      </RootShell>
    );
  }

  if (
    !workspaceShellPath &&
    !isDesktop &&
    initialWorkspaceAbsPath &&
    initialWorkspaceLoadingFallback
  ) {
    // 非桌面入口的 workspace tab 由 effect 注入，首帧不能返回 null。
    // 这里延续入口 loading，等任务列表有 workspaceShellPath 后再切换，避免露出浏览器白底。
    return (
      <RootShell>
        {rootModelSelectionErrorNode}
        {initialWorkspaceLoadingFallback}
        {directoryBrowserDialog}
      </RootShell>
    );
  }

  return (
    <RootShell>
      {rootModelSelectionErrorNode}
      {remoteConnectionDialog}
      {directoryBrowserDialog}
      <OccupationOnboarding
        showWindowControls={Boolean(isWindowsDesktop || (isDesktop && !isMacDesktop))}
        showChildrenWhileLoading={!workspaceShellPath && isSettingsTabActive}
        isMacDesktop={isMacDesktop}
        isWindowsDesktop={isWindowsDesktop}
      >
        {/* 新引导属于应用级偏好；无项目时也要挂载，才能响应设置页的手动打开请求。 */}
        {!workspaceShellPath ? (
          isSettingsTabActive ? (
            <ScopedErrorBoundary
              scope="settings-page"
              resetKeys={["settings-root"]}
              variant="panel"
              className="h-full"
            >
              <SettingsPage {...settingsLayerProps} />
            </ScopedErrorBoundary>
          ) : null
        ) : (
          <RootWorkspaceContent
            workspaceScopedServices={workspaceScopedServices}
            baseFeedbackService={services.feedbackService}
            workspaceShellPath={workspaceShellPath}
            workspaceIdentity={workspaceShellIdentity}
            workspaceRemoteSessionId={workspaceShellRemoteSessionId}
            activeWorkspacePath={activeWorkspacePath}
            isSettingsTabActive={isSettingsTabActive}
            handleConnectRemote={handleConnectRemote}
            handleSelectRemoteProject={handleSelectRemoteProject}
            handleCancelRemoteProject={handleCancelRemoteProject}
            handleReconnectRemoteWorkspace={handleReconnectRemoteWorkspace}
            handleCreateTask={handleCreateTask}
            handleCreateConversationTask={handleCreateConversationTask}
            handleResolveConversationWorkspace={handleResolveConversationWorkspace}
            handleOpenWorkspace={handleOpenWorkspace}
            handleOpenFolderFromWorkspaceMenu={handleOpenFolderFromWorkspaceMenu}
            handleOpenRemoteWorkspace={
              allowRemoteWorkspace ? handleOpenRemoteConnection : undefined
            }
            handleCreateScratchWorkspace={handleCreateScratchWorkspace}
            remoteConnectionInProgress={remoteConnectionInProgress}
            remoteWorkspaceSessions={remoteWorkspaceSessions}
            allowRemoteWorkspace={allowRemoteWorkspace}
            handleBackFromSettings={handleBackFromSettings}
            handleLogout={user ? handleLogout : undefined}
            onLogin={!user ? handleOpenLoginEntry : undefined}
            user={user}
            reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
            remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
            reconnectingRemoteWorkspaceLogsByWorkspaceKey={
              reconnectingRemoteWorkspaceLogsByWorkspaceKey
            }
            remoteConnectionLogs={remoteConnectionLogs}
            allowOpenWorkspace={allowOpenWorkspace}
            isDesktop={isDesktop}
            isMacDesktop={isMacDesktop}
            isWindowsDesktop={isWindowsDesktop}
            supportsEmbeddedBrowser={supportsEmbeddedBrowser}
          />
        )}
        <ScopedErrorBoundary
          scope="onboarding-dialog"
          resetKeys={[workspaceShellIdentity?.trim() || workspaceShellPath]}
          variant="silent"
        >
          <OnboardingDialog
            workspacePath={workspaceShellPath || undefined}
            workspaceIdentity={workspaceShellIdentity}
            isDesktop={isDesktop}
          />
        </ScopedErrorBoundary>
      </OccupationOnboarding>
    </RootShell>
  );
}
