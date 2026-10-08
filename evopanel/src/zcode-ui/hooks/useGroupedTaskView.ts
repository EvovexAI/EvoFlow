/* eslint-disable max-lines -- Grouped 视图 hook 集中维护 optimistic overlay、排序保存和 ungroup 持久化，拆开会让同一份 view 状态在多个 hook 间漂移。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type {
  ZCodeGroupedTaskView,
  ZCodeGroupedTaskViewOrderInput,
  ZCodeGroupedTaskViewStructure,
  ZCodeGroupedTaskViewTopLevelNodeRef,
  ZCodeTaskGroup,
  ZCodeTaskGroupColor,
} from "@zcode/services";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useLocalWorkspaceScopes } from "@/hooks/useLocalWorkspaceScopes.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { logger } from "@/logger.js";
import { buildGroupedTaskViewFromSessions } from "@/lib/buildGroupedTaskViewFromSessions.js";
import { mergeTaskListMembershipFields } from "@/v4/taskListRowActivity.js";
import { fetchTaskListMembershipSets } from "@/lib/taskListMembershipSets.js";
import { useTaskListMembershipVersion } from "@/v4/taskListMembershipVersion.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { buildTaskEntityKey, buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { mergeTaskWithOptimisticMeta } from "@/lib/zcodeTaskMetaMerge.js";
import {
  useWorkspaceTaskOptimisticOverlayByWorkspaceKey,
  type WorkspaceOptimisticTaskOverlay,
} from "@/hooks/workspaceTaskListOptimisticOverlay.js";
import { moveTaskToGroupStart } from "@/workspace-grouped-tasks/view.js";
import { areStabilizedValuesEquivalent } from "@/v4/taskListItemStabilization.js";
import { taskKey as groupedTaskKey } from "@/workspace-grouped-tasks/ids.js";

function applyPromotedGroupPlacements(
  view: ZCodeGroupedTaskView,
  promotedDraftByTaskKey: ReadonlyMap<
    string,
    WorkspaceOptimisticTaskOverlay["promotedGroupedDraftTaskByTaskId"][string]
  >,
  optimisticTaskByKey: ReadonlyMap<string, ZCodeTaskMeta>,
): ZCodeGroupedTaskView {
  let nextView = view;
  for (const [taskKey, promotedDraft] of promotedDraftByTaskKey) {
    if (promotedDraft.placement.type === "top") {
      const rootIndex = nextView.nodes.findIndex(
        (node) => node.type === "task" && buildTaskEntityKey(node.task) === taskKey,
      );
      if (rootIndex <= 0) continue;
      // sessions-index 与 grouped structure 异步到达时，缺序 task 会被临时补到末尾。
      // 提升态收敛前继续沿用 draft 的 root 顶部位置，避免同一行先到底部再回顶部。
      const nodes = [...nextView.nodes];
      const [rootTask] = nodes.splice(rootIndex, 1);
      if (rootTask) nodes.unshift(rootTask);
      nextView = { nodes };
      continue;
    }
    const task = optimisticTaskByKey.get(taskKey);
    if (!task) {
      continue;
    }
    if (isTaskFirstInGroup(nextView, taskKey, promotedDraft.placement.groupId)) {
      continue;
    }
    nextView = moveTaskToGroupStart(nextView, {
      activeTaskKey: groupedTaskKey(task),
      groupId: promotedDraft.placement.groupId,
    });
  }
  return nextView;
}

function findTaskInGroupedView(
  view: ZCodeGroupedTaskView,
  taskEntityKey: string,
): ZCodeTaskMeta | undefined {
  for (const node of view.nodes) {
    if (node.type === "group") {
      const task = node.tasks.find((candidate) => buildTaskEntityKey(candidate) === taskEntityKey);
      if (task) return task;
      continue;
    }
    if (buildTaskEntityKey(node.task) === taskEntityKey) return node.task;
  }
  return undefined;
}

function isTaskFirstInGroup(
  view: ZCodeGroupedTaskView,
  taskEntityKey: string,
  groupId: string,
): boolean {
  const group = view.nodes.find((node) => node.type === "group" && node.group.id === groupId);
  return Boolean(
    group?.type === "group" &&
    group.tasks[0] &&
    buildTaskEntityKey(group.tasks[0]) === taskEntityKey,
  );
}

function buildWorkspaceScopes(workspaceTabs: WorkspaceTabState[]) {
  return workspaceTabs.map((tab) => ({
    workspacePath: tab.workspacePath,
    workspaceIdentity: tab.workspaceIdentity,
    workspacePurpose: tab.workspacePurpose,
  }));
}

function collectViewWorkspaceScopes(
  view: ZCodeGroupedTaskView,
): Array<{ workspacePath: string; workspaceIdentity?: string }> {
  const workspaceScopes = new Map<string, { workspacePath: string; workspaceIdentity?: string }>();
  const addTask = (task: ZCodeTaskMeta) => {
    const workspaceKey = buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity);
    workspaceScopes.set(workspaceKey, {
      workspacePath: task.workspacePath,
      workspaceIdentity: task.workspaceIdentity,
    });
  };

  for (const node of view.nodes) {
    if (node.type === "group") {
      node.tasks.forEach(addTask);
      continue;
    }
    addTask(node.task);
  }

  return [...workspaceScopes.values()];
}

function mergeGroupedTaskViewWithOptimistic(params: {
  view: ZCodeGroupedTaskView;
  optimisticOverlays: Iterable<WorkspaceOptimisticTaskOverlay>;
  visibleMissingTaskKeys: ReadonlySet<string>;
}): ZCodeGroupedTaskView {
  const optimisticTaskByKey = new Map<string, ZCodeTaskMeta>();
  const placementTaskByKey = new Map<string, ZCodeTaskMeta>();
  const promotedDraftByTaskKey = new Map<
    string,
    WorkspaceOptimisticTaskOverlay["promotedGroupedDraftTaskByTaskId"][string]
  >();

  for (const node of params.view.nodes) {
    if (node.type === "group") {
      for (const task of node.tasks) placementTaskByKey.set(buildTaskEntityKey(task), task);
      continue;
    }
    placementTaskByKey.set(buildTaskEntityKey(node.task), node.task);
  }

  for (const overlay of params.optimisticOverlays) {
    for (const task of overlay.tasks) {
      const taskKey = buildTaskEntityKey(task);
      optimisticTaskByKey.set(taskKey, task);
      placementTaskByKey.set(taskKey, task);
      // optimistic overlay 是跨 hook 的运行时对象，旧测试和旧调用可能还没有
      // promotedGroupedDraftTaskByTaskId。这里用空对象兼容缺省字段，避免 grouped 合并阶段
      // 因为草稿位置信息缺失而直接崩溃；缺省时按普通 optimistic task 顶层补入。
    }
    for (const [taskId, promotedDraft] of Object.entries(
      overlay.promotedGroupedDraftTaskByTaskId ?? {},
    )) {
      promotedDraftByTaskKey.set(
        buildTaskEntityKey({
          taskId,
          workspacePath: promotedDraft.workspacePath,
          workspaceIdentity: promotedDraft.workspaceIdentity,
        }),
        promotedDraft,
      );
    }
  }

  if (optimisticTaskByKey.size === 0 && promotedDraftByTaskKey.size === 0) {
    return params.view;
  }

  const visibleTaskKeys = new Set<string>();
  let changed = false;
  const nodes = params.view.nodes.map((node) => {
    if (node.type === "group") {
      let tasksChanged = false;
      const tasks = node.tasks.map((task) => {
        const taskKey = buildTaskEntityKey(task);
        visibleTaskKeys.add(taskKey);
        const optimisticTask = optimisticTaskByKey.get(taskKey);
        if (!optimisticTask) {
          return task;
        }
        tasksChanged = true;
        // grouped optimistic meta 也不能整对象覆盖 sessions-index。
        // 否则虽然显式 sort_order 没变，行内时间/phase 会被 tasks-index 时间污染。
        // grouped draft 提升的最小 overlay 标题为空，整对象展开
        // 会持续压住 sessions-index 后续下发的真实标题。先按 task meta 字段权威合并，
        // 再保留 sessions-index 拥有的 membership/activity 字段。
        return mergeTaskListMembershipFields(
          task,
          mergeTaskWithOptimisticMeta(task, optimisticTask),
        );
      });
      if (!tasksChanged) {
        return node;
      }
      changed = true;
      return { ...node, tasks };
    }

    const taskKey = buildTaskEntityKey(node.task);
    visibleTaskKeys.add(taskKey);
    const optimisticTask = optimisticTaskByKey.get(taskKey);
    if (!optimisticTask) {
      return node;
    }
    changed = true;
    return {
      ...node,
      task: mergeTaskListMembershipFields(
        node.task,
        mergeTaskWithOptimisticMeta(node.task, optimisticTask),
      ),
    };
  });

  const missingVisibleTasks = [...optimisticTaskByKey.entries()]
    .filter(
      ([taskKey]) => params.visibleMissingTaskKeys.has(taskKey) && !visibleTaskKeys.has(taskKey),
    )
    .map(([, task]) => task)
    .sort((left, right) => {
      if (right.updatedAt !== left.updatedAt) {
        return right.updatedAt - left.updatedAt;
      }
      if (right.createdAt !== left.createdAt) {
        return right.createdAt - left.createdAt;
      }
      return right.taskId.localeCompare(left.taskId);
    });

  if (missingVisibleTasks.length === 0) {
    return applyPromotedGroupPlacements(
      changed ? { nodes } : params.view,
      promotedDraftByTaskKey,
      placementTaskByKey,
    );
  }

  const groupMissingTasksByGroupId = new Map<string, ZCodeTaskMeta[]>();
  const topMissingTasks: ZCodeTaskMeta[] = [];
  for (const task of missingVisibleTasks) {
    const promotedDraft = promotedDraftByTaskKey.get(buildTaskEntityKey(task));
    if (promotedDraft?.placement.type === "group") {
      const groupTasks = groupMissingTasksByGroupId.get(promotedDraft.placement.groupId) ?? [];
      groupTasks.push(task);
      groupMissingTasksByGroupId.set(promotedDraft.placement.groupId, groupTasks);
      continue;
    }
    topMissingTasks.push(task);
  }

  const nodesWithGroupDraftTasks = nodes.map((node) => {
    if (node.type !== "group") {
      return node;
    }
    const groupTasks = groupMissingTasksByGroupId.get(node.group.id);
    if (!groupTasks?.length) {
      return node;
    }
    return { ...node, tasks: [...groupTasks, ...node.tasks] };
  });
  const missingGroupTasksWithoutGroup = [...groupMissingTasksByGroupId.entries()]
    .filter(([, tasks]) => tasks.length > 0)
    .flatMap(([groupId, tasks]) =>
      nodes.some((node) => node.type === "group" && node.group.id === groupId) ? [] : tasks,
    );

  // grouped 视图以前只展示 sqlite query 的结果；首发 task 已写入本地 optimistic
  // cache，但服务端初始 snapshot 为避免闪 "New session" 会延后广播，导致 grouped 列表要等重启
  // 或下一次全量刷新才看见新 task。这里只补已被 grouped hook 标记为临时可见的 optimistic task，
  // 避免把已归档/置顶等其它本地缓存误插回 grouped 顶层；从 grouped 草稿提升来的 task
  // 还会沿用临时实体所在的 group/top 位置，直到 sqlite 排序保存完成。
  return applyPromotedGroupPlacements(
    {
      nodes: [
        ...topMissingTasks.concat(missingGroupTasksWithoutGroup).map((task) => ({
          type: "task" as const,
          task,
        })),
        ...nodesWithGroupDraftTasks,
      ],
    },
    promotedDraftByTaskKey,
    placementTaskByKey,
  );
}

function collectGroupedViewTaskKeys(view: ZCodeGroupedTaskView): Set<string> {
  const taskKeys = new Set<string>();
  for (const node of view.nodes) {
    if (node.type === "group") {
      for (const task of node.tasks) {
        taskKeys.add(buildTaskEntityKey(task));
      }
      continue;
    }
    taskKeys.add(buildTaskEntityKey(node.task));
  }
  return taskKeys;
}

export function shouldHideGroupedTaskContent(params: {
  initialized: boolean;
  loading: boolean;
  hasNodes: boolean;
  /**
   * 门禁只该拦首屏。已经画出过列表之后再回到隐藏态，就是用户看到的
   * 「grouped 整块闪一下」——祖先重挂载和后台刷新都会走到这里。
   * 画过一次之后一律继续渲染上一份列表：旧数据优于空白。
   */
  hasPaintedOnce?: boolean;
}): boolean {
  if (params.hasPaintedOnce) {
    return false;
  }
  return !params.initialized || (params.loading && !params.hasNodes);
}

