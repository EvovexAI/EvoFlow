/**
 * Open an installed UI extension in the shared right-stage web-embed.
 * Extracted from ChatApp.tsx (P17).
 *
 * 冷启动契约（对齐 pages/ui-extension-shell.js）：
 * - **先开签，再起服务**。managed 扩展要 spawn `node server/index.js` / `python main.py`，
 *   冷启动 30~60s；若先 await ensureUiExtensionReady 再开签，用户在这段时间里
 *   什么都看不到，表现就是「点了没反应」。
 * - 服务就绪后再刷新一次 iframe（URL 加 cache-buster），把首屏失败的标签救回来。
 * - 起服务失败不关签：签里留着错误提示 + 重试入口，用户能看到发生了什么。
 */
import { flushSync } from 'react-dom'
import { rightStageStore } from '../../../lib/right-stage/right-stage-store.js'
import {
  RIGHT_STAGE_OVERLAY_DEFER_KEYS,
  resumeStreamBumpIfIdle,
  setRightStageOverlayDefer,
} from '../../../lib/right-stage/right-stage-overlay-commit.js'
import { toast } from '../../../components/toast.js'
import { toUserFacingError } from '../../../lib/user-facing-error.js'
import type { RightStageKind } from '../../../lib/right-stage/right-stage-types.js'

/** 每个 Agent 应用一个标签：同 kind 多签共存，id 按扩展 id 区分。 */
export function uiExtensionStageTabId(extensionId: string): string {
  return `uiext-${String(extensionId || '').trim()}`
}

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
    opts?: { title?: string; data?: Record<string, unknown>; id?: string; forceExpand?: boolean },
  ) => void
  setWorkspacePanelOpen: (open: boolean) => void
  setWorkspaceTreePinned: (pinned: boolean) => void
  setStreamingWritePreview: (v: null) => void
  setCollabExecPanelOpen: (open: boolean) => void
  setKnowledgeMapPanelOpen: (open: boolean) => void
}

/** 给 url 加 cache-buster，让已挂载的 iframe 重新拉一次（服务起好后刷新首屏）。 */
function withCacheBuster(url: string): string {
  const raw = String(url || '').trim()
  if (!raw) return raw
  const sep = raw.includes('?') ? '&' : '?'
  return `${raw}${sep}_evoflow_r=${Date.now()}`
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
    // 只关这一个应用的签：同 kind 可能并开多个 Agent 应用，不能整 kind 清场。
    rightStageStore.closeTab(`web-embed:${uiExtensionStageTabId(id)}`)
    ctx.syncShellAsideForWorkspacePanel(false)
    resumeStreamBumpIfIdle(() => ctx.scheduleBumpRef.current?.({ immediate: true }))
    return
  }

  void (async () => {
    try {
      const { ensureUiExtensionReady, getUiExtension, uiExtensionServiceStatus } = await import(
        '../../../lib/ui-extensions.js'
      )
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
      const entry = String(ui.entry || '').trim()
      if (!entry) {
        toast('Agent应用缺少入口地址（ui.entry）', 'error')
        return
      }
      const sandbox = Array.isArray(ui.sandbox)
        ? (ui.sandbox as unknown[]).map((s) => String(s || '').trim()).filter(Boolean)
        : ['allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-popups']

      const mode = String(
        (manifest.service && typeof manifest.service === 'object'
          ? (manifest.service as Record<string, unknown>).mode
          : '') || 'none',
      ).trim()

      // 服务是否已经在跑：在跑就不必显示「启动中」。
      let serviceReady = mode === 'none'
      if (!serviceReady) {
        const st = await uiExtensionServiceStatus(id).catch(() => null)
        serviceReady = st?.state === 'running' || st?.state === 'external' || st?.state === 'none'
      }

      // ---- 先开签：让用户立刻看到右栏有东西 ----
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
          id: uiExtensionStageTabId(id),
          title,
          forceExpand: true,
          data: {
            url: entry,
            editable: false,
            extensionId: id,
            extensionManifest: manifest,
            sandbox,
            titleLabel: title,
            ...(serviceReady ? {} : { serviceStarting: true, serviceHint: serviceHintFor(manifest) }),
          },
        })
      })

      if (serviceReady) return

      // ---- 服务冷启动：并行等，起好了刷新 iframe ----
      const ready = await ensureUiExtensionReady(id)
      const readyEntry = String(ready?.entry || '').trim() || entry
      // 用户可能已经关掉签、或切到别的应用了；只刷新仍属于本应用的签。
      const tabKey = `web-embed:${uiExtensionStageTabId(id)}`
      const live = rightStageStore.findTab(tabKey)
      if (!live) return
      rightStageStore.updateData(
        {
          url: withCacheBuster(readyEntry),
          serviceStarting: false,
          serviceReady: true,
        },
        { id: uiExtensionStageTabId(id) },
      )
    } catch (e) {
      const msg = toUserFacingError((e as Error)?.message || e)
      // 服务起不来：签留着（tab 里显示错误），另给一条提示。
      const tabKey = `web-embed:${uiExtensionStageTabId(id)}`
      if (rightStageStore.findTab(tabKey)) {
        rightStageStore.updateData(
          { serviceStarting: false, serviceError: msg },
          { id: uiExtensionStageTabId(id) },
        )
      }
      toast(msg, 'error', { force: true })
    }
  })()
}

/** manifest.service.hint：给用户看「怎么把服务跑起来」。 */
function serviceHintFor(manifest: Record<string, unknown>): string {
  const svc =
    manifest.service && typeof manifest.service === 'object'
      ? (manifest.service as Record<string, unknown>)
      : {}
  return String(svc.hint || '').trim()
}
