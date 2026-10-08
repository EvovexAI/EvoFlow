interface ConnectivityWorkspaceTab {
  workspacePath: string;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  remoteTarget?: unknown;
  localWorkspacePath?: string | null;
}

function isRemoteWorkspaceTab(tab: ConnectivityWorkspaceTab | null | undefined): boolean {
  return Boolean(
    tab?.workspaceIdentity?.trim() || tab?.remoteSessionId?.trim() || tab?.remoteTarget,
  );
}

/**
 * Provider Settings 属于本地 Environment；连通性探测需要 cwd 时，只能选择本地 workspace。
 * 远程 tab 的 workspacePath 是远端文件系统路径，不能直接交给 Local Host。
 */
export function resolveModelProviderConnectivityWorkspacePath(params: {
  activeWorkspacePath?: string | null;
  activeWorkspaceIdentity?: string | null;
  activeWorkspaceTab?: ConnectivityWorkspaceTab | null;
  workspaceTabs: readonly ConnectivityWorkspaceTab[];
}): string {
  const rememberedLocalPath = params.activeWorkspaceTab?.localWorkspacePath?.trim();
  if (rememberedLocalPath) {
    return rememberedLocalPath;
  }

  // 旧 tab 可能只有 remoteSessionId 或 remoteTarget，没有 workspaceIdentity。
  // 这些 tab 的 workspacePath 仍是远端路径，不能因 identity 缺失而交给 Local Host。
  const activeWorkspaceIsRemote = Boolean(
    params.activeWorkspaceIdentity?.trim() || isRemoteWorkspaceTab(params.activeWorkspaceTab),
  );
  if (!activeWorkspaceIsRemote) {
    const activeLocalPath = params.activeWorkspaceTab?.workspacePath.trim();
    if (activeLocalPath) {
      return activeLocalPath;
    }
    const activeWorkspacePath = params.activeWorkspacePath?.trim();
    if (activeWorkspacePath) {
      return activeWorkspacePath;
    }
  }

  const localTab = params.workspaceTabs.find((tab) => !isRemoteWorkspaceTab(tab));
  return localTab?.workspacePath.trim() ?? "";
}