function isGroupedTaskViewInitialized(params: {
  remoteDataInitialized: boolean;
  hydratingEndpointKeys: readonly string[];
  /**
   * 这个门禁只负责首屏。以前它直接读当前的 hydrating 状态，运行中任务每输出一次 tool
   * 结果都会让 Controller 列表重查一轮（loading=true），门禁随之关门、grouped 主体整棵卸载再
   * 重挂载——表现为左侧分组列表抖动。就绪一次之后永久保持就绪，后台刷新不再回到首屏态。
   */
  previouslyInitialized?: boolean;
}): boolean {
  if (params.previouslyInitialized) {
    return true;
  }
  return params.remoteDataInitialized && params.hydratingEndpointKeys.length === 0;
}

/**
 * grouped structure/membership 的按 key 单飞缓存。
 *
 * 切换到分组视图时，hook 挂载和 sessions-index 首帧会并发 refresh；旧缓存只保存
 * 已完成结果，所有 cache miss 都各自请求一遍全部 workspace，导致 RPC 风暴并让 loading 不断换代。
 * 这里同时保存进行中的 Promise，并用 generation/sequence 阻止失效或旧 key 的迟到结果回填缓存。
 */
class GroupedRemoteDataSingleFlight<T> {
  private generation = 0;
  private requestSequence = 0;
  private completed: { key: string; value: T } | null = null;
  private readonly inFlightByKey = new Map<
    string,
    {
      generation: number;
      latestRequestSequence: number;
      promise: Promise<T> | null;
    }
  >();

