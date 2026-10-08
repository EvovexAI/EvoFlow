// 分屏 Layout/Focus 层的 zustand 装配。
// 模型与纯状态机在 paneLayoutTree.ts，持久化在 paneLayoutPersistence.ts——
// 本文件只做 store 装配 + 持久化订阅，并 re-export 两者（消费面单一入口）。
import { create } from "zustand";
import { isRendererReloadNavigation } from "@/lib/rendererNavigation.js";
import { persistPaneLayout, readPersistedPaneLayout } from "@/v4/paneLayoutPersistence.js";
import {
  bindPaneSession,
  closePane,
  confirmRestoredPaneSession,
  focusPane,
  INITIAL_PANE_LAYOUT,
  openSessionInNewPane,
  replacePaneBinding,
  setSplitNodeRatio,
  splitPaneAt,
  splitPaneAtSide,
  type PaneBinding,
  type PaneLayoutSnapshot,
  type PaneSplitSide,
  type PaneWorkspaceScope,
  type SplitDirection,
} from "@/v4/paneLayoutTree.js";

const persistedPaneLayoutAtModuleLoad = readPersistedPaneLayout();
const restoredPaneLayoutAtModuleLoad = isRendererReloadNavigation()
  ? persistedPaneLayoutAtModuleLoad
  : null;

/** 冷启动入口用：识别并清理上一次 renderer 留下、但本次不应恢复的布局。 */
export function hadPersistedPaneLayoutAtModuleLoad(): boolean {
  return persistedPaneLayoutAtModuleLoad !== null;
}

export * from "@/v4/paneLayoutTree.js";
export * from "@/v4/paneLayoutPersistence.js";

interface PaneLayoutStore extends PaneLayoutSnapshot {
  /** 在 anchor pane 处拆分出 draft pane（绑 scope，首发 createSession 后原地绑定）。 */
  splitPane: (anchorPaneId: string, direction: SplitDirection, scope: PaneWorkspaceScope) => void;
  /** 在 anchor pane 四周拆出已绑定 session 的 pane（draft drop / 非 group 拖拽入口）。 */
  splitPaneWithBinding: (anchorPaneId: string, side: PaneSplitSide, binding: PaneBinding) => void;
  /** 侧栏/下钻入口：已开 → 聚焦；否则焦点 pane 向右拆分并绑定 session。 */
  openSessionInNewPane: (scope: PaneWorkspaceScope, sessionId: string) => void;
  /** draft 临时布局：普通 sidebar 点击只替换 focused secondary，不覆盖 primary draft。 */
  replacePaneBinding: (paneId: string, binding: PaneBinding) => void;
  closePane: (paneId: string) => void;
  focusPane: (paneId: string) => void;
  bindPaneSession: (paneId: string, sessionId: string) => void;
  setSplitRatio: (splitId: string, ratio: number) => void;
  confirmRestoredPaneSession: (paneId: string) => void;
  /** 新建任务/草稿时退出分屏显示，回到单 primary panel。 */
  resetToPrimaryPane: () => void;
}

/** 每窗口一份；action 引用稳定，可直接下发给 memo 组件。 */
export const usePaneLayoutStore = create<PaneLayoutStore>()((set) => ({
  // 只有同一 renderer reload 从 localStorage 恢复布局；app 冷启动从单 primary 草稿开始。
  ...(restoredPaneLayoutAtModuleLoad ?? INITIAL_PANE_LAYOUT),

  splitPane: (anchorPaneId, direction, scope) => {
    set((state) =>
      splitPaneAt(state, anchorPaneId, direction, {
        workspaceScope: scope,
        sessionId: null,
      }),
    );
  },

  splitPaneWithBinding: (anchorPaneId, side, binding) => {
    set((state) => splitPaneAtSide(state, anchorPaneId, side, binding));
  },

  openSessionInNewPane: (scope, sessionId) => {
    set((state) => openSessionInNewPane(state, scope, sessionId));
  },

  replacePaneBinding: (paneId, binding) => {
    set((state) => replacePaneBinding(state, paneId, binding));
  },

  closePane: (paneId) => {
    set((state) => closePane(state, paneId));
  },

  focusPane: (paneId) => {
    set((state) => focusPane(state, paneId));
  },

  bindPaneSession: (paneId, sessionId) => {
    set((state) => bindPaneSession(state, paneId, sessionId));
  },

  setSplitRatio: (splitId, ratio) => {
    set((state) => setSplitNodeRatio(state, splitId, ratio));
  },

  confirmRestoredPaneSession: (paneId) => {
    set((state) => confirmRestoredPaneSession(state, paneId));
  },

  resetToPrimaryPane: () => {
    set(INITIAL_PANE_LAYOUT);
  },
}));

// 布局变化即持久化（转移函数 no-op 保原引用时 zustand 不通知，无冗余写入）。
usePaneLayoutStore.subscribe((state) => {
  persistPaneLayout(state);
});
