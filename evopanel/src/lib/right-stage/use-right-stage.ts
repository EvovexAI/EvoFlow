import { useCallback, useSyncExternalStore } from 'react'
import { rightStageStore } from './right-stage-store.js'
import { normalizeRightStageKind, type RightStageKind, type RightStageSurface } from './right-stage-types.js'

/**
 * 模块级 bind：useRightStageStore 每次订阅 bump 都会重渲染，若在 render 里
 * `.bind(store)` 会得到新函数引用。ChatApp「首页收栏」effect 依赖 collapse
 * 时，任务中心 show() 一展开就会被立刻 collapse（表现为执行过程点击无反应）。
 */
const rightStageActions = {
  show: rightStageStore.show.bind(rightStageStore),
  hide: rightStageStore.hide.bind(rightStageStore),
  closeTab: rightStageStore.closeTab.bind(rightStageStore),
  activateTab: rightStageStore.activateTab.bind(rightStageStore),
  reopenClosedTab: rightStageStore.reopenClosedTab.bind(rightStageStore),
  reorderTab: rightStageStore.reorderTab.bind(rightStageStore),
  expand: rightStageStore.expand.bind(rightStageStore),
  collapse: rightStageStore.collapse.bind(rightStageStore),
  toggleCollapsed: rightStageStore.toggleCollapsed.bind(rightStageStore),
  updateData: rightStageStore.updateData.bind(rightStageStore),
  appendStream: rightStageStore.appendStream.bind(rightStageStore),
  openStream: rightStageStore.openStream.bind(rightStageStore),
  clearStream: rightStageStore.clearStream.bind(rightStageStore),
  closeStream: rightStageStore.closeStream.bind(rightStageStore),
  getStream: rightStageStore.getStream.bind(rightStageStore),
  applyRemote: rightStageStore.applyRemote.bind(rightStageStore),
}

export function useRightStageStore() {
  const snapshot = useSyncExternalStore(
    useCallback((onStoreChange) => rightStageStore.subscribe(onStoreChange), []),
    () => rightStageStore.getSnapshot(),
    () => rightStageStore.getSnapshot(),
  )

  return {
    snapshot,
    surface: snapshot.surface,
    /** 侧栏是否占宽：折叠态与 tabs 脱钩（空 tabs 也可展开显示首页）。 */
    isOpen: !snapshot.collapsed,
    collapsed: snapshot.collapsed,
    kind: snapshot.surface?.kind ?? null,
    tabs: snapshot.tabs,
    activeKey: snapshot.activeKey,
    recentClosed: snapshot.recentClosed,
    ...rightStageActions,
  }
}

export function isWorkspaceKind(kind: RightStageKind | null | undefined): boolean {
  const k = normalizeRightStageKind(kind)
  return k === 'workspace-browse' || k === 'write'
}

/**
 * 「打开」= tabs 列表里存在该 kind（可与激活项不同）。
 * 切到浏览器时文件树仍在列表里，不能被当成已关闭而拆掉状态。
 */
export function surfaceLegacyFlags(
  surface: RightStageSurface | null,
  tabs?: readonly RightStageSurface[] | null,
) {
  const kindSet = new Set(
    (tabs && tabs.length
      ? tabs
      : surface
        ? [surface]
        : []
    ).map((t) => normalizeRightStageKind(t.kind)),
  )
  return {
    workspacePanelOpen: kindSet.has('workspace-browse') || kindSet.has('write'),
    workspaceWrite: kindSet.has('write'),
    collabExecPanelOpen: kindSet.has('collab-workflow'),
    knowledgeMapPanelOpen: kindSet.has('mind-map'),
    newsDashboardOpen: kindSet.has('news-dashboard'),
  }
}
