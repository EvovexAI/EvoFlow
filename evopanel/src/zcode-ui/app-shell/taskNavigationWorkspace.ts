type TaskNavigationWorkspaceResult =
  | { accepted: true; openedLocalTab: boolean }
  | { accepted: false; reason: "remote_attachment_missing" };

export function ensureTaskNavigationWorkspace(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  addLocalWorkspaceTab: (workspacePath: string) => void;
}): TaskNavigationWorkspaceResult {
  const workspaceIdentity = params.workspaceIdentity?.trim();
  if (
    params.activateTabByPath(
      params.workspacePath,
      workspaceIdentity ? { workspaceIdentity } : undefined,
    )
  ) {
    return { accepted: true, openedLocalTab: false };
  }

  if (workspaceIdentity) {
    // 远程 workspace 的 identity 只表达隔离身份，不能据此重建 SSH/WSL/Docker
    // attachment。当前窗口没有匹配 tab 时必须 fail-closed，避免创建无法连接的伪远程 tab。
    return { accepted: false, reason: "remote_attachment_missing" };
  }

  // Automations 是跨项目列表，运行历史所属的本地 workspace 可能已经关闭。
  // 只尝试 activate 的话，失败后仍关闭 Automations，最终留在当前项目的旧会话。
  params.addLocalWorkspaceTab(params.workspacePath);
  return { accepted: true, openedLocalTab: true };
}