  load(key: string, fetchValue: () => Promise<T>): Promise<T> {
    const requestSequence = this.requestSequence + 1;
    this.requestSequence = requestSequence;
    if (this.completed?.key === key) {
      return Promise.resolve(this.completed.value);
    }

    const generation = this.generation;
    const existing = this.inFlightByKey.get(key);
    if (existing?.generation === generation && existing.promise) {
      existing.latestRequestSequence = requestSequence;
      return existing.promise;
    }

    const inFlight = {
      generation,
      latestRequestSequence: requestSequence,
      promise: null as Promise<T> | null,
    };
    const promise = Promise.resolve()
      .then(fetchValue)
      .then((value) => {
        if (
          this.generation === generation &&
          this.requestSequence === inFlight.latestRequestSequence
        ) {
          this.completed = { key, value };
        }
        return value;
      })
      .finally(() => {
        if (this.inFlightByKey.get(key)?.promise === promise) {
          this.inFlightByKey.delete(key);
        }
      });
    inFlight.promise = promise;
    this.inFlightByKey.set(key, inFlight);
    return promise;
  }

  isCurrent(key: string, value: T): boolean {
    return this.completed?.key === key && this.completed.value === value;
  }

  invalidate(): void {
    this.generation += 1;
    this.completed = null;
    this.inFlightByKey.clear();
  }
}

function prependTaskGroupToView(
  view: ZCodeGroupedTaskView,
  group: ZCodeTaskGroup,
): ZCodeGroupedTaskView {
  if (view.nodes.some((node) => node.type === "group" && node.group.id === group.id)) {
    return view;
  }
  const minimumSortOrder = view.nodes.reduce(
    (minimum, node) => Math.min(minimum, node.sortOrder ?? 0),
    0,
  );
  return {
    nodes: [
      {
        type: "group",
        group,
        tasks: [],
        sortOrder: minimumSortOrder - 1000,
      },
      ...view.nodes,
    ],
  };
}

