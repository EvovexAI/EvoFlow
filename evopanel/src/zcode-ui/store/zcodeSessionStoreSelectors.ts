/**
 * ZCode Session Store 选择器与内部辅助函数
 *
 * 从 zcodeSessionStore.ts 拆分出来，包含 workspace 状态读取/更新辅助函数，
 * 以及所有按 task 粒度的只读访问器和独立选择器。
 */
import type { ZCodeTaskRuntimeStatus, ZCodeTaskMeta } from "@zcode/shared";
import { mergeTaskWithOptimisticMeta } from "@/lib/zcodeTaskMetaMerge.js";
import {
  DEFAULT_TASK_UI_STATE,
  DEFAULT_WORKSPACE_INIT_STATE,
  DEFAULT_TASK_RUNTIME_STATE,
  createDefaultWorkspaceState,
  getDefaultWorkspaceState,
  type ZCodeSessionStoreState,
  type WorkspaceInitState,
  type TaskRuntimeState,
  type WorkspaceZCodeUIState,
} from "./zcodeSessionStoreTypes.js";

// ────────────────────────────────────────────
// Internal helpers（store 本体也需要使用）
// ────────────────────────────────────────────

export function resolveWorkspaceStateKey(
  workspacePath: string,
  workspaceIdentity?: string,
): string {
  return workspaceIdentity?.trim() || workspacePath;
}

function copyTaskRecordEntries<T>(
  record: Record<string, T>,
  taskIds: ReadonlySet<string>,
): Record<string, T> {
  const entries = Object.entries(record).filter(([taskId]) => taskIds.has(taskId));
  return entries.length > 0 ? Object.fromEntries(entries) : {};
}

function collectIdentityTaskIds(
  baseState: WorkspaceZCodeUIState,
  workspaceIdentity: string,
): Set<string> {
  const normalizedIdentity = workspaceIdentity.trim();
  const taskIds = new Set<string>();
  for (const task of baseState.taskListCache ?? []) {
    if (task.workspaceIdentity?.trim() === normalizedIdentity) {
      taskIds.add(task.taskId);
    }
  }
  for (const task of Object.values(baseState.optimisticTaskListByTaskId)) {
    if (task.workspaceIdentity?.trim() === normalizedIdentity) {
      taskIds.add(task.taskId);
    }
  }
  return taskIds;
}

function createIdentityWorkspaceStateSeed(
  baseState: WorkspaceZCodeUIState | undefined,
  workspaceIdentity?: string,
): WorkspaceZCodeUIState {
  if (!baseState) {
    return createDefaultWorkspaceState(getDefaultWorkspaceState().selectedProvider);
  }

  const seededState = createDefaultWorkspaceState(baseState.selectedProvider);
  const migratedTaskIds = workspaceIdentity
    ? collectIdentityTaskIds(baseState, workspaceIdentity)
    : new Set<string>();
  const migratedTaskListCache =
    baseState.taskListCache?.filter((task) => migratedTaskIds.has(task.taskId)) ?? null;
  return {
    ...seededState,
    // identity 首次写入时可以继承 workspace/draft 级展示种子，
    // 但 task 状态只能按已持久化的 workspaceIdentity 做一次性迁移，不能动态合并 path 桶。
    selectedSupplierKey: baseState.selectedSupplierKey,
    isGhostSupplier: baseState.isGhostSupplier,
    supplierMismatchReason: baseState.supplierMismatchReason,
    configOptions: baseState.configOptions,
    configOptionsStatus: baseState.configOptionsStatus,
    slashCommands: baseState.slashCommands,
    ...(migratedTaskIds.size > 0
      ? {
          activeTaskId:
            baseState.activeTaskId && migratedTaskIds.has(baseState.activeTaskId)
              ? baseState.activeTaskId
              : seededState.activeTaskId,
          optimisticTaskListByTaskId: copyTaskRecordEntries(
            baseState.optimisticTaskListByTaskId,
            migratedTaskIds,
          ),
          taskConfigOptionsByTaskId: copyTaskRecordEntries(
            baseState.taskConfigOptionsByTaskId,
            migratedTaskIds,
          ),
          taskConfigOptionsStatusByTaskId: copyTaskRecordEntries(
            baseState.taskConfigOptionsStatusByTaskId,
            migratedTaskIds,
          ),
          taskListCache: migratedTaskListCache,
          taskListVersion: baseState.taskListVersion,
          taskRuntimeByTaskId: copyTaskRecordEntries(
            baseState.taskRuntimeByTaskId,
            migratedTaskIds,
          ),
          taskUiByTaskId: copyTaskRecordEntries(baseState.taskUiByTaskId, migratedTaskIds),
          taskUnreadByTaskId: copyTaskRecordEntries(baseState.taskUnreadByTaskId, migratedTaskIds),
        }
      : {}),
  };
}

export function getWorkspaceState(
  state: ZCodeSessionStoreState,
  workspacePath: string,
  workspaceIdentity?: string,
): WorkspaceZCodeUIState {
  const baseState = state.workspaces[workspacePath] ?? getDefaultWorkspaceState();
  const workspaceKey = resolveWorkspaceStateKey(workspacePath, workspaceIdentity);
  if (workspaceKey === workspacePath) {
    return baseState;
  }

  const identityState = state.workspaces[workspaceKey];
  if (!identityState) {
    return baseState;
  }

  // workspaceIdentity 表示远程/隔离 workspace 身份，path 桶只用于本地 fallback
  // 和 identity 桶首次写入前的一次性迁移起点。identity 桶一旦存在，就不能再动态合并
  // path task maps，否则同一路径的不同 SSH/WSL/Docker 窗口会互相读到 task config、队列和错误态。
  return identityState;
}

