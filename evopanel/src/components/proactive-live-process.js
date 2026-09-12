/**
 * 智能体员工「工作过程」：挂载与主对话工作流/子任务同款居中历史弹窗。
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { ProactiveLiveProcessHost } from '../react/components/ProactiveLiveProcessHost.tsx'

/**
 * @param {HTMLElement} [container] 可选挂载点；默认挂到 document.body
 */
export function mountProactiveLiveProcess(container) {
  const host = document.createElement('div')
  host.className = 'pro-live-process-host'
  const parent = container || document.body
  parent.appendChild(host)

  const root = createRoot(host)
  /** @type {{
   *   open: boolean
   *   agentCode: string
   *   roleName?: string
   *   busy?: boolean
   *   title?: string
   *   roundId?: string
   *   taskId?: string
   *   pollMs?: number
   * } | null} */
  let state = null
  /** @type {(() => void) | null} */
  let onClosed = null

  function render() {
    if (!state?.open || !state.agentCode) {
      root.render(null)
      return
    }
    root.render(
      createElement(ProactiveLiveProcessHost, {
        open: true,
        agentCode: state.agentCode,
        roleName: state.roleName || '',
        busy: !!state.busy,
        title: state.title,
        roundId: state.roundId || '',
        taskId: state.taskId || '',
        pollMs: state.pollMs,
        onClose: () => {
          state = state ? { ...state, open: false } : null
          render()
          try {
            onClosed?.()
          } catch {
            /* ignore */
          }
          host.dispatchEvent(new CustomEvent('pro-live-close', { bubbles: true }))
        },
      }),
    )
  }

  return {
    /**
     * @param {{
     *   agentCode: string
     *   roleName?: string
     *   busy?: boolean
     *   title?: string
     *   roundId?: string
     *   taskId?: string
     *   pollMs?: number
     *   onClosed?: () => void
     * }} next
     */
    open(next) {
      const agentCode = String(next?.agentCode || '').trim()
      if (!agentCode) throw new Error('缺少 agentCode')
      onClosed = typeof next.onClosed === 'function' ? next.onClosed : null
      state = {
        open: true,
        agentCode,
        roleName: next.roleName,
        busy: !!next.busy,
        title: next.title,
        roundId: String(next.roundId || '').trim() || undefined,
        taskId: String(next.taskId || '').trim() || undefined,
        pollMs: next.pollMs,
      }
      render()
    },
    /** @param {boolean} busy */
    setBusy(busy) {
      if (!state?.open) return
      state = { ...state, busy: !!busy }
      render()
    },
    /**
     * Patch open drawer (e.g. follow ``current_round_id`` while busy).
     * @param {{ busy?: boolean, title?: string, roundId?: string | null, taskId?: string | null }} patch
     */
    update(patch) {
      if (!state?.open || !patch || typeof patch !== 'object') return
      const next = { ...state }
      if ('busy' in patch) next.busy = !!patch.busy
      if ('title' in patch && patch.title != null) next.title = String(patch.title)
      if ('roundId' in patch) {
        const rid = String(patch.roundId || '').trim()
        next.roundId = rid || undefined
      }
      if ('taskId' in patch) {
        const tid = String(patch.taskId || '').trim()
        next.taskId = tid || undefined
      }
      state = next
      render()
    },
    currentRoundId() {
      return state?.open ? String(state.roundId || '').trim() : ''
    },
    close() {
      if (!state) return
      state = { ...state, open: false }
      render()
    },
    isOpen() {
      return !!(state?.open && state.agentCode)
    },
    currentCode() {
      return state?.open ? String(state.agentCode || '') : ''
    },
    destroy() {
      state = null
      onClosed = null
      try {
        root.unmount()
      } catch {
        /* ignore */
      }
      host.remove()
    },
  }
}
