/**
 * 任务详情页：仅挂载「查看计划」弹窗（工作流在独立 /workflow/:id 页面）。
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { TaskPlanModalBridge } from '../react/components/TaskPlanModalBridge.js'

/** @type {import('react-dom/client').Root | null} */
let root = null

/** @type {((opts?: { task?: Record<string, unknown> }) => void) | null} */
let openPlanModalFn = null

/**
 * @param {HTMLElement} mountEl
 * @param {{ taskId: string }} opts
 */
export function mountTaskPlanModalBridge(mountEl, { taskId }) {
  if (!mountEl) return
  if (!root) {
    root = createRoot(mountEl)
  }
  root.render(
    createElement(TaskPlanModalBridge, {
      taskId: String(taskId || '').trim(),
      onPlanModalReady: (fn) => {
        openPlanModalFn = fn
      },
    }),
  )
}

export function unmountTaskPlanModalBridge() {
  openPlanModalFn = null
  if (root) {
    root.unmount()
    root = null
  }
}

/** @deprecated 使用 mountTaskPlanModalBridge */
export const mountTaskDetailWorkbench = mountTaskPlanModalBridge

/** @deprecated 使用 unmountTaskPlanModalBridge */
export const unmountTaskDetailWorkbench = unmountTaskPlanModalBridge

/**
 * 打开与主对话相同的「查看计划」弹窗。
 * @param {{ task?: Record<string, unknown> }} [opts]
 */
export function openTaskPlanModal(opts = {}) {
  if (typeof openPlanModalFn === 'function') {
    openPlanModalFn(opts)
    return true
  }
  return false
}
