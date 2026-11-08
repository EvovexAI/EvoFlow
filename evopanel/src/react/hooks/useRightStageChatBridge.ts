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
  const { surface, tabs } = stage
  const flags = useMemo(() => surfaceLegacyFlags(surface, tabs), [surface, tabs])

  const showKind = useCallback(
    (
      kind: RightStageKind,
      opts?: {
        title?: string
        data?: Record<string, unknown>
        /** 标签 id：同 kind 多签共存时区分（省略则用 'primary'）。 */
        id?: string
        /** 用户显式打开：清收起锁并撑开右栏。 */
        forceExpand?: boolean
      },
    ) => {
      rightStageStore.show({
        kind,
        title: opts?.title,
        data: opts?.data,
        ...(opts?.id ? { id: opts.id } : {}),
        ...(opts?.forceExpand ? { forceExpand: true } : {}),
      })
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
    if (stage.collapsed) return ''
    const parts = ['is-right-stage-open', 'is-right-panel-open']
    const kinds = new Set(tabs.map((t) => normalizeRightStageKind(t.kind)))
    if (kinds.has('workspace-browse') || kinds.has('write')) parts.push('is-workspace-open')
    if (kinds.has('artifacts')) parts.push('is-artifacts-open')
    if (kinds.has('collab-workflow')) parts.push('is-collab-exec-open')
    if (kinds.has('mind-map')) parts.push('is-knowledge-map-open')
    if (kinds.has('news-dashboard')) parts.push('is-news-dashboard-open')
    if (kinds.has('web-embed')) parts.push('is-web-embed-open')
    if (kinds.has('platform-feedback')) parts.push('is-platform-feedback-open')
    if (kinds.has('browser')) parts.push('is-browser-open')
    if (!tabs.length) parts.push('is-right-stage-home')
    return parts.join(' ')
  }, [stage.collapsed, tabs])

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
