/**
 * 小V 调试区：挂载与主对话相同的 SessionDebugPane（模型调用记录）。
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { SessionDebugPane } from '../../react/components/SessionDebugPane.tsx'

/** @type {import('react-dom/client').Root | null} */
let _root = null
/** @type {HTMLElement | null} */
let _host = null

/**
 * @param {HTMLElement | null | undefined} host
 * @param {{ threadId?: string, isRunning?: boolean }} [props]
 */
export function mountXiaomiSessionDebug(host, props = {}) {
  if (!host) {
    unmountXiaomiSessionDebug()
    return
  }
  if (_host !== host) {
    try {
      _root?.unmount()
    } catch {
      /* ignore */
    }
    _root = createRoot(host)
    _host = host
  }
  _root.render(
    createElement(SessionDebugPane, {
      threadId: String(props.threadId || ''),
      isRunning: !!props.isRunning,
    }),
  )
}

export function unmountXiaomiSessionDebug() {
  try {
    _root?.unmount()
  } catch {
    /* ignore */
  }
  _root = null
  _host = null
}