function reconcileGroupedOptimisticTaskKeys(params: {
  view: ZCodeGroupedTaskView;
  optimisticOverlays: Iterable<WorkspaceOptimisticTaskOverlay>;
  previousVisibleMissingTaskKeys: ReadonlySet<string>;
}): Set<string> {
  const groupedViewTaskKeys = collectGroupedViewTaskKeys(params.view);
  const optimisticTaskKeys = new Set<string>();
  const nextVisibleMissingTaskKeys = new Set<string>();

  for (const overlay of params.optimisticOverlays) {
    for (const task of overlay.tasks) {
      const taskKey = buildTaskEntityKey(task);
      optimisticTaskKeys.add(taskKey);
      if (overlay.activeTaskId === task.taskId && !groupedViewTaskKeys.has(taskKey)) {
        nextVisibleMissingTaskKeys.add(taskKey);
      }
    }
  }

  for (const taskKey of params.previousVisibleMissingTaskKeys) {
    if (groupedViewTaskKeys.has(taskKey) || !optimisticTaskKeys.has(taskKey)) {
      continue;
    }
    nextVisibleMissingTaskKeys.add(taskKey);
  }

  return nextVisibleMissingTaskKeys;
}

function groupedNodeIdentityKey(node: ZCodeGroupedTaskView["nodes"][number]): string {
  if (node.type === "group") {
    return `group:${node.group.id}`;
  }
  return `task:${buildTaskWorkspaceKey(node.task.workspacePath, node.task.workspaceIdentity)}:${node.task.taskId}`;
}

function areGroupedNodesEquivalent(
  previous: ZCodeGroupedTaskView["nodes"][number],
  next: ZCodeGroupedTaskView["nodes"][number],
): boolean {
  if (previous.type !== next.type || previous.sortOrder !== next.sortOrder) {
    return false;
  }
  if (previous.type === "group" && next.type === "group") {
    // 用结构比较而非 JSON.stringify：group meta 经 IPC/join 重建后 key 顺序不保证稳定，
    // 字符串比较会让等价判断恒为 false，节点稳定化静默退化成每帧全新引用。
    if (!areStabilizedValuesEquivalent(previous.group, next.group)) {
      return false;
    }
    // 任务对象来自 sessions-index 聚合层（引用已稳定化）+ joinTaskListUnreadAt（未变则保引用），
    // 引用逐位相同即内容等价。
    return (
      previous.tasks.length === next.tasks.length &&
      next.tasks.every((task, index) => task === previous.tasks[index])
    );
  }
  return previous.type === "task" && next.type === "task" && previous.task === next.task;
}

/**
 * grouped refresh 每轮都重建整棵视图对象树，即使内容没变（或只变了一条），
 * 所有 group/task 行都会拿到新引用整体重渲染——表现为侧栏分组列表"重新加载"。
 * 这里做节点级引用稳定化：等价节点复用旧对象；整树等价时返回旧视图（setState 同引用直接 bail）。
 */
function stabilizeGroupedView(
  previous: ZCodeGroupedTaskView,
  next: ZCodeGroupedTaskView,
): ZCodeGroupedTaskView {
  if (previous.nodes.length === 0) {
    return next;
  }
  const previousByKey = new Map(previous.nodes.map((node) => [groupedNodeIdentityKey(node), node]));
  let identical = previous.nodes.length === next.nodes.length;
  const nodes = next.nodes.map((node, index) => {
    const previousNode = previousByKey.get(groupedNodeIdentityKey(node));
    if (previousNode && areGroupedNodesEquivalent(previousNode, node)) {
      if (identical && previous.nodes[index] !== previousNode) {
        identical = false;
      }
      return previousNode;
    }
    identical = false;
    return node;
  });
  return identical ? previous : { nodes };
}

function nodeToTopLevelRef(
  node: ZCodeGroupedTaskView["nodes"][number],
): ZCodeGroupedTaskViewTopLevelNodeRef {
  if (node.type === "group") {
    return { type: "group", groupId: node.group.id };
  }
  return {
    type: "task",
    task: {
      workspacePath: node.task.workspacePath,
      workspaceIdentity: node.task.workspaceIdentity,
      taskId: node.task.taskId,
    },
  };
}

function viewToOrderInput(params: { view: ZCodeGroupedTaskView }): ZCodeGroupedTaskViewOrderInput {
  return {
    workspaceScopes: collectViewWorkspaceScopes(params.view),
    topLevelNodes: params.view.nodes.map(nodeToTopLevelRef),
    groups: params.view.nodes
      .filter((node) => node.type === "group")
      .map((node) => ({
        groupId: node.group.id,
        taskRefs: node.tasks.map((task) => ({
          workspacePath: task.workspacePath,
          workspaceIdentity: task.workspaceIdentity,
          taskId: task.taskId,
        })),
      })),
  };
}

