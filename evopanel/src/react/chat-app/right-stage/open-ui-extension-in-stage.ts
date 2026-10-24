/**
 * Open an installed UI extension in the shared right-stage web-embed.
 * Extracted from ChatApp.tsx (P17).
 */
import { flushSync } from 'react-dom'
import { hideRightStageIfKind, rightStageStore } from '../../../lib/right-stage/right-stage-store.js'
import {
  RIGHT_STAGE_OVERLAY_DEFER_KEYS,
  resumeStreamBumpIfIdle,
  setRightStageOverlayDefer,
} from '../../../lib/right-stage/right-stage-overlay-commit.js'
import { toast } from '../../../components/toast.js'
import { toUserFacingError } from '../../../lib/user-facing-error.js'
import type { RightStageKind } from '../../../lib/right-stage/right-stage-types.js'

export type OpenUiExtensionInStageCtx = {
  rightStageOpen: boolean
  rightStageUserPinnedRef: { current: RightStageKind | null }
  scheduleBumpRef: { current: ((opts?: { immediate?: boolean }) => void) | null }
  cancelPendingStreamUiBumpsRef: { current: () => void }
  lastStreamWritePathRef: { current: string | null }
  writeStreamDismissedRef: { current: boolean }
  syncShellAsideForWorkspacePanel: (open: boolean) => void
  showKind: (
    kind: RightStageKind,
    opts?: { title?: string; data?: Record<string, unknown> },
  ) => void
  setWorkspacePanelOpen: (open: boolean) => void
  setWorkspaceTreePinned: (pinned: boolean) => void
  setStreamingWritePreview: (v: null) => void
  setCollabExecPanelOpen: (open: boolean) => void
  setKnowledgeMapPanelOpen: (open: boolean) => void
}

export function openUiExtensionInStage(ctx: OpenUiExtensionInStageCtx, extensionId: string): void {
  const id = String(extensionId || '').trim()
  if (!id) return

  const surface = rightStageStore.getSnapshot().surface
  const currentExt = String(
    (surface?.data || {}).extensionId || (surface?.data || {}).extension_id || '',
  ).trim()
  if (surface?.kind === 'web-embed' && currentExt === id && ctx.rightStageOpen) {
    ctx.rightStageUserPinnedRef.current = null
    hideRightStageIfKind('web-embed')
    ctx.syncShellAsideForWorkspacePanel(false)
    resumeStreamBumpIfIdle(() => ctx.scheduleBumpRef.current?.({ immediate: true }))
    return
  }

  void (async () => {
    try {
      const { ensureUiExtensionReady, getUiExtension } = await import('../../../lib/ui-extensions.js')
      const rowRaw = await getUiExtension(id)
      const row = rowRaw && typeof rowRaw === 'object' ? (rowRaw as Record<string, unknown>) : null
      if (!row) {
        toast('Agent应用未安装', 'error')
        return
      }
      if (row.enabled === false) {
        toast('Agent应用已禁用，请先在Agent应用中心启用', 'warning')
        return
      }
      const manifest =
        row.manifest && typeof row.manifest === 'object'
          ? (row.manifest as Record<string, unknown>)
          : {}
      const ui =
        manifest.ui && typeof manifest.ui === 'object'
          ? (manifest.ui as Record<string, unknown>)
          : {}
      const nav =
        manifest.nav && typeof manifest.nav === 'object'
          ? (manifest.nav as Record<string, unknown>)
          : {}
      const title = String(nav.title || manifest.name || id).trim() || id
      let entry = String(ui.entry || '').trim()
      const ready = (await ensureUiExtensionReady(id)) as {
        entry?: string
        state?: string
      }
      if (ready?.entry) entry = String(ready.entry).trim() || entry
      if (!entry) {
        toast('Agent应用缺少入口地址（ui.entry）', 'error')
        return
      }
      const sandbox = Array.isArray(ui.sandbox)
        ? (ui.sandbox as unknown[]).map((s) => String(s || '').trim()).filter(Boolean)
        : ['allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-popups']
      ctx.cancelPendingStreamUiBumpsRef.current()
      setRightStageOverlayDefer(RIGHT_STAGE_OVERLAY_DEFER_KEYS, false)
      ctx.syncShellAsideForWorkspacePanel(true)
      flushSync(() => {
        ctx.setWorkspacePanelOpen(false)
        ctx.setWorkspaceTreePinned(false)
        ctx.setStreamingWritePreview(null)
        ctx.lastStreamWritePathRef.current = null
        ctx.setCollabExecPanelOpen(false)
        ctx.setKnowledgeMapPanelOpen(false)
        ctx.writeStreamDismissedRef.current = false
        ctx.rightStageUserPinnedRef.current = 'web-embed'
        ctx.showKind('web-embed', {
          title,
          data: {
            url: entry,
            editable: false,
            extensionId: id,
            extensionManifest: manifest,
            sandbox,
            titleLabel: title,
          },
        })
      })
    } catch (e) {
      toast(toUserFacingError((e as Error)?.message || e), 'error')
    }
  })()
}
