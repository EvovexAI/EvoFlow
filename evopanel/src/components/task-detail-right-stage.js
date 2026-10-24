/**
 * 任务详情页挂载 V4 右侧面板（工作流 + 节点进度 + 文件预览）。
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { TaskDetailRightStageHostWithTick } from '../react/components/TaskDetailRightStageHost.tsx'

/**
 * @param {HTMLElement} container
 * @param {{ taskId: string, threadId?: string, agents?: unknown[] }} initial
 */
export function mountTaskDetailRightStage(container, initial) {
  const host = document.createElement('div')
  host.className = 'td-right-stage-react-host'
  container.appendChild(host)
  const root = createRoot(host)

  /** @type {{ taskId: string, threadId: string, agents: unknown[], refreshKey: number }} */
  let props = {
    taskId: String(initial?.taskId || '').trim(),
    threadId: String(initial?.threadId || '').trim(),
    agents: Array.isArray(initial?.agents) ? initial.agents : [],
    refreshKey: 0,
  }

  function render() {
    if (!props.taskId) {
      root.render(null)
      return
    }
    root.render(
      createElement(TaskDetailRightStageHostWithTick, {
        taskId: props.taskId,
        threadId: props.threadId,
        agents: props.agents,
        refreshKey: props.refreshKey,
      }),
    )
  }

  render()

  return {
    /**
     * @param {{ taskId?: string, threadId?: string, agents?: unknown[], bump?: boolean }} next
     */
    update(next) {
      if (!next || typeof next !== 'object') return
      if (next.taskId != null) props.taskId = String(next.taskId || '').trim()
      if (next.threadId != null) props.threadId = String(next.threadId || '').trim()
      if (Array.isArray(next.agents)) props.agents = next.agents
      if (next.bump) props.refreshKey += 1
      render()
    },
    destroy() {
      try {
        root.unmount()
      } catch {
        /* ignore */
      }
      host.remove()
    },
  }
}
