/**
 * 小V 对话区：纯 V4（V4StreamRowsBridge → ConversationTimeline），与主对话同一显示管线。
 * threadId / 会话切换由组件内订阅，不必每帧 remount。
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { XiaomiChatThread } from '../../react/components/XiaomiChatThread.tsx'

/** @type {import('react-dom/client').Root | null} */
let _root = null
/** @type {HTMLElement | null} */
let _host = null
/** @type {string} */
let _lastSessionKey = ''

/**
 * @param {HTMLElement | null | undefined} host
 * @param {{ sessionKey?: string, force?: boolean }} [props]
 */
export function mountXiaomiChatThread(host, props = {}) {
  if (!host) {
    unmountXiaomiChatThread()
    return
  }
  const sessionKey = String(props.sessionKey || '')
  if (_host !== host) {
    try {
      _root?.unmount()
    } catch {
      /* ignore */
    }
    _root = createRoot(host)
    _host = host
    _lastSessionKey = ''
  }
  // GlobalAssistant 每帧 sync：sessionKey 未变则跳过 render，避免整栏抖。
  // 流式正文由组件内 subscribe(assistant-store) 驱动。
  if (!props.force && _lastSessionKey === sessionKey && _root) {
    return
  }
  _lastSessionKey = sessionKey
  _root.render(
    createElement(XiaomiChatThread, {
      sessionKey,
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
  _lastSessionKey = ''
}
