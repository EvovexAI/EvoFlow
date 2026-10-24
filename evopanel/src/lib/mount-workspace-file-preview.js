/**
 * Open workspace file preview from vanilla JS pages (task detail / employee work items).
 *
 * Chat 正式路径已迁到右栏 `file` 标签；这里统一走同一入口，避免再弹近全屏 modal。
 */
import { showRightStageFilePreview } from './right-stage/open-right-stage-file.js'
import { getCurrentRightStageSessionKey } from './right-stage/right-stage-scope.js'

/**
 * @param {{
 *   workspaceRoot: string
 *   path: string
 *   name?: string
 *   threadId?: string
 *   workspaceScopeOpts?: { configuredRoot?: string, useVirtualPaths?: boolean }
 *   onClose?: () => void
 * }} opts
 * @returns {() => void} close handle（右栏关闭由用户点标签；此处仅兼容旧调用方）
 */
export function openWorkspaceFilePreviewModal(opts) {
  const path = String(opts?.path || '').trim()
  if (!path) {
    throw new Error('path is required')
  }

  showRightStageFilePreview(path, {
    name: opts?.name || undefined,
    sessionKey: getCurrentRightStageSessionKey(),
  })

  return () => {
    try {
      opts?.onClose?.()
    } catch {
      /* ignore */
    }
  }
}
