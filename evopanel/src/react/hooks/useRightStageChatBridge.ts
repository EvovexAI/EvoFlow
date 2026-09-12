import { useCallback, useMemo } from 'react'
import { rightStageLayoutToPanelKind } from '../../lib/right-stage/right-stage-layout.js'
import { hideRightStageIfKind, rightStageStore } from '../../lib/right-stage/right-stage-store.js'
import {
  defaultTitleForKind,
  normalizeRightStageKind,
  type RightStageKind,
  type RightStageSurface,
} from '../../lib/right-stage/right-stage-types.js'
import { surfaceLegacyFlags, useRightStageStore } from '../../lib/right-stage/use-right-stage.js'

export { hideRightStageIfKind } from '../../lib/right-stage/right-stage-store.js'

export function useRightStageChatBridge() {
  const stage = useRightStageStore()
  const { surface } = stage
  const flags = useMemo(() => surfaceLegacyFlags(surface), [surface])

  const showKind = useCallback(
    (kind: RightStageKind, opts?: { title?: string; data?: Record<string, unknown> }) => {
      rightStageStore.show({ kind, title: opts?.title, data: opts?.data })
    },
    [],
  )

  const setWorkspacePanelOpen = useCallback((open: boolean, opts?: { write?: boolean }) => {
    if (open) {
      const write = opts?.write === true
      rightStageStore.show({
        kind: write ? 'write' : 'workspace-browse',
        title: write ? defaultTitleForKind('write') : defaultTitleForKind('workspace-browse'),
        data: {},
      })
      return
    }
    hideRightStageIfKind('workspace-browse', 'write')
  }, [])

  const setCollabExecPanelOpen = useCallback((open: boolean) => {
    if (open) rightStageStore.show({ kind: 'collab-workflow', data: {} })
    else hideRightStageIfKind('collab-workflow')
  }, [])

  const setKnowledgeMapPanelOpen = useCallback((open: boolean) => {
    if (open) rightStageStore.show({ kind: 'mind-map', data: {} })
    else hideRightStageIfKind('mind-map')
  }, [])

  const openWriteStream = useCallback(
    (data: { path?: string; streamId?: string; format?: string; auto?: boolean }) => {
      const streamId = data.streamId || 'write_file'
      rightStageStore.openStream({
        streamId,
        format: (data.format as 'plain' | 'markdown' | 'code') || 'plain',
        path: data.path,
      })
      // 默认只灌流；必须显式 auto=true 才拉开侧栏
      if (data.auto !== true) return
      rightStageStore.show({
        kind: 'write',
        layout: 'workspace-write',
        title: defaultTitleForKind('write'),
        data: {
          streamId,
          path: data.path || '',
          format: data.format || 'plain',
        },
      })
    },
    [],
  )

  const openNewsDashboard = useCallback(() => {
    rightStageStore.show({ kind: 'news-dashboard', data: {} })
  }, [])

  const closeAll = useCallback(() => {
    rightStageStore.hide()
  }, [])

  const rightPanelLayoutKind = useMemo(() => {
    if (!surface) return 'half' as const
    return rightStageLayoutToPanelKind(surface.layout)
  }, [surface])

  const mainBodyStageClasses = useMemo(() => {
    if (!surface) return ''
    const parts = ['is-right-stage-open', 'is-right-panel-open']
    const k = normalizeRightStageKind(surface.kind)
    if (k === 'workspace-browse' || k === 'write') {
      parts.push('is-workspace-open')
    }
    if (k === 'artifacts') parts.push('is-artifacts-open')
    if (k === 'collab-workflow') parts.push('is-collab-exec-open')
    if (k === 'mind-map') parts.push('is-knowledge-map-open')
    if (k === 'news-dashboard') parts.push('is-news-dashboard-open')
    if (k === 'web-embed') parts.push('is-web-embed-open')
    if (k === 'platform-feedback') parts.push('is-platform-feedback-open')
    return parts.join(' ')
  }, [surface])

  return {
    ...stage,
    ...flags,
    workspacePanelOpen: flags.workspacePanelOpen,
    workspaceWriteOpen: flags.workspaceWrite,
    collabExecPanelOpen: flags.collabExecPanelOpen,
    knowledgeMapPanelOpen: flags.knowledgeMapPanelOpen,
    showKind,
    openWriteStream,
    openNewsDashboard,
    closeAll,
    rightPanelLayoutKind,
    mainBodyStageClasses,
    surface: surface as RightStageSurface | null,
    setWorkspacePanelOpen,
    setCollabExecPanelOpen,
    setKnowledgeMapPanelOpen,
  }
}
