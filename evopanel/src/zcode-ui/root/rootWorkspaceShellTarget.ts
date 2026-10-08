import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

interface WorkspaceShellTargetTab {
  workspacePath: string;
  remoteSessionId?: string;
  workspaceIdentity?: string;
}

interface RootWorkspaceShellTarget {
  workspaceShellPath: string | null;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}

function normalizeOptionalString(value?: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function resolveRootWorkspaceShellTarget({
  activeWorkspaceTab,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  workspaceTabs,
}: {
  activeWorkspaceTab: WorkspaceShellTargetTab | null;
  activeWorkspacePath: string | null;
  activeWorkspaceIdentity: string | null;
  /** 当前窗口全部 workspace tab；Settings 等非 workspace tab 激活时用来找回被覆盖的那个 tab。 */
  workspaceTabs: readonly WorkspaceShellTargetTab[];
}): RootWorkspaceShellTarget {
  if (activeWorkspaceTab) {
    return {
      workspaceShellPath: activeWorkspaceTab.workspacePath,
      workspaceIdentity: normalizeOptionalString(activeWorkspaceTab.workspaceIdentity),
      workspaceRemoteSessionId: normalizeOptionalString(activeWorkspaceTab.remoteSessionId),
    };
  }

  // Settings tab 覆盖 workspace 时 active tab 不是 workspace tab。
  // 之前只 fallback 了 workspacePath，没有 fallback workspaceIdentity，导致断连 SSH 路径被误判成本地 base service。
  const workspaceIdentity = normalizeOptionalString(activeWorkspaceIdentity);
  // 上面那次修复仍把 workspaceRemoteSessionId 置成 undefined。App 里的完成通知 hook 用它做
  // sessions-index 注册表的 endpointKey，缺失时会以 `__base__` 键为同一个远程 workspace 再建一个 store，
  // 并对同一 topic 再发一次 subscribe；CLI 对同 connection/topic 只保留最新订阅，侧栏正在用的那条订阅
  // 被静默替换，之后永远收不到帧——表现为左侧任务一直转圈、时间停在打开设置页的那一刻。
  // 被覆盖的 workspace tab 仍在 tab 列表里，这里按 workspaceKey 找回它，保证外壳目标与 tab 激活态完全一致。
  const coveredWorkspaceTab =
    activeWorkspacePath === null
      ? undefined
      : workspaceTabs.find(
          (tab) =>
            buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity) ===
            buildTaskWorkspaceKey(activeWorkspacePath, workspaceIdentity),
        );

  return {
    workspaceShellPath: activeWorkspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId: normalizeOptionalString(coveredWorkspaceTab?.remoteSessionId),
  };
}
