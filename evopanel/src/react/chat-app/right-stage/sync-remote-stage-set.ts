/**
 * Apply STAGE_SET_APPLIED remote payload to local right-stage / artifacts state.
 * Extracted from ChatApp.tsx (P19).
 */
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { hideRightStageIfKind } from '../../../lib/right-stage/right-stage-store.js'
import type { StageSetPayload } from '../../../lib/right-stage/right-stage-agui.js'
import type { RightStageKind, RightStageLayout } from '../../../lib/right-stage/right-stage-types.js'
import { showRightStageFilePreview } from '../../../lib/right-stage/open-right-stage-file.js'
import { getCurrentRightStageSessionKey } from '../../../lib/right-stage/right-stage-scope.js'
import {
  clearAllRightStageOverlayDefer,
  resumeStreamBumpIfIdle,
  setRightStageOverlayDefer,
} from '../../../lib/right-stage/right-stage-overlay-commit.js'
import {
  mergeChatArtifacts,
  normalizeChatArtifacts,
  type ChatArtifact,
} from '../../lib/chat-artifact.js'
import { logPanelSet } from '../../../lib/right-stage/panel-set-debug-log.js'

export type SyncRemoteStageSetCtx = {
  rightStageUserPinnedRef: { current: RightStageKind | null }
  scheduleBumpRef: { current: ((opts?: { immediate?: boolean }) => void) | null }
  cancelPendingStreamUiBumpsRef: { current: () => void }
  lastStreamWritePathRef: { current: string | null }
  turnRunArtifactsRef: MutableRefObject<ChatArtifact[]>
  setSessionArtifactsRef: MutableRefObject<
    Dispatch<SetStateAction<ChatArtifact[]>>
  >
  publishArtifactsRef: MutableRefObject<
    (opts?: { focusId?: string; hint?: string; force?: boolean }) => void
  >
  syncShellAsideForWorkspacePanel: (open: boolean) => void
  setStreamingWritePreview: (v: null) => void
  setWorkspaceTreePinned: (pinned: boolean) => void
  setKnowledgeMapRefreshKey: Dispatch<SetStateAction<number>>
}

function coerceFileLayout(raw: unknown): RightStageLayout | undefined {
  const v = String(raw || '').trim()
  if (v === 'half' || v === 'wide' || v === 'narrow' || v === 'workspace-write') return v
  return undefined
}

function pickFocusArtifact(
  incoming: ChatArtifact[],
  data: Record<string, unknown>,
): ChatArtifact | null {
  const withPath = incoming.filter(
    (it) => it.type !== 'platform' && String(it.path || '').trim(),
  )
  if (!withPath.length) return null
  const focusId = String(data.focusId || '').trim()
  const focusPath = String(data.focusPath || '').trim().replace(/\\/g, '/')
  if (focusId) {
    const byId = withPath.find((it) => it.id === focusId)
    if (byId) return byId
  }
  if (focusPath) {
    const byPath = withPath.find((it) => String(it.path || '').replace(/\\/g, '/') === focusPath)
    if (byPath) return byPath
  }
  return withPath[withPath.length - 1] || null
}

export function syncRemoteStageSet(ctx: SyncRemoteStageSetCtx, detail: StageSetPayload): void {
  const kind = String(detail.surface?.kind || '').trim()
  logPanelSet('② syncRemoteStageSet 收到 STAGE_SET_APPLIED', {
    action: detail.action,
    kind: kind || '(空)',
    title: detail.surface?.title,
    layout: detail.surface?.layout,
  })
  if (detail.action === 'hide' || !kind) {
    logPanelSet('② 动作=hide 或 kind 空，收起侧栏相关状态')
    ctx.rightStageUserPinnedRef.current = null
    clearAllRightStageOverlayDefer()
    ctx.syncShellAsideForWorkspacePanel(false)
    resumeStreamBumpIfIdle(() => ctx.scheduleBumpRef.current?.({ immediate: true }))
    return
  }
  // 产物列表仍进状态卡数据；显式 panel_set 若带本地 path，再打开右侧「文件」预览看内容。
  // （Right Stage 不再挂 artifacts 标签——store.show 会拒收。）
  if (kind === 'artifacts') {
    hideRightStageIfKind('artifacts')
    const data = (detail.surface?.data || {}) as Record<string, unknown>
    const incoming = normalizeChatArtifacts(data.items)
    logPanelSet('② artifacts 分支：规范化 items', {
      rawItemsType: Array.isArray(data.items) ? 'array' : typeof data.items,
      incomingCount: incoming.length,
      paths: incoming.map((it) => it.path || it.url || '(无路径)'),
    })
    if (incoming.length) {
      ctx.turnRunArtifactsRef.current = mergeChatArtifacts(ctx.turnRunArtifactsRef.current, incoming)
      ctx.setSessionArtifactsRef.current((prev) => mergeChatArtifacts(prev, incoming))
      const focusId = String(data.focusId || incoming[incoming.length - 1]?.id || '')
      const focusFile = pickFocusArtifact(incoming, data)
      const titleHint = String(detail.surface?.title || '').trim() || undefined
      if (focusFile?.path) {
        const sk =
          String(detail.surface?.sessionKey || '').trim() ||
          getCurrentRightStageSessionKey() ||
          undefined
        const layout = coerceFileLayout(detail.surface?.layout) || 'half'
        logPanelSet('② 有本地 path → 调用 showRightStageFilePreview', {
          path: focusFile.path,
          name: focusFile.name || focusFile.label,
          sessionKey: sk || '(空)',
          layout,
        })
        // 先落列表（不 force 开状态卡，避免 collapseRightStage 打掉刚开的文件签）
        ctx.publishArtifactsRef.current({
          focusId,
          force: false,
        })
        const tabKey = showRightStageFilePreview(String(focusFile.path).trim(), {
          name: String(focusFile.name || focusFile.label || '').trim() || undefined,
          sessionKey: sk,
          layout,
        })
        logPanelSet('② showRightStageFilePreview 已返回', { tabKey })
        ctx.rightStageUserPinnedRef.current = 'file'
        ctx.scheduleBumpRef.current?.({ immediate: true })
      } else {
        logPanelSet('② 无本地 path → force 打开状态卡产物 tab', { focusId, titleHint })
        // 无本地 path（纯 url/文案）：仍 force 打开状态卡产物 tab
        ctx.publishArtifactsRef.current({
          focusId,
          force: true,
          hint: titleHint,
        })
      }
    } else {
      logPanelSet('② artifacts items 为空，什么都没打开')
    }
    return
  }
  logPanelSet('② 非 artifacts：钉住 kind 并 bump', { kind })
  ctx.cancelPendingStreamUiBumpsRef.current()
  ctx.rightStageUserPinnedRef.current = kind as RightStageKind
  clearAllRightStageOverlayDefer()
  setRightStageOverlayDefer('workspace', kind === 'workspace-browse' || kind === 'write')
  setRightStageOverlayDefer('knowledge-map', kind === 'mind-map')
  if (kind !== 'write') {
    ctx.setStreamingWritePreview(null)
    ctx.lastStreamWritePathRef.current = null
  }
  ctx.setWorkspaceTreePinned(kind === 'workspace-browse')
  if (kind === 'mind-map') {
    ctx.setKnowledgeMapRefreshKey((k) => k + 1)
  }
  if (kind === 'news-dashboard' || kind === 'web-embed') {
    ctx.syncShellAsideForWorkspacePanel(true)
  }
  ctx.scheduleBumpRef.current?.({ immediate: true })
}
