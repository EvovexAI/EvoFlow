import type { GitChangeSourceId } from "@zcode/shared";
import {
  normalizeWorkspaceSidePaneState,
  type WorkspaceSidePaneState,
} from "@/lib/workspaceSidePane.js";

interface TaskSidePaneMemoryState {
  sidePaneState: WorkspaceSidePaneState | null;
  isSidePaneCollapsed: boolean;
  /** 对话级展开/收起偏好；tabs 本身仍按 workspace 复用。 */
  sidePaneCollapsedByOwner: Record<string, boolean>;
  activeGitSourceId: GitChangeSourceId;
  browserUrls: Record<string, string>;
  /** @deprecated 旧版单浏览器 tab 的 URL，保留用于读取历史内存状态。 */
  browserUrl: string | null;
}

const DEFAULT_TASK_SIDE_PANE_MEMORY_STATE: TaskSidePaneMemoryState = {
  sidePaneState: null,
  isSidePaneCollapsed: true,
  sidePaneCollapsedByOwner: {},
  activeGitSourceId: "unstaged",
  browserUrls: {},
  browserUrl: null,
};

const TASK_SIDE_PANE_MEMORY_MAX_ENTRIES = 50;

const DRAFT_SIDE_PANE_OWNER_KEY = "__draft__";

const taskSidePaneMemory = new Map<string, TaskSidePaneMemoryState>();

function touchTaskSidePaneMemoryEntry(
  key: string,
  state: TaskSidePaneMemoryState,
): TaskSidePaneMemoryState {
  taskSidePaneMemory.delete(key);
  taskSidePaneMemory.set(key, state);
  return state;
}

function pruneTaskSidePaneMemory(): void {
  while (taskSidePaneMemory.size > TASK_SIDE_PANE_MEMORY_MAX_ENTRIES) {
    const oldestKey = taskSidePaneMemory.keys().next().value;
    if (!oldestKey) {
      return;
    }

    taskSidePaneMemory.delete(oldestKey);
  }
}

export function buildTaskSidePaneMemoryKey({
  workspacePath,
  workspaceIdentity,
  taskId,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string | null;
}): string | null {
  // side pane 的语义是“当前 workspace 右侧辅助工作区”，
  // 不是 task 自己的私有上下文。之前把 taskId 拼进 key 之后，
  // 同一 workspace 下切换 task 会命中一份全新的 side pane 内存，
  // 导致用户正在看的 browser / git / code viewer 像是被“切任务顺手清空”。
  // 这里改回只按 workspace 身份隔离，让同 workspace 的 task 共用同一份 side pane 状态。
  void taskId;
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  return workspaceKey.trim() ? workspaceKey : null;
}

export function readTaskSidePaneMemoryState(key: string | null): TaskSidePaneMemoryState {
  if (!key) {
    return DEFAULT_TASK_SIDE_PANE_MEMORY_STATE;
  }

  const state = taskSidePaneMemory.get(key);
  if (!state) {
    return DEFAULT_TASK_SIDE_PANE_MEMORY_STATE;
  }

  const normalizedState = {
    ...DEFAULT_TASK_SIDE_PANE_MEMORY_STATE,
    ...state,
    sidePaneState: normalizeWorkspaceSidePaneState(state.sidePaneState),
    sidePaneCollapsedByOwner: {
      ...DEFAULT_TASK_SIDE_PANE_MEMORY_STATE.sidePaneCollapsedByOwner,
      ...state.sidePaneCollapsedByOwner,
    },
  };
  return touchTaskSidePaneMemoryEntry(key, normalizedState);
}

export function saveTaskSidePaneMemoryState(
  key: string | null,
  patch: Partial<TaskSidePaneMemoryState>,
): void {
  if (!key) {
    return;
  }

  // side pane memory 是 renderer 模块级缓存，长期切换大量 workspace 时旧 key
  // 如果永不淘汰会持续持有 tabs、browser URL、diff patch 等状态。这里用简单 LRU 上限
  // 保留最近访问的 workspace 状态，避免长时间运行时 Map 无界增长。
  const nextState = {
    ...DEFAULT_TASK_SIDE_PANE_MEMORY_STATE,
    ...taskSidePaneMemory.get(key),
    ...patch,
    sidePaneCollapsedByOwner: {
      ...DEFAULT_TASK_SIDE_PANE_MEMORY_STATE.sidePaneCollapsedByOwner,
      ...taskSidePaneMemory.get(key)?.sidePaneCollapsedByOwner,
      ...patch.sidePaneCollapsedByOwner,
    },
  };
  nextState.sidePaneState = normalizeWorkspaceSidePaneState(nextState.sidePaneState);
  touchTaskSidePaneMemoryEntry(key, nextState);
  pruneTaskSidePaneMemory();
}

export function getSidePaneCollapsedPreference(
  state: TaskSidePaneMemoryState,
  ownerTaskId: string | null | undefined,
): boolean | undefined {
  return state.sidePaneCollapsedByOwner[ownerTaskId ?? DRAFT_SIDE_PANE_OWNER_KEY];
}

export function saveTaskSidePaneCollapsedPreference(
  key: string | null,
  ownerTaskId: string | null | undefined,
  isSidePaneCollapsed: boolean,
): void {
  if (!key) return;

  const state = readTaskSidePaneMemoryState(key);
  const ownerKey = ownerTaskId ?? DRAFT_SIDE_PANE_OWNER_KEY;
  saveTaskSidePaneMemoryState(key, {
    isSidePaneCollapsed,
    sidePaneCollapsedByOwner: {
      ...state.sidePaneCollapsedByOwner,
      [ownerKey]: isSidePaneCollapsed,
    },
  });
}
