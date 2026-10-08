// 侧栏持久行与 pin/archive/groups 权威读取。tasks-index.sqlite 提供行集合和
// membership，sessions-index 只在后续投影中补充实时 activity/detail。
// unread 同为组织态（setTaskUnread 写 tasks-index），与 pin/archive 同类，
// 不进冻结的 sessions-index schema；这里平行拉取 unreadAt map，列表构建时 join。
import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";

interface TaskListMembershipScope {
  workspacePath: string;
  workspaceIdentity?: string;
}

type TaskListMembershipService = Pick<
  IZCodeTaskService,
  "listPinnedTaskIds" | "listArchivedTasks" | "listTasks" | "listPinnedTasks"
> &
  Partial<Pick<IZCodeTaskService, "listDeletedTaskIds">>;

interface TaskListMembershipSets {
  /** tasks-index 三个持久分区（active/pinned/archived）的完整 task 行并集。 */
  taskIndexItems: ZCodeTaskMeta[];
  pinnedIds: Set<string>;
  archivedIds: Set<string>;
  /** tasks-index 持久删除 tombstone；优先于所有列表 kind。 */
  deletedIds: Set<string>;
  /** taskId → unreadAt（tasks-index 组织态；sessions-index 不携带，join 用）。 */
  unreadAtByTaskId: Map<string, number>;
  /** taskId → terminal status（tasks-index 历史终态；用于冷启动 stored summary 补红点）。 */
  terminalStatusByTaskId: Map<string, Extract<ZCodeTaskMeta["status"], "completed" | "error">>;
  /**
   * taskId → 旧 task-index 手动标题。
   *
   * v4 sessions-index 主列表来自 CLI session store；老数据的用户重命名只在
   * tasks-index.title/titleOverridden 中。这里在既有 membership 读取里顺手带出，不迁移表。
   */
  titleOverrideByTaskId: Map<string, string>;
  /** taskId -> cronAutomationId（tasks-index 持久化身份；sessions-index 冻结 schema 不携带）。 */
  cronAutomationIdByTaskId: Map<string, string>;
}

export interface TaskListMembershipRefreshHoldState {
  armed: boolean;
  enteredCallCount: number;
  released: boolean;
}

interface ActiveTaskListMembershipRefreshHold {
  released: Promise<void>;
  release: () => void;
}

let activeTaskListMembershipRefreshHold: ActiveTaskListMembershipRefreshHold | null = null;
let taskListMembershipRefreshHoldState: TaskListMembershipRefreshHoldState = {
  armed: false,
  enteredCallCount: 0,
  released: true,
};

/**
 * E2E-only：暂停已经读取完成、但尚未返回给 renderer join 的 membership 快照。
 * TSL18 必须确定性制造“旧 running 快照在 Stop 终态之后返回”的窗口；
 * 真实 SQLite 太快，不能用 sleep 碰运气。入口只由受保护的 window.__testActions 暴露。
 */
export function armTaskListMembershipRefreshHoldForE2E(): void {
  if (activeTaskListMembershipRefreshHold) {
    throw new Error("task list membership refresh hold 已经启动");
  }
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  activeTaskListMembershipRefreshHold = { released, release };
  taskListMembershipRefreshHoldState = {
    armed: true,
    enteredCallCount: 0,
    released: false,
  };
  clearTaskListMembershipCache();
}

export function releaseTaskListMembershipRefreshHoldForE2E(): void {
  const hold = activeTaskListMembershipRefreshHold;
  if (!hold) {
    return;
  }
  activeTaskListMembershipRefreshHold = null;
  taskListMembershipRefreshHoldState = {
    ...taskListMembershipRefreshHoldState,
    armed: false,
    released: true,
  };
  hold.release();
}

export function getTaskListMembershipRefreshHoldStateForE2E(): TaskListMembershipRefreshHoldState {
  return { ...taskListMembershipRefreshHoldState };
}

