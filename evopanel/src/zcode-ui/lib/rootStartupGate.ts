interface RootStartupGateState {
  isResolvingStartupAuthState: boolean;
  isResolvingProviderStartupState: boolean;
  isRestoring: boolean;
  isBootstrappingInitialWorkspace: boolean;
}

interface RootStartupLoadingVisibilityState extends RootStartupGateState {
  isDesktop: boolean | undefined;
  welcomeScreenOpen: boolean;
}

interface FallbackWorkspaceCreateState {
  isMounted: boolean;
  activeWorkspacePath: string | null;
}

interface ProviderStartupSyncState {
  providerFamilyDomainMigrationComplete: boolean;
  modelSelectionViewHydrated: boolean;
}

interface ProviderStartupResolutionState {
  providerStartupSyncPending: boolean;
  providerAvailabilityStartupCheckCompleted: boolean;
}

export function shouldBlockRootRender(state: RootStartupGateState): boolean {
  return (
    state.isResolvingStartupAuthState ||
    state.isResolvingProviderStartupState ||
    state.isRestoring ||
    state.isBootstrappingInitialWorkspace
  );
}

export function shouldShowRootStartupLoading(state: RootStartupLoadingVisibilityState): boolean {
  // 登录入口是启动门禁的结果，不是可继续被门禁遮挡的后台状态。
  // 如果 WelcomeScreen 已经打开，继续返回启动 loading 会把未登录用户卡在黑屏 logo。
  return Boolean(state.isDesktop) && !state.welcomeScreenOpen && shouldBlockRootRender(state);
}

export function shouldEnableProviderAvailabilityLoginEntryGuard(): boolean {
  return true;
}

export function shouldResolveProviderStartupState(state: ProviderStartupResolutionState): boolean {
  return state.providerStartupSyncPending || !state.providerAvailabilityStartupCheckCompleted;
}

export function shouldOpenFallbackWorkspaceAfterCreate(
  state: FallbackWorkspaceCreateState,
): boolean {
  return state.isMounted && !state.activeWorkspacePath;
}

export function isProviderStartupSyncPending(state: ProviderStartupSyncState): boolean {
  return !state.providerFamilyDomainMigrationComplete || !state.modelSelectionViewHydrated;
}
