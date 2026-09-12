/**
 * 路由动态导入入口使用 .js（避免 Vite dev 下直接请求 *.tsx 偶发 Failed to fetch）。
 * 实时聊天 UI 与类型均在 ../react/*.tsx。
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import ChatApp from '../react/ChatApp.js'

let root = null

export async function render() {
  const wrap = document.createElement('div')
  wrap.className = 'page chat-page chat-react-outlet'
  const mount = document.createElement('div')
  mount.id = 'react-chat-root'
  wrap.appendChild(mount)
  root = createRoot(mount)
  root.render(createElement(ChatApp))
  return wrap
}

export function cleanup() {
  if (root) {
    root.unmount()
    root = null
  }
}
