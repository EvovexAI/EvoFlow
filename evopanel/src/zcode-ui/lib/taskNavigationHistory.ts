/**
 * Workspace 导航历史 —— 浏览器式前进/后退栈
 *
 * 纯数据结构 + 不可变更新函数，不含 React 依赖。
 * 由 zcodeSessionStore 持有实例并驱动 UI 状态。
 */

interface WorkspaceNavEntryBase {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface TaskNavEntry extends WorkspaceNavEntryBase {
  kind: "task";
  taskId: string;
}

// "workflow" 是自动化页的顶级「工作流」标签；
// scheduled / idle 仍是「自动化」标签内部的胶囊。
export type AutomationsNavigationTab = "scheduled" | "idle" | "workflow";

export type OpenAutomationsMain = (
  automationId?: string,
  automationTab?: AutomationsNavigationTab,
) => void;

export interface AutomationsNavEntry extends WorkspaceNavEntryBase {
  kind: "automations";
  automationId?: string;
  automationTab?: AutomationsNavigationTab;
}

export interface PluginStoreNavEntry extends WorkspaceNavEntryBase {
  kind: "plugin-store";
}

export type WorkspaceNavEntry = TaskNavEntry | AutomationsNavEntry | PluginStoreNavEntry;

export interface TaskNavigationHistory {
  entries: WorkspaceNavEntry[];
  /** 当前指针，指向 entries 中的索引；-1 表示空 */
  cursor: number;
}

const MAX_HISTORY = 50;

export function createTaskNavigationHistory(): TaskNavigationHistory {
  return { entries: [], cursor: -1 };
}

function isTaskNavEntry(entry: WorkspaceNavEntry): entry is TaskNavEntry {
  return entry.kind === "task";
}

export function isAutomationsNavEntry(entry: WorkspaceNavEntry): entry is AutomationsNavEntry {
  return entry.kind === "automations";
}

export function isPluginStoreNavEntry(entry: WorkspaceNavEntry): entry is PluginStoreNavEntry {
  return entry.kind === "plugin-store";
}

function isSameNavEntry(left: WorkspaceNavEntry, right: WorkspaceNavEntry): boolean {
  if (
    left.kind !== right.kind ||
    left.workspacePath !== right.workspacePath ||
    left.workspaceIdentity !== right.workspaceIdentity
  ) {
    return false;
  }

  if (left.kind === "task") return left.taskId === (right as TaskNavEntry).taskId;
  if (left.kind === "automations") {
    const rightAutomations = right as AutomationsNavEntry;
    return (
      left.automationId === rightAutomations.automationId &&
      left.automationTab === rightAutomations.automationTab
    );
  }
  return true;
}

function pushEntry(
  history: TaskNavigationHistory,
  entry: WorkspaceNavEntry,
): TaskNavigationHistory {
  const current = history.cursor >= 0 ? history.entries[history.cursor] : null;

  // 相邻去重：历史回放或连续打开同一目标时不重复入栈。
  if (current && isSameNavEntry(current, entry)) {
    return history;
  }

  // 截断 cursor 之后的前进历史，保持浏览器式导航语义。
  const next = [...history.entries.slice(0, history.cursor + 1), entry];
  if (next.length > MAX_HISTORY) {
    const overflow = next.length - MAX_HISTORY;
    return {
      entries: next.slice(overflow),
      cursor: next.length - overflow - 1,
    };
  }

  return { entries: next, cursor: next.length - 1 };
}

/** 用户主动选择/创建 task 时调用。 */
export function pushNavEntry(
  history: TaskNavigationHistory,
  workspacePath: string,
  taskId: string,
  workspaceIdentity?: string,
): TaskNavigationHistory {
  // 远程 workspace 的导航不能只记路径。
  // 同一路径在本地/远端或多台远端机器上可能同时存在，必须把身份隔离键一起入栈。
  return pushEntry(history, {
    kind: "task",
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    taskId,
  });
}

/** 用户主动打开 Automations 主视图或指定详情时调用。 */
export function pushAutomationsNavEntry(
  history: TaskNavigationHistory,
  workspacePath: string,
  workspaceIdentity?: string,
  automationId?: string,
  automationTab?: AutomationsNavigationTab,
): TaskNavigationHistory {
  return pushEntry(history, {
    kind: "automations",
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(automationId ? { automationId } : {}),
    ...(automationTab ? { automationTab } : {}),
  });
}

export function pushPluginStoreNavEntry(
  history: TaskNavigationHistory,
  workspacePath: string,
  workspaceIdentity?: string,
): TaskNavigationHistory {
  return pushEntry(history, {
    kind: "plugin-store",
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  });
}

export function canGoBack(history: TaskNavigationHistory): boolean {
  return history.cursor > 0;
}

export function canGoForward(history: TaskNavigationHistory): boolean {
  return history.cursor < history.entries.length - 1;
}

/** 后退一步，返回新的 history 和目标 entry。 */
export function goBack(
  history: TaskNavigationHistory,
): { history: TaskNavigationHistory; entry: WorkspaceNavEntry } | null {
  if (!canGoBack(history)) {
    return null;
  }

  const nextCursor = history.cursor - 1;
  const entry = history.entries[nextCursor];
  if (!entry) {
    return null;
  }

  return {
    history: { ...history, cursor: nextCursor },
    entry,
  };
}

/** 前进一步，返回新的 history 和目标 entry。 */
export function goForward(
  history: TaskNavigationHistory,
): { history: TaskNavigationHistory; entry: WorkspaceNavEntry } | null {
  if (!canGoForward(history)) {
    return null;
  }

  const nextCursor = history.cursor + 1;
  const entry = history.entries[nextCursor];
  if (!entry) {
    return null;
  }

  return {
    history: { ...history, cursor: nextCursor },
    entry,
  };
}

/**
 * 从历史中移除指定 taskId 的所有 task 条目（task 被删除时调用）。
 * Automations 条目不属于 task 生命周期，必须原样保留。
 */
export function removeTaskFromHistory(
  history: TaskNavigationHistory,
  taskId: string,
): TaskNavigationHistory {
  const currentEntry = history.cursor >= 0 ? history.entries[history.cursor] : null;
  const filtered = history.entries.filter(
    (entry) => !isTaskNavEntry(entry) || entry.taskId !== taskId,
  );

  if (filtered.length === history.entries.length) {
    return history;
  }

  if (filtered.length === 0) {
    return createTaskNavigationHistory();
  }

  // 当前条目未被删除时保持指向它；被删时沿用旧位置选择最近目标。
  const currentEntryIndex = currentEntry ? filtered.indexOf(currentEntry) : -1;
  const cursor =
    currentEntryIndex >= 0 ? currentEntryIndex : Math.min(history.cursor, filtered.length - 1);

  return { entries: filtered, cursor };
}
