/**
 * ZCode Session Store 导航切片 —— 任务前进/后退历史管理
 *
 * 从 zcodeSessionStore.ts 拆分出来，封装所有任务导航相关的初始状态和 action。
 * 通过 createNavigationSlice(set, get) 返回可直接展开到 store 的对象。
 */
import {
  createTaskNavigationHistory,
  goBack as navGoBack,
  goForward as navGoForward,
  pushAutomationsNavEntry,
  pushPluginStoreNavEntry,
  removeTaskFromHistory,
  type AutomationsNavigationTab,
  type WorkspaceNavEntry,
} from "@/lib/taskNavigationHistory.js";
import type { ZCodeSessionStoreState } from "./zcodeSessionStoreTypes.js";

type SetFn = (
  partial:
    | ZCodeSessionStoreState
    | Partial<ZCodeSessionStoreState>
    | ((state: ZCodeSessionStoreState) => ZCodeSessionStoreState | Partial<ZCodeSessionStoreState>),
) => void;
type GetFn = () => ZCodeSessionStoreState;

/**
 * 创建导航切片，供 store creator 展开使用：
 * `...createNavigationSlice(set, get)`
 */
export function createNavigationSlice(set: SetFn, get: GetFn) {
  return {
    taskNavHistory: createTaskNavigationHistory(),

    taskNavPushAutomations: (
      workspacePath: string,
      workspaceIdentity?: string,
      automationId?: string,
      automationTab?: AutomationsNavigationTab,
    ) => {
      set((state) => ({
        taskNavHistory: pushAutomationsNavEntry(
          state.taskNavHistory,
          workspacePath,
          workspaceIdentity,
          automationId,
          automationTab,
        ),
      }));
    },

    taskNavPushPluginStore: (workspacePath: string, workspaceIdentity?: string) => {
      set((state) => ({
        taskNavHistory: pushPluginStoreNavEntry(
          state.taskNavHistory,
          workspacePath,
          workspaceIdentity,
        ),
      }));
    },

    taskNavGoBack: (): WorkspaceNavEntry | null => {
      const state = get();
      const result = navGoBack(state.taskNavHistory);
      if (!result) {
        return null;
      }

      set({ taskNavHistory: result.history });
      return result.entry;
    },

    taskNavGoForward: (): WorkspaceNavEntry | null => {
      const state = get();
      const result = navGoForward(state.taskNavHistory);
      if (!result) {
        return null;
      }

      set({ taskNavHistory: result.history });
      return result.entry;
    },

    removeTaskFromNavHistory: (taskId: string) => {
      set((state) => ({
        taskNavHistory: removeTaskFromHistory(state.taskNavHistory, taskId),
      }));
    },
  };
}
