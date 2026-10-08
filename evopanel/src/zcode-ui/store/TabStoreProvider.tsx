/**
 * TabStoreProvider —— 初始化 Tab Zustand store 并通过 React Context 提供
 *
 * 每个窗口独立挂载，tab 状态不跨窗口广播。
 */
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { useStore } from "zustand";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import { createTabStore, type TabStore, type TabStoreState } from "./tabStore.js";

declare global {
  interface Window {
    __zcodeTabStoreE2E?: TabStore;
  }
}

const TabStoreContext = createContext<TabStore | null>(null);
const fallbackTabStore = createTabStore(null);

export function TabStoreProvider({ children }: { children: ReactNode }) {
  // 只在首次渲染时创建 store，避免 HMR 重复创建
  const storeRef = useRef<TabStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = createTabStore();
  }

  useEffect(() => {
    if (!shouldExposeE2EStoreBridge() || !storeRef.current) {
      return;
    }

    const store = storeRef.current;
    // V4 draft 没有 taskId，E2E 若按 activeTaskId=null 反查 workspace，
    // 多 workspace 会命中任意草稿桶。只在 E2E 构建暴露当前窗口导航 store，供 helper
    // 按 workspaceIdentity?.trim() || workspacePath 精确读取当前草稿。
    window.__zcodeTabStoreE2E = store;
    return () => {
      if (window.__zcodeTabStoreE2E === store) {
        delete window.__zcodeTabStoreE2E;
      }
    };
  }, []);

  return <TabStoreContext.Provider value={storeRef.current}>{children}</TabStoreContext.Provider>;
}

/**
 * 消费 Tab store 的 hook
 *
 * 用法：
 *   const tabs = useTabStore(s => s.tabs);
 *   const addTab = useTabStore(s => s.addTab);
 */
export function useTabStore<T>(selector: (state: TabStoreState) => T): T {
  const store = useContext(TabStoreContext);
  if (!store) {
    throw new Error("useTabStore 必须在 TabStoreProvider 内使用");
  }
  return useStore(store, selector);
}

/** 供可独立渲染的展示组件读取；无 Root provider 时回退为空 tab 状态。 */
export function useOptionalTabStore<T>(selector: (state: TabStoreState) => T): T {
  const store = useContext(TabStoreContext);
  return useStore(store ?? fallbackTabStore, selector);
}

/**
 * 获取 tab store 的原始引用（用于非 React 上下文，如 useEffect 中的订阅）
 */
export function useTabStoreApi(): TabStore {
  const store = useContext(TabStoreContext);
  if (!store) {
    throw new Error("useTabStoreApi 必须在 TabStoreProvider 内使用");
  }
  return store;
}
