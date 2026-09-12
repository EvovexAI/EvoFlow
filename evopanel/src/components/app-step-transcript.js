/**
 * 应用编辑器：挂载与协作工作流同款的子任务会话弹窗。
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { AppStepTranscriptHost } from '../react/components/AppStepTranscriptHost.tsx'

/**
 * @param {HTMLElement} container
 */
export function mountAppStepTranscript(container) {
  const host = document.createElement('div')
  host.className = 'app-step-transcript-host'
  container.appendChild(host)

  const root = createRoot(host)
  /** @type {import('../react/components/AppStepTranscriptHost.tsx').AppStepTranscriptOpenRequest | null} */
  let request = null

  function render() {
    root.render(
      createElement(AppStepTranscriptHost, {
        request,
        onClose: () => {
          request = null
          render()
        },
      }),
    )
  }

  render()

  return {
    /**
     * @param {import('../react/components/AppStepTranscriptHost.tsx').AppStepTranscriptOpenRequest} next
     */
    open(next) {
      const mid = String(next?.mainTaskId || '').trim()
      const sid = String(next?.subtaskId || '').trim()
      const lead = String(next?.leadThreadId || '').trim()
      if (!mid || !sid) {
        throw new Error('缺少 task_id / subtask_id，无法打开节点会话')
      }
      request = {
        mainTaskId: mid,
        subtaskId: sid,
        leadThreadId: lead,
        title: next.title,
        status: next.status,
        assignedAgent: next.assignedAgent,
        description: next.description,
        subtaskThreadId: next.subtaskThreadId,
        mode: next.mode === 'drawer' ? 'drawer' : 'modal',
        portalTarget: next.portalTarget || null,
        readOnly: !!next.readOnly,
        refreshKey: next.refreshKey,
      }
      render()
    },
    close() {
      request = null
      render()
    },
    destroy() {
      request = null
      try {
        root.unmount()
      } catch {}
      host.remove()
    },
  }
}
