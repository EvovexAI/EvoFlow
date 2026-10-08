import type { ZCodeTaskMeta } from "@zcode/shared";
import { getPathLeaf } from "@/lib/path.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

interface TaskFileTreeTarget {
  workspacePath: string;
  workspaceName: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}

function resolveTaskFileTreeTarget(
  task: ZCodeTaskMeta,
  tab: WorkspaceTabState | undefined,
): TaskFileTreeTarget | null {
  // 旧本地 task 没有 workspaceIdentity，key 会回退到 workspacePath；如果同路径
  // 远程 tab 也缺 identity，仅按 key 会误带远程 session。匹配前必须先保证本地/远程类型一致。
  const taskIsRemote = Boolean(task.workspaceIdentity?.trim());
  const tabIsRemote = Boolean(
    tab?.workspaceIdentity?.trim() || tab?.remoteTarget || tab?.remoteSessionId,
  );
  const matchingTab =
    tab &&
    buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity) ===
      buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity) &&
    taskIsRemote === tabIsRemote
      ? tab
      : undefined;
  if (tab && !matchingTab) {
    return null;
  }
  const isRemoteWorkspace = Boolean(
    task.workspaceIdentity?.trim() || matchingTab?.remoteTarget || matchingTab?.remoteSessionId,
  );
  // 远端 task 的 workspacePath 可能和本地 workspace 相同。缺少对应 remoteSessionId
  // 时禁止打开文件树，否则文件读取会错误降级到本地 service。
  if (isRemoteWorkspace && !matchingTab?.remoteSessionId) {
    return null;
  }

  return {
    workspacePath: task.workspacePath,
    workspaceName: matchingTab?.label || getPathLeaf(task.workspacePath) || task.workspacePath,
    ...(task.workspaceIdentity?.trim() ? { workspaceIdentity: task.workspaceIdentity } : {}),
    ...(matchingTab?.remoteSessionId
      ? { workspaceRemoteSessionId: matchingTab.remoteSessionId }
      : {}),
  };
}

export function resolveTaskFileTreeTargetFromTabs(
  task: ZCodeTaskMeta,
  tabs: readonly WorkspaceTabState[],
): TaskFileTreeTarget | null {
  // 同一路径的本地与旧远程 tab 可能生成相同 key，不能先压成单值 Map；
  // 必须保留全部候选，再由单 tab 解析器校验 workspace 类型与远程 session。
  for (const tab of tabs) {
    const target = resolveTaskFileTreeTarget(task, tab);
    if (target) {
      return target;
    }
  }
  // 本地 task 不依赖已打开 tab；所属 workspace 已关闭时仍应按路径打开文件树。
  // 远程 task 则必须命中 tab 以取得受身份隔离的 remoteSessionId，禁止同样回退。
  if (!task.workspaceIdentity?.trim()) {
    return resolveTaskFileTreeTarget(task, undefined);
  }
  return null;
}
