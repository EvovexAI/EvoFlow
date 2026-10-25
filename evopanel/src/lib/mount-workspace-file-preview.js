/**
 * Open workspace file preview from vanilla JS pages (task detail / employee work items).
 *
 * Chat 正式路径已迁到右栏 `file` 标签；这里统一走同一入口，避免再弹近全屏 modal。
 * 任务中心须显式传 `sessionKey: task-center:{taskId}`，否则标签会落到对话会话而被详情宿主滤掉（点预览无反应）。
 */
import { showRightStageFilePreview } from './right-stage/open-right-stage-file.js'
import { getCurrentRightStageSessionKey } from './right-stage/right-stage-scope.js'

/**
 * @param {{
 *   workspaceRoot: string
 *   path: string
 *   name?: string
 *   threadId?: string
 *   sessionKey?: string | null
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

  const sessionKey =
    String(opts?.sessionKey || '').trim() || getCurrentRightStageSessionKey() || undefined
  const workspaceRoot = String(opts?.workspaceRoot || '').trim() || undefined

  showRightStageFilePreview(path, {
    name: opts?.name || undefined,
    sessionKey,
    workspaceRoot,
  })

  return () => {
    try {
      opts?.onClose?.()
    } catch {
      /* ignore */
    }
  }
}