/**
 * 跨挂载的 grouped 视图缓存（按 scope 签名分桶）。
 *
 * grouped 是唯一把整份列表放在组件实例 useState 里的侧栏视图，timeline/pinned
 * 都从模块级 query cache 渲染。一旦 section 因祖先重挂载 / HMR 重新挂载，grouped 会退回
 * 「空视图 + 首屏门禁关门」，直到两个 RPC 回来——表现为分组列表整块闪一下。这里把最后一份
 * 权威视图留在模块级，重挂载可以立即接着画，RPC 只负责收敛。
 *
 * 脏读窗口（显式契约，不是缺陷）：缓存只在 refresh 成功时写入，没有主动失效。组件卸载期间
 * 发生的删除 / 归档 / 分组变更不会淘汰缓存，重挂载后这些旧行会立即可见且可点击，直到挂载
 * effect 触发的 refresh 返回——窗口上界就是一次 RPC 往返。这是「旧数据优于空白」的既定折衷；
 * 若后续收到点击脏行的反馈，再考虑给缓存条目加 TTL 或降级为占位，而不是扩大这个窗口。
 */
const GROUPED_VIEW_CACHE_MAX_KEYS = 8;
const groupedViewCacheBySignature = new Map<string, ZCodeGroupedTaskView>();

function readCachedGroupedView(signature: string): ZCodeGroupedTaskView | undefined {
  return groupedViewCacheBySignature.get(signature);
}

function writeCachedGroupedView(signature: string, view: ZCodeGroupedTaskView): void {
  groupedViewCacheBySignature.delete(signature);
  groupedViewCacheBySignature.set(signature, view);
  while (groupedViewCacheBySignature.size > GROUPED_VIEW_CACHE_MAX_KEYS) {
    const oldestKey = groupedViewCacheBySignature.keys().next().value;
    if (oldestKey === undefined) break;
    groupedViewCacheBySignature.delete(oldestKey);
  }
}

