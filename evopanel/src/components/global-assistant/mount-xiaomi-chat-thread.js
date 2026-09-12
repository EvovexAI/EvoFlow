/**
 * 小V 对话区：挂载与主对话相同的 MessageRow（Markdown / 思考 / 工具过程 / 最终回复）。
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { XiaomiChatThread } from '../../react/components/XiaomiChatThread.tsx'

/** @type {import('react-dom/client').Root | null} */
let _root = null
/** @type {HTMLElement | null} */
let _host = null

/**
 * @param {HTMLElement | null | undefined} host
 * @param {{ sessionKey?: string }} [props]
 */
export function mountXiaomiChatThread(host, props = {}) {
  if (!host) {
    unmountXiaomiChatThread()
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
    createElement(XiaomiChatThread, {
      sessionKey: String(props.sessionKey || ''),
    }),
  )
}

export function unmountXiaomiChatThread() {
  try {
    _root?.unmount()
  } catch {
    /* ignore */
  }
  _root = null
  _host = null
}
