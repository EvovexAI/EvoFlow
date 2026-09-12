/**
 * 任务详情「执行过程」内嵌员工上班轨迹。
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { ProactiveWorkProcessInline } from '../react/components/ProactiveWorkProcessInline.tsx'

/**
 * @param {HTMLElement} container
 */
export function mountProactiveWorkProcessInline(container) {
  const host = document.createElement('div')
  host.className = 'td-wp-inline-host'
  container.appendChild(host)
  const root = createRoot(host)

  /** @type {{
   *   agentCode: string
   *   roundId?: string
   *   taskId?: string
   *   taskName?: string
   *   pollMs?: number
   *   live?: boolean
   *   currentStep?: string
   *   onOpenHistory?: () => void
   * } | null} */
  let props = null

  function render() {
    if (!props?.agentCode) {
      root.render(null)
      return
    }
    root.render(
      createElement(ProactiveWorkProcessInline, {
        agentCode: props.agentCode,
        roundId: props.roundId || '',
        taskId: props.taskId || '',
        taskName: props.taskName || '',
        pollMs: props.pollMs,
        live: Boolean(props.live),
        currentStep: String(props.currentStep || '').trim(),
        onOpenHistory: props.onOpenHistory,
      }),
    )
  }

  return {
    /**
     * @param {{
     *   agentCode: string
     *   roundId?: string
     *   taskId?: string
     *   taskName?: string
     *   pollMs?: number
     *   live?: boolean
     *   currentStep?: string
     *   onOpenHistory?: () => void
     * }} next
     */
    update(next) {
      const agentCode = String(next?.agentCode || '').trim()
      if (!agentCode) {
        props = null
        render()
        return
      }
      props = {
        agentCode,
        roundId: String(next.roundId || '').trim(),
        taskId: String(next.taskId || '').trim(),
        taskName: String(next.taskName || '').trim(),
        pollMs: next.pollMs,
        live: Boolean(next.live),
        currentStep: String(next.currentStep || '').trim(),
        onOpenHistory: typeof next.onOpenHistory === 'function' ? next.onOpenHistory : undefined,
      }
      render()
    },
    destroy() {
      props = null
      try {
        root.unmount()
      } catch {
        /* ignore */
      }
      host.remove()
    },
  }
}