async function holdTaskListMembershipRefreshResultForE2E(): Promise<void> {
  const hold = activeTaskListMembershipRefreshHold;
  if (!hold) {
    return;
  }
  taskListMembershipRefreshHoldState = {
    ...taskListMembershipRefreshHoldState,
    enteredCallCount: taskListMembershipRefreshHoldState.enteredCallCount + 1,
  };
  await hold.released;
}

/** remote shard 的归属在各自 endpoint 的 tasks-index，按 endpoint 分片拉取后求并。 */
interface TaskListMembershipEndpoint {
  service: TaskListMembershipService;
  scopes: TaskListMembershipScope[];
}

function scopeParams(scope: TaskListMembershipScope): {
  workspacePath: string;
  workspaceIdentity?: string;
} {
  return {
    workspacePath: scope.workspacePath,
    ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
  };
}

/** 可选辅助集合读取失败时按空集降级。 */
async function listOrEmpty<T>(list: () => Promise<T[]>): Promise<T[]> {
  try {
    return await list();
  } catch {
    return [];
  }
}

async function listWithAvailability<T>(
  list: () => Promise<T[]>,
): Promise<{ items: T[]; available: boolean }> {
  try {
    return { items: await list(), available: true };
  } catch {
    return { items: [], available: false };
  }
}

function collectUnreadAt(unreadAtByTaskId: Map<string, number>, tasks: ZCodeTaskMeta[]): void {
  for (const task of tasks) {
    if (typeof task.unreadAt === "number") {
      unreadAtByTaskId.set(task.taskId, task.unreadAt);
    }
  }
}

function collectTerminalStatuses(
  terminalStatusByTaskId: TaskListMembershipSets["terminalStatusByTaskId"],
  tasks: ZCodeTaskMeta[],
): void {
  for (const task of tasks) {
    if (task.status === "completed" || task.status === "error") {
      terminalStatusByTaskId.set(task.taskId, task.status);
    }
  }
}

function collectTitleOverrides(
  titleOverrideByTaskId: Map<string, string>,
  tasks: ZCodeTaskMeta[],
): void {
  for (const task of tasks) {
    if (task.titleOverridden === true && task.title.trim().length > 0) {
      titleOverrideByTaskId.set(task.taskId, task.title);
    }
  }
}

function collectCronAutomationIds(
  cronAutomationIdByTaskId: Map<string, string>,
  tasks: ZCodeTaskMeta[],
): void {
  for (const task of tasks) {
    if (task.cronAutomationId) {
      cronAutomationIdByTaskId.set(task.taskId, task.cronAutomationId);
    }
  }
}

function mergeTaskIndexItems(lists: ZCodeTaskMeta[][]): ZCodeTaskMeta[] {
  const itemByEntityKey = new Map<string, ZCodeTaskMeta>();
  for (const task of lists.flat()) {
    itemByEntityKey.set(buildTaskEntityKey(task), task);
  }
  return [...itemByEntityKey.values()];
}

