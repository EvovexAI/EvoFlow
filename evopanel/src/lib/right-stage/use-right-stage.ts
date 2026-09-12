import { useCallback, useSyncExternalStore } from 'react'
import { rightStageStore } from './right-stage-store.js'
import { normalizeRightStageKind, type RightStageKind, type RightStageSurface } from './right-stage-types.js'

export function useRightStageStore() {
  const snapshot = useSyncExternalStore(
    useCallback((onStoreChange) => rightStageStore.subscribe(onStoreChange), []),
    () => rightStageStore.getSnapshot(),
    () => rightStageStore.getSnapshot(),
  )

  return {
    snapshot,
    surface: snapshot.surface,
    isOpen: snapshot.surface !== null,
    kind: snapshot.surface?.kind ?? null,
    show: rightStageStore.show.bind(rightStageStore),
    hide: rightStageStore.hide.bind(rightStageStore),
    updateData: rightStageStore.updateData.bind(rightStageStore),
    appendStream: rightStageStore.appendStream.bind(rightStageStore),
    openStream: rightStageStore.openStream.bind(rightStageStore),
    clearStream: rightStageStore.clearStream.bind(rightStageStore),
    closeStream: rightStageStore.closeStream.bind(rightStageStore),
    getStream: rightStageStore.getStream.bind(rightStageStore),
    applyRemote: rightStageStore.applyRemote.bind(rightStageStore),
  }
}

export function isWorkspaceKind(kind: RightStageKind | null | undefined): boolean {
  const k = normalizeRightStageKind(kind)
  return k === 'workspace-browse' || k === 'write'
}

export function surfaceLegacyFlags(surface: RightStageSurface | null) {
  if (!surface) {
    return {
      workspacePanelOpen: false,
      workspaceWrite: false,
      collabExecPanelOpen: false,
      knowledgeMapPanelOpen: false,
      newsDashboardOpen: false,
    }
  }
  const k = normalizeRightStageKind(surface.kind)
  return {
    workspacePanelOpen: k === 'workspace-browse' || k === 'write',
    workspaceWrite: k === 'write',
    collabExecPanelOpen: k === 'collab-workflow',
    knowledgeMapPanelOpen: k === 'mind-map',
    newsDashboardOpen: k === 'news-dashboard',
  }
}