export function updateWorkspaceState(
  state: ZCodeSessionStoreState,
  workspacePath: string,
  updater: (current: WorkspaceZCodeUIState) => WorkspaceZCodeUIState,
  workspaceIdentity?: string,
): Pick<ZCodeSessionStoreState, "workspaces"> {
  const workspaceKey = resolveWorkspaceStateKey(workspacePath, workspaceIdentity);
  const current =
    workspaceKey === workspacePath
      ? getWorkspaceState(state, workspacePath, workspaceIdentity)
      : (state.workspaces[workspaceKey] ??
        createIdentityWorkspaceStateSeed(state.workspaces[workspacePath], workspaceIdentity));
  const nextWorkspaceState = updater(current);

  if (nextWorkspaceState === current) {
    // 单 ZCode Agent 迁移后旧 provider 选择都会归一为 glm，很多调用实际不会改变状态。
    // 如果仍把 merged overlay 快照写回 identity bucket，会打破 selector 的引用缓存并触发无意义重渲染。
    return { workspaces: state.workspaces };
  }

  if (workspaceKey === workspacePath) {
    return {
      workspaces: {
        ...state.workspaces,
        [workspacePath]: nextWorkspaceState,
      },
    };
  }

  return {
    workspaces: {
      ...state.workspaces,
      // 远程 workspace 的 workspace 级状态必须只写 identity key。
      // 不能为了兼容未透传 identity 的调用同时写 path key：同一路径的另一个远程窗口会从 path fallback
      // 读到这份状态，造成 slashCommands、模型切换与初始化状态串台。相关调用链已补齐 identity，
      // 这里不再污染 path 桶。
      [workspaceKey]: nextWorkspaceState,
    },
  };
}

// ────────────────────────────────────────────
// Per-task accessor functions
// ────────────────────────────────────────────

export function getTaskRuntimeState(
  workspaceState: WorkspaceZCodeUIState,
  taskId: string,
): TaskRuntimeState {
  return workspaceState.taskRuntimeByTaskId[taskId] ?? DEFAULT_TASK_RUNTIME_STATE;
}

interface WorkspaceDisplayedTaskState {
  taskStatus: ZCodeTaskRuntimeStatus;
  taskError: string | null;
}

export function getWorkspaceDisplayedTaskState(
  workspaceState: WorkspaceZCodeUIState,
): WorkspaceDisplayedTaskState {
  if (!workspaceState.activeTaskId) {
    return {
      taskStatus: workspaceState.draftRuntime.status,
      taskError: workspaceState.draftRuntime.error,
    };
  }

  const runtimeState = getTaskRuntimeState(workspaceState, workspaceState.activeTaskId);
  return {
    taskStatus: runtimeState.status,
    taskError: runtimeState.error,
  };
}

export function getTaskUiState(workspaceState: WorkspaceZCodeUIState, taskId: string) {
  return workspaceState.taskUiByTaskId[taskId] ?? DEFAULT_TASK_UI_STATE;
}

export function getTaskMeta(
  workspaceState:
    | WorkspaceZCodeUIState
    | Partial<Pick<WorkspaceZCodeUIState, "optimisticTaskListByTaskId" | "taskListCache">>,
  taskId: string,
): ZCodeTaskMeta | null {
  const optimisticTask = workspaceState.optimisticTaskListByTaskId?.[taskId];
  const cachedTask = workspaceState.taskListCache?.find((task) => task.taskId === taskId) ?? null;

  if (!optimisticTask) {
    return cachedTask;
  }

  if (!cachedTask) {
    return optimisticTask;
  }

  return mergeTaskWithOptimisticMeta(cachedTask, optimisticTask);
}

export function getVisibleTaskMetas(
  workspaceState:
    | WorkspaceZCodeUIState
    | Partial<Pick<WorkspaceZCodeUIState, "optimisticTaskListByTaskId" | "taskListCache">>,
): ZCodeTaskMeta[] {
  const taskById = new Map<string, ZCodeTaskMeta>();

  for (const task of workspaceState.taskListCache ?? []) {
    taskById.set(task.taskId, task);
  }

  for (const task of Object.values(workspaceState.optimisticTaskListByTaskId ?? {})) {
    taskById.set(task.taskId, getTaskMeta(workspaceState, task.taskId) ?? task);
  }

  return Array.from(taskById.values());
}

export function getTaskUnreadIndicator(
  workspaceState:
    | WorkspaceZCodeUIState
    | Partial<
        Pick<
          WorkspaceZCodeUIState,
          "optimisticTaskListByTaskId" | "taskListCache" | "taskUnreadByTaskId"
        >
      >,
  taskId: string,
  fallbackTask?: Pick<ZCodeTaskMeta, "unreadAt">,
): boolean {
  const storedTask = getTaskMeta(workspaceState, taskId);
  // IDE 升级或重启后，任务列表会先从 query cache 恢复，而 session store 尚未水合；
  // 此时持久化 unreadAt 只存在于列表 task。仅在 store 缺少该 task 时回退，避免旧列表覆盖 optimistic 已读状态。
  return (
    Boolean((storedTask ?? fallbackTask)?.unreadAt) ||
    workspaceState.taskUnreadByTaskId?.[taskId] === true
  );
}

// ────────────────────────────────────────────
// Standalone selector functions
// ────────────────────────────────────────────

export function selectWorkspaceZCodeState(
  state: ZCodeSessionStoreState,
  workspacePath: string,
  workspaceIdentity?: string,
) {
  return getWorkspaceState(state, workspacePath, workspaceIdentity);
}

export function getWorkspaceInitState(
  workspaceState: Pick<WorkspaceZCodeUIState, "workspaceInit">,
): WorkspaceInitState {
  return workspaceState.workspaceInit ?? DEFAULT_WORKSPACE_INIT_STATE;
}
