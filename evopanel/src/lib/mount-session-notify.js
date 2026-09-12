/**
 * Mount SessionNotificationCenter (React) into vanilla JS settings modal.
 * Pattern follows mount-agent-ui.js: WeakMap-managed createRoot lifecycle.
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { SessionNotificationCenter } from '../react/components/SessionNotificationCenter.tsx'

const roots = new WeakMap()

export function mountSessionNotify(el) {
  if (!el) return
  let root = roots.get(el)
  if (!root) {
    root = createRoot(el)
    roots.set(el, root)
  }
  root.render(createElement(SessionNotificationCenter))
}

export function unmountSessionNotify(el) {
  const root = roots.get(el)
  if (root) {
    root.unmount()
    roots.delete(el)
  }
}