/** 拉取服务端权威 task 行、pinned/archived id 集与其它持久元数据。 */
export async function fetchTaskListMembershipSets(params: {
  service: TaskListMembershipService;
  scopes: TaskListMembershipScope[];
}): Promise<TaskListMembershipSets> {
  const [
    pinnedList,
    archivedListResults,
    activeListResults,
    pinnedMetaListResults,
    deletedIdLists,
  ] = await Promise.all([
    listOrEmpty(() => params.service.listPinnedTaskIds()),
    Promise.all(
      params.scopes.map((scope) =>
        listWithAvailability(() => params.service.listArchivedTasks(scopeParams(scope))),
      ),
    ),
    // unread 覆盖三类成员：active（listTasks = 非 pinned 非 archived）、pinned、archived。
    Promise.all(
      params.scopes.map((scope) =>
        listWithAvailability(() => params.service.listTasks(scopeParams(scope))),
      ),
    ),
    Promise.all(
      params.scopes.map((scope) =>
        listWithAvailability(() => params.service.listPinnedTasks(scopeParams(scope))),
      ),
    ),
    Promise.all(
      params.scopes.map((scope) =>
        params.service.listDeletedTaskIds
          ? listOrEmpty(() => params.service.listDeletedTaskIds!(scopeParams(scope)))
          : Promise.resolve([]),
      ),
    ),
  ]);
  await holdTaskListMembershipRefreshResultForE2E();
  // task 行现在是所有侧栏列表的左表。任一分区 RPC 失败都不能
  // 当作“权威空集”发布，否则会把旧缓存整组清空；抛出后由 hook 保留旧视图。
  if (
    activeListResults.some((result) => !result.available) ||
    archivedListResults.some((result) => !result.available) ||
    pinnedMetaListResults.some((result) => !result.available)
  ) {
    throw new Error("tasks-index task 行读取不完整");
  }
  const archivedLists = archivedListResults.map((result) => result.items);
  const activeLists = activeListResults.map((result) => result.items);
  const pinnedMetaLists = pinnedMetaListResults.map((result) => result.items);
  const unreadAtByTaskId = new Map<string, number>();
  const terminalStatusByTaskId: TaskListMembershipSets["terminalStatusByTaskId"] = new Map();
  const titleOverrideByTaskId = new Map<string, string>();
  const cronAutomationIdByTaskId = new Map<string, string>();
  collectUnreadAt(unreadAtByTaskId, archivedLists.flat());
  collectUnreadAt(unreadAtByTaskId, activeLists.flat());
  collectUnreadAt(unreadAtByTaskId, pinnedMetaLists.flat());
  collectTerminalStatuses(terminalStatusByTaskId, archivedLists.flat());
  collectTerminalStatuses(terminalStatusByTaskId, activeLists.flat());
  collectTerminalStatuses(terminalStatusByTaskId, pinnedMetaLists.flat());
  collectTitleOverrides(titleOverrideByTaskId, archivedLists.flat());
  collectTitleOverrides(titleOverrideByTaskId, activeLists.flat());
  collectTitleOverrides(titleOverrideByTaskId, pinnedMetaLists.flat());
  // V4 侧栏主数据源切到 sessions-index 后，冻结的 SessionSummary 不带
  // cronAutomationId；如果这里不从 tasks-index 一并收集，持久化列虽有值，UI task 仍会丢身份。
  collectCronAutomationIds(cronAutomationIdByTaskId, archivedLists.flat());
  collectCronAutomationIds(cronAutomationIdByTaskId, activeLists.flat());
  collectCronAutomationIds(cronAutomationIdByTaskId, pinnedMetaLists.flat());
  return {
    // 持久 task 行存在性必须由 tasks-index 决定。之前这里只保留 membership
    // 集合并丢弃已经读取到的 task meta，迫使所有列表从 sessions-index 反向枚举行。
    taskIndexItems: mergeTaskIndexItems([
      activeLists.flat(),
      pinnedMetaLists.flat(),
      archivedLists.flat(),
    ]),
    // pinned task 行本身也是 membership 证据；即使辅助 id RPC 短暂失败，
    // 也不应把已经成功读到的 pinned 行误分到 timeline。
    pinnedIds: new Set([...pinnedList, ...pinnedMetaLists.flat().map((task) => task.taskId)]),
    archivedIds: new Set(archivedLists.flat().map((task) => task.taskId)),
    deletedIds: new Set(deletedIdLists.flat()),
    unreadAtByTaskId,
    terminalStatusByTaskId,
    titleOverrideByTaskId,
    cronAutomationIdByTaskId,
  };
}

// 差量更新修正：membership（pin/archive/unread）只随归属 mutation 变化（membershipVersion bump），
// 与 sessions-index 内容帧（title/status/lastActivity）无关。之前每帧都重拉——一次 title 变更
// 会让所有列表实例各发一轮 1+3×scopes 的 RPC（多 workspace 多实例下每帧上百次调用）。
// 这里按「membershipVersion + endpoints 签名」缓存 in-flight promise，跨 hook 实例共享；
// 版本 bump 或 endpoint 拓扑变化时自然换 key 重拉。缓存有界，避免历史版本堆积。
const membershipPromiseByCacheKey = new Map<string, Promise<TaskListMembershipSets>>();
const MEMBERSHIP_CACHE_MAX_KEYS = 8;
// service 实例身份进 key：不同 endpoint service（含测试 mock、重连后的新 proxy）不得共享缓存。
const membershipServiceIds = new WeakMap<TaskListMembershipService, number>();
let nextMembershipServiceId = 1;

