import type {
  ZCodeTaskListKind,
  ZCodeTaskListSortBy,
  ZCodeTaskListWorkspaceScope,
} from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { resolveWorkspaceStateKey } from "@/store/zcodeSessionStoreSelectors.js";

export type TaskEntityKey = string;
export type TaskListCacheKey = string;
export type TaskListQueryKind = ZCodeTaskListKind | "workspace";

export interface TaskListCacheDescriptor {
  kind: TaskListQueryKind;
  sortBy: ZCodeTaskListSortBy;
  search: string;
  expanded: boolean;
  visibleLimit: number | null;
  workspaceKeys: string[];
}

export interface CachedTaskListResult {
  taskKeys: TaskEntityKey[];
  /** workspace 分页前的完整未读成员；其它列表查询可省略。 */
  unreadTaskKeys?: TaskEntityKey[];
  searchSnippetsByTaskKey?: Record<TaskEntityKey, string>;
  searchSnippetListsByTaskKey?: Record<TaskEntityKey, string[]>;
  total: number;
  hasMore: boolean;
  fetchedAt: number;
  /** 每次 query scope 失效都递增；旧异步结果只能提交到它启动时观察到的代次。 */
  invalidationVersion: number;
  stale: boolean;
  partial: boolean;
  loadingShardKeys: string[];
  failedShardKeys: string[];
  descriptor: TaskListCacheDescriptor;
}

export function buildTaskWorkspaceKey(workspacePath: string, workspaceIdentity?: string): string {
  return resolveWorkspaceStateKey(workspacePath, workspaceIdentity);
}

export function buildTaskEntityKey(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
): TaskEntityKey {
  return `${buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity)}::${task.taskId}`;
}

function normalizeTaskListWorkspaceScopes(
  scopes: ZCodeTaskListWorkspaceScope[],
): ZCodeTaskListWorkspaceScope[] {
  const uniqueScopes = new Map<string, ZCodeTaskListWorkspaceScope>();

  for (const scope of scopes) {
    const workspaceKey = buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity);
    if (!workspaceKey.trim()) {
      continue;
    }
    uniqueScopes.set(workspaceKey, scope);
  }

  return [...uniqueScopes.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, scope]) => scope);
}

function normalizeTaskListSearch(search?: string): string {
  return search?.trim().toLocaleLowerCase() ?? "";
}

export function buildTaskListCacheDescriptor(params: {
  kind: TaskListQueryKind;
  workspaceScopes: ZCodeTaskListWorkspaceScope[];
  sortBy: ZCodeTaskListSortBy;
  search?: string;
  expanded: boolean;
  visibleLimit?: number | null;
}): TaskListCacheDescriptor {
  const normalizedScopes = normalizeTaskListWorkspaceScopes(params.workspaceScopes);
  const workspaceKeys = normalizedScopes.map((scope) =>
    buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity),
  );

  return {
    kind: params.kind,
    sortBy: params.sortBy,
    search: normalizeTaskListSearch(params.search),
    expanded: params.expanded,
    visibleLimit: params.expanded || params.visibleLimit === undefined ? null : params.visibleLimit,
    workspaceKeys,
  };
}

export function buildTaskListCacheKeyFromDescriptor(
  descriptor: TaskListCacheDescriptor,
): TaskListCacheKey {
  const workspaceSegment = descriptor.workspaceKeys.join("|");

  return [
    descriptor.kind,
    descriptor.sortBy,
    descriptor.expanded ? "expanded" : "collapsed",
    // timeline/show more 会通过 visibleLimit 从 20 提升到 40/60。
    // 如果缓存 key 不包含 limit，展开后的查询会命中旧首屏缓存并跳过刷新，导致“显示更多”不补数据。
    `limit=${descriptor.visibleLimit ?? "all"}`,
    `search=${descriptor.search}`,
    `workspaces=${workspaceSegment}`,
  ].join("::");
}
