/**
 * Mount MemoryGraphPanel into vanilla memory.js page.
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import MemoryGraphPanel from '../react/components/MemoryGraphPanel.jsx'

const roots = new WeakMap()

function getRoot(el) {
  let root = roots.get(el)
  if (!root) {
    root = createRoot(el)
    roots.set(el, root)
  }
  return root
}

export function mountMemoryGraphPanel(el, props) {
  if (!el) return
  getRoot(el).render(createElement(MemoryGraphPanel, props || {}))
}

export function unmountMemoryGraphPanel(el) {
  const root = roots.get(el)
  if (root) {
    root.unmount()
    roots.delete(el)
  }
}