function membershipServiceIdOf(service: TaskListMembershipService): number {
  let id = membershipServiceIds.get(service);
  if (id === undefined) {
    id = nextMembershipServiceId++;
    membershipServiceIds.set(service, id);
  }
  return id;
}

export function fetchTaskListMembershipSetsForEndpointsCached(params: {
  /** 建议形态：`${membershipVersion}::${endpoints 签名}`。 */
  cacheKey: string;
  endpoints: TaskListMembershipEndpoint[];
}): Promise<TaskListMembershipSets> {
  const fullCacheKey = `${params.cacheKey}::svc=${params.endpoints
    .map((endpoint) => membershipServiceIdOf(endpoint.service))
    .join(",")}`;
  const cached = membershipPromiseByCacheKey.get(fullCacheKey);
  if (cached) {
    return cached;
  }
  const promise = fetchTaskListMembershipSetsForEndpoints(params.endpoints);
  membershipPromiseByCacheKey.set(fullCacheKey, promise);
  // 辅助集合可按空集降级，但 task 行分区读取不完整会 reject；不缓存失败，
  // 避免一次短暂 RPC 异常被当前 version 粘住。
  promise.catch(() => membershipPromiseByCacheKey.delete(fullCacheKey));
  while (membershipPromiseByCacheKey.size > MEMBERSHIP_CACHE_MAX_KEYS) {
    const oldestKey = membershipPromiseByCacheKey.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    membershipPromiseByCacheKey.delete(oldestKey);
  }
  return promise;
}

/** 测试/异常恢复用：清空 membership 缓存。 */
function clearTaskListMembershipCache(): void {
  membershipPromiseByCacheKey.clear();
}

/** 按 endpoint 并行拉取归属并求并集（taskId 为 sessionId，跨 endpoint 不冲突）。 */
async function fetchTaskListMembershipSetsForEndpoints(
  endpoints: TaskListMembershipEndpoint[],
): Promise<TaskListMembershipSets> {
  const results = await Promise.all(
    endpoints
      .filter((endpoint) => endpoint.scopes.length > 0)
      .map((endpoint) =>
        fetchTaskListMembershipSets({
          service: endpoint.service,
          scopes: endpoint.scopes,
        }),
      ),
  );
  const merged: TaskListMembershipSets = {
    taskIndexItems: [],
    pinnedIds: new Set<string>(),
    archivedIds: new Set<string>(),
    deletedIds: new Set<string>(),
    unreadAtByTaskId: new Map<string, number>(),
    terminalStatusByTaskId: new Map(),
    titleOverrideByTaskId: new Map<string, string>(),
    cronAutomationIdByTaskId: new Map<string, string>(),
  };
  const taskIndexItemByEntityKey = new Map<string, ZCodeTaskMeta>();
  for (const result of results) {
    for (const task of result.taskIndexItems) {
      taskIndexItemByEntityKey.set(buildTaskEntityKey(task), task);
    }
    for (const taskId of result.pinnedIds) merged.pinnedIds.add(taskId);
    for (const taskId of result.archivedIds) merged.archivedIds.add(taskId);
    for (const taskId of result.deletedIds) merged.deletedIds.add(taskId);
    for (const [taskId, unreadAt] of result.unreadAtByTaskId) {
      merged.unreadAtByTaskId.set(taskId, unreadAt);
    }
    for (const [taskId, status] of result.terminalStatusByTaskId) {
      merged.terminalStatusByTaskId.set(taskId, status);
    }
    for (const [taskId, title] of result.titleOverrideByTaskId) {
      merged.titleOverrideByTaskId.set(taskId, title);
    }
    for (const [taskId, automationId] of result.cronAutomationIdByTaskId) {
      merged.cronAutomationIdByTaskId.set(taskId, automationId);
    }
  }
  merged.taskIndexItems = [...taskIndexItemByEntityKey.values()];
  return merged;
}