export function useGroupedTaskView(params: { workspaceTabs: WorkspaceTabState[] }) {
  const services = useBaseWorkspaceServices();
  // grouped 仍是本地 workspace-only，但 task facts 也必须来自窗口 Controller，不能在
  // Renderer 另起 sessions-index join。分组结构/顺序继续走本地 task service，避免能力扩张。
  const localWorkspaceTabs = useLocalWorkspaceScopes({
    workspaceTabs: params.workspaceTabs,
  });
  // scopes 过去 memo 在 tabs 数组身份上。父级重建同值数组就会换掉 refresh 身份，
  // 让「refresh 变化即刷新」的 effect 再跑一轮 setState，进而触发下一次渲染——自激刷新环，
  // 每帧都在发 RPC 并让门禁/空态有机会闪。这里改成值签名，和 useGlobalTaskList 保持一致。
  const localWorkspaceScopeSignature = JSON.stringify(
    localWorkspaceTabs
      .map(
        (tab) =>
          [
            buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity),
            tab.workspacePath,
            tab.workspaceIdentity ?? null,
            tab.workspacePurpose ?? null,
          ] as const,
      )
      .sort(
        (
          [leftKey, leftPath, leftIdentity, leftPurpose],
          [rightKey, rightPath, rightIdentity, rightPurpose],
        ) =>
          // 逐级 tie-break：只按 workspaceKey 排序时，同 key 不同 purpose 的两个 tab 比较结果为 0，
          // 稳定排序保留输入顺序——tabs 数组里互换位置就会换出新签名并触发一次多余 refresh。
          String(leftKey).localeCompare(String(rightKey)) ||
          String(leftPath).localeCompare(String(rightPath)) ||
          String(leftIdentity ?? "").localeCompare(String(rightIdentity ?? "")) ||
          String(leftPurpose ?? "").localeCompare(String(rightPurpose ?? "")),
      ),
  );
  const scopes = useMemo(
    () => buildWorkspaceScopes(localWorkspaceTabs),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 值签名等价即复用，避免父级数组换身份触发刷新环。
    [localWorkspaceScopeSignature],
  );
  const sessionsIndexScopes = useMemo(
    () =>
      scopes.map((scope) => ({
        workspacePath: scope.workspacePath,
        ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      })),
    [scopes],
  );
  const [view, setView] = useState<ZCodeGroupedTaskView>(
    () => readCachedGroupedView(localWorkspaceScopeSignature) ?? { nodes: [] },
  );
  const viewRef = useRef(view);
  viewRef.current = view;
  const [loading, setLoading] = useState(false);
  const [remoteDataInitialized, setRemoteDataInitialized] = useState(
    () => readCachedGroupedView(localWorkspaceScopeSignature) !== undefined,
  );
  const [saving, setSaving] = useState(false);
  const requestIdRef = useRef(0);
  const taskListVersionSignature = useZCodeSessionStore((state) =>
    JSON.stringify(
      params.workspaceTabs.map((tab) => {
        const workspaceKey = buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity);
        const workspaceState = selectWorkspaceZCodeState(
          state,
          tab.workspacePath,
          tab.workspaceIdentity,
        );
        return [workspaceKey, workspaceState.taskListVersion] as const;
      }),
    ),
  );
  const controllerTaskFacts = useGlobalTaskList({
    kind: "active",
    workspaceTabs: localWorkspaceTabs,
    sortBy: "updated",
    searchQuery: "",
    expanded: true,
    collapsedLimit: 1,
  });
  const sessionsIndexItems = controllerTaskFacts.items;
  // 缓存命中即视为已初始化：重挂载后 Controller 列表会重新进入 loading，若不把闩锁一起
  // 从缓存种下，第一帧仍会关门闪一下。
  const initializedLatchRef = useRef(
    readCachedGroupedView(localWorkspaceScopeSignature) !== undefined,
  );
  const initialized = isGroupedTaskViewInitialized({
    remoteDataInitialized,
    hydratingEndpointKeys: controllerTaskFacts.loading ? ["window-controller"] : [],
    previouslyInitialized: initializedLatchRef.current,
  });
  // 渲染期写 ref 的前提（禁止照搬到非单调状态）：本 ref 是单调闩锁（false→true，永不回落），
  // 且新值完全由本次渲染的输入推导。React 18 concurrent 下被丢弃的渲染同样会执行这次赋值，
  // 但对单调闩锁而言「提前置位」等价于「提前就绪」，只会让门禁更早开门，不会产生错误状态。
  // 换成任何可回落 / 依赖提交顺序的状态，这个写法就会漏帧且不可复现——那种状态必须用 effect。
  initializedLatchRef.current = initialized;
  const sessionsIndexItemsRef = useRef(sessionsIndexItems);
  sessionsIndexItemsRef.current = sessionsIndexItems;
  // pin/archive 归属版本：mutation 后 bump，grouped 视图（非 pinned 非 archived）随之权威 re-filter。
  const membershipVersion = useTaskListMembershipVersion();
  const optimisticTaskOverlayByWorkspaceKey = useWorkspaceTaskOptimisticOverlayByWorkspaceKey(
    params.workspaceTabs,
  );
  const clearPromotedGroupedDraftTask = useZCodeSessionStore(
    (state) => state.clearPromotedGroupedDraftTask,
  );
  const visibleMissingTaskKeysRef = useRef<Set<string>>(new Set());
  const promotedGroupPersistenceRef = useRef<Set<string>>(new Set());
  const displayedViewRef = useRef<ZCodeGroupedTaskView>({ nodes: [] });
  const displayedView = useMemo(() => {
    const optimisticOverlays = [...optimisticTaskOverlayByWorkspaceKey.values()];
    const visibleMissingTaskKeys = reconcileGroupedOptimisticTaskKeys({
      view,
      optimisticOverlays,
      previousVisibleMissingTaskKeys: visibleMissingTaskKeysRef.current,
    });
    visibleMissingTaskKeysRef.current = visibleMissingTaskKeys;
    // overlay 帧（运行中任务的 optimistic meta 回写）会绕过 view 的节点稳定化，
    // 每次都产出新的 group/task 节点对象，让侧栏整棵列表重渲染并重测量虚拟器。
    // 展示视图再过一遍同一套节点级稳定化，等价时连数组身份都保持不变。
    const nextDisplayedView = stabilizeGroupedView(
      displayedViewRef.current,
      mergeGroupedTaskViewWithOptimistic({
        view,
        optimisticOverlays,
        visibleMissingTaskKeys,
      }),
    );
    displayedViewRef.current = nextDisplayedView;
    return nextDisplayedView;
  }, [optimisticTaskOverlayByWorkspaceKey, view]);

  // 差量更新：grouped structure（分组/排序）与 membership（pin/archive/unread）都不随
  // sessions-index 内容帧（title/status）变化。按「membershipVersion + 结构版本 + scope 签名」
  // 缓存，内容帧触发的 refresh 只做内存 join，不发 RPC。分组 mutation 路径显式失效。
  const [remoteDataLoader] = useState(
    () =>
      new GroupedRemoteDataSingleFlight<{
        structure: ZCodeGroupedTaskViewStructure;
        membership: Awaited<ReturnType<typeof fetchTaskListMembershipSets>>;
      }>(),
  );
  const invalidateRemoteData = useCallback(() => {
    remoteDataLoader.invalidate();
  }, [remoteDataLoader]);

  const refresh = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    // loading 只表达「首屏还没有任何权威节点」。运行中任务每输出一次 tool 结果都会
    // 触发一轮后台 refresh，如果这里无条件置位，空态文案与首屏门禁都会随之闪一下。
    if (viewRef.current.nodes.length === 0) {
      setLoading(true);
    }
    try {
      // tasks-index 同时提供持久 task 行和分组结构；sessions-index 只 enrich activity/detail。
      // grouped 侧边栏必须跟随当前打开的 workspace scope，
      // 不传 includeAllWorkspaces，避免其它 workspace 的分组混入。
      const remoteDataKey = [
        membershipVersion,
        taskListVersionSignature,
        scopes
          .map((scope) => buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity))
          .join("|"),
      ].join("::");
      const remoteData = await remoteDataLoader.load(remoteDataKey, async () => {
        const [structureResult, membershipResult] = await Promise.all([
          services.zcodeTaskService.listGroupedTaskViewStructure({
            workspaceScopes: scopes,
          }),
          fetchTaskListMembershipSets({
            service: services.zcodeTaskService,
            scopes: sessionsIndexScopes,
          }),
        ]);
        return {
          structure: structureResult,
          membership: membershipResult,
        };
      });
      if (
        requestIdRef.current === requestId &&
        remoteDataLoader.isCurrent(remoteDataKey, remoteData)
      ) {
        const { structure, membership } = remoteData;
        const nextView = buildGroupedTaskViewFromSessions({
          structure,
          taskIndexItems: membership.taskIndexItems,
          sessions: sessionsIndexItemsRef.current,
          pinnedIds: membership.pinnedIds,
          archivedIds: membership.archivedIds,
          deletedIds: membership.deletedIds,
        });
        // 内容没变时复用旧视图/旧节点引用，setState 同引用直接 bail，避免整列表无效重渲染。
        // 用 viewRef 读当前视图而不是在 updater 里做副作用：StrictMode 会重复调用 updater。
        const stabilizedView = stabilizeGroupedView(viewRef.current, nextView);
        writeCachedGroupedView(localWorkspaceScopeSignature, stabilizedView);
        setView(stabilizedView);
      }
    } catch (error) {
      // 同一 remote Promise 可能被多次 refresh 共享；只由最新请求记录一次失败，避免错误路径
      // 重新形成日志风暴。旧请求仍会进入 finally，但不能关闭最新一代 loading。
      if (requestIdRef.current === requestId) {
        logger.error("[useGroupedTaskView] 加载 grouped task 视图失败", error);
      }
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false);
        // 首次请求无论成功还是失败都结束初始化门禁；失败由日志记录并进入空态，
        // 避免永久 loading。后续 refresh 保留既有列表，不再回到首次加载态。
        setRemoteDataInitialized(true);
      }
    }
  }, [
    localWorkspaceScopeSignature,
    membershipVersion,
    remoteDataLoader,
    scopes,
    sessionsIndexScopes,
    services.zcodeTaskService,
    taskListVersionSignature,
  ]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    const authoritativeTaskKeys = collectGroupedViewTaskKeys(view);
    const promotedGroupTasks: ZCodeTaskMeta[] = [];
    const settledRootTasks: ZCodeTaskMeta[] = [];
    for (const overlay of optimisticTaskOverlayByWorkspaceKey.values()) {
      for (const [taskId, promotedDraft] of Object.entries(
        overlay.promotedGroupedDraftTaskByTaskId ?? {},
      )) {
        const key = buildTaskEntityKey({
          taskId,
          workspacePath: promotedDraft.workspacePath,
          workspaceIdentity: promotedDraft.workspaceIdentity,
        });
        const task = findTaskInGroupedView(displayedView, key);
        if (promotedDraft?.placement.type === "top") {
          const firstNode = view.nodes[0];
          if (task && firstNode?.type === "task" && buildTaskEntityKey(firstNode.task) === key) {
            settledRootTasks.push(task);
          }
        } else if (
          task &&
          (authoritativeTaskKeys.has(key) || visibleMissingTaskKeysRef.current.has(key)) &&
          !isTaskFirstInGroup(view, key, promotedDraft.placement.groupId)
        ) {
          promotedGroupTasks.push(task);
        }
      }
    }
    for (const task of settledRootTasks) {
      clearPromotedGroupedDraftTask(task.workspacePath, task.taskId, task.workspaceIdentity);
    }
    if (promotedGroupTasks.length === 0) {
      return;
    }
    const signature = promotedGroupTasks.map(buildTaskEntityKey).sort().join("|");
    if (promotedGroupPersistenceRef.current.has(signature)) {
      return;
    }
    promotedGroupPersistenceRef.current.add(signature);
    // group 内 New task 过去只在 optimistic view 继承草稿位置，SQLite 仍按 root
    // 新任务置顶，刷新后任务会掉出 group。task 已进入 optimistic index 后，将同一份展示
    // view 作为完整排序事务落库，使 membership 和组内第一位顺序一起收敛。
    void services.zcodeTaskService
      .applyGroupedTaskViewOrder(viewToOrderInput({ view: displayedView }))
      .then(() => {
        invalidateRemoteData();
        return refreshRef.current().then(() => {
          for (const task of promotedGroupTasks) {
            clearPromotedGroupedDraftTask(task.workspacePath, task.taskId, task.workspaceIdentity);
          }
        });
      })
      .catch((error) => {
        promotedGroupPersistenceRef.current.delete(signature);
        logger.error("[useGroupedTaskView] 保存 grouped 草稿提升位置失败", error);
      });
  }, [
    clearPromotedGroupedDraftTask,
    displayedView,
    invalidateRemoteData,
    optimisticTaskOverlayByWorkspaceKey,
    services.zcodeTaskService,
    view,
  ]);

  useEffect(() => {
    const disposables = scopes.map((scope) =>
      services.zcodeTaskService.onDynamicWorkspaceEvent(scope)((event) => {
        if (event.type !== "workspace_task_list_changed" || event.reason !== "task_created") {
          return;
        }
        // sessions-index 可见帧可能早于 SQLite grouped sort_order 写入。
        // task_created 是首次排序已经提交的边界，必须丢弃旧 structure 缓存并重拉；
        // 否则运行中会按缺序节点补到末尾，只有重启重建缓存后才恢复。
        invalidateRemoteData();
        void refreshRef.current();
      }),
    );
    return () => disposables.forEach((disposable) => disposable.dispose());
  }, [invalidateRemoteData, scopes, services.zcodeTaskService]);

  // 唯一的自动刷新入口。refresh 身份已经包含 membership/structure/scope 版本，
  // sessions-index 内容变化再触发内存 join；避免 mount effect 与 index effect 首帧重复发起请求。
  useEffect(() => {
    void refresh();
  }, [refresh, sessionsIndexItems]);

  const createGroup = useCallback(async (): Promise<ZCodeTaskGroup> => {
    setSaving(true);
    try {
      const group = await services.zcodeTaskService.createTaskGroup();
      // 新 group 的 SQLite 顺序已经置顶，但等待异步 refresh 才展示会短暂沿用旧树并
      // 落到缺序节点末尾；先按同一 sort_order 语义乐观插顶，refresh 再以 SQLite 收敛。
      setView((current) => prependTaskGroupToView(current, group));
      // 分组结构已变，失效远端数据缓存再重建（membershipVersion bump 可能晚于本地 refresh）。
      invalidateRemoteData();
      await refresh();
      return group;
    } catch (error) {
      logger.error("[useGroupedTaskView] 创建 task group 失败", error);
      throw error;
    } finally {
      setSaving(false);
    }
  }, [invalidateRemoteData, refresh, services.zcodeTaskService]);

  const renameGroup = useCallback(
    async (groupId: string, title: string) => {
      const previousView = view;
      const groupNode = view.nodes.find(
        (node) => node.type === "group" && node.group.id === groupId,
      );
      const nextTitle = title.trim() || (groupNode?.type === "group" ? groupNode.group.title : "");
      if (!groupNode || groupNode.type !== "group" || groupNode.group.title === nextTitle) {
        return;
      }

      const optimisticView: ZCodeGroupedTaskView = {
        nodes: view.nodes.map((node) =>
          node.type === "group" && node.group.id === groupId
            ? {
                ...node,
                group: {
                  ...node.group,
                  title: nextTitle,
                  updatedAt: Date.now(),
                },
              }
            : node,
        ),
      };
      setView(optimisticView);
      setSaving(true);
      try {
        const renamedGroup = await services.zcodeTaskService.renameTaskGroup({
          groupId,
          title: nextTitle,
          workspaceScopes: collectViewWorkspaceScopes(optimisticView),
        });
        invalidateRemoteData();
        setView({
          nodes: optimisticView.nodes.map((node) =>
            node.type === "group" && node.group.id === groupId
              ? { ...node, group: renamedGroup }
              : node,
          ),
        });
      } catch (error) {
        setView(previousView);
        logger.error("[useGroupedTaskView] 重命名 task group 失败", error);
        throw error;
      } finally {
        setSaving(false);
      }
    },
    [invalidateRemoteData, scopes, services.zcodeTaskService, view],
  );

  const updateGroupColor = useCallback(
    async (groupId: string, color: ZCodeTaskGroupColor) => {
      const previousView = view;
      const groupNode = view.nodes.find(
        (node) => node.type === "group" && node.group.id === groupId,
      );
      if (!groupNode || groupNode.type !== "group" || groupNode.group.color === color) {
        return;
      }

      const optimisticView: ZCodeGroupedTaskView = {
        nodes: view.nodes.map((node) =>
          node.type === "group" && node.group.id === groupId
            ? {
                ...node,
                group: {
                  ...node.group,
                  color,
                  updatedAt: Date.now(),
                },
              }
            : node,
        ),
      };
      setView(optimisticView);
      setSaving(true);
      try {
        const updatedGroup = await services.zcodeTaskService.updateTaskGroupColor({
          groupId,
          color,
          workspaceScopes: collectViewWorkspaceScopes(optimisticView),
        });
        invalidateRemoteData();
        setView({
          nodes: optimisticView.nodes.map((node) =>
            node.type === "group" && node.group.id === groupId
              ? { ...node, group: updatedGroup }
              : node,
          ),
        });
      } catch (error) {
        setView(previousView);
        logger.error("[useGroupedTaskView] 更新 task group 颜色失败", error);
        throw error;
      } finally {
        setSaving(false);
      }
    },
    [invalidateRemoteData, scopes, services.zcodeTaskService, view],
  );

  const applyOrder = useCallback(
    async (nextView: ZCodeGroupedTaskView) => {
      const previousView = view;
      setView(nextView);
      setSaving(true);
      try {
        // apply 回包的视图仍由 tasks 表 join（旧数据源），不再采信；
        // 持久化成功后以「结构 + sessions-index」重建收敛（refresh）。
        await services.zcodeTaskService.applyGroupedTaskViewOrder(
          viewToOrderInput({
            view: nextView,
          }),
        );
        invalidateRemoteData();
        await refreshRef.current();
      } catch (error) {
        // grouped 视图写入失败时回滚本地乐观视图，再触发一次刷新收敛到 sqlite 真相源。
        setView(previousView);
        void refresh();
        logger.error("[useGroupedTaskView] 保存 grouped task 顺序失败", error);
        throw error;
      } finally {
        setSaving(false);
      }
    },
    [invalidateRemoteData, refresh, services.zcodeTaskService, view],
  );

  const ungroupGroup = useCallback(
    async (groupId: string) => {
      const groupNode = view.nodes.find(
        (node) => node.type === "group" && node.group.id === groupId,
      );
      if (!groupNode || groupNode.type !== "group") {
        return;
      }
      const nextView: ZCodeGroupedTaskView = {
        nodes: view.nodes.flatMap((node) =>
          node.type === "group" && node.group.id === groupId
            ? node.tasks.map((task) => ({ type: "task" as const, task }))
            : [node],
        ),
      };

      setSaving(true);
      try {
        await applyOrder(nextView);
        await services.zcodeTaskService.deleteTaskGroup({
          groupId,
          workspaceScopes: collectViewWorkspaceScopes(nextView),
        });
        invalidateRemoteData();
        await refresh();
      } catch (error) {
        logger.error("[useGroupedTaskView] 取消 task group 分组失败", error);
        throw error;
      } finally {
        setSaving(false);
      }
    },
    [applyOrder, invalidateRemoteData, refresh, scopes, services.zcodeTaskService, view],
  );

  return {
    view: displayedView,
    setView,
    loading,
    initialized,
    saving,
    refresh,
    createGroup,
    renameGroup,
    updateGroupColor,
    ungroupGroup,
    applyOrder,
  };
}
