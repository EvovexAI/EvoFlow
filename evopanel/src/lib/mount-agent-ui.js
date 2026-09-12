/**
 * Mount AgentAvatar / AgentAvatarPicker into vanilla JS pages.
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import AgentAvatar from '../react/components/AgentAvatar.tsx'
import AgentAvatarPicker from '../react/components/AgentAvatarPicker.tsx'

const roots = new WeakMap()

function getRoot(el) {
  let root = roots.get(el)
  if (!root) {
    root = createRoot(el)
    roots.set(el, root)
  }
  return root
}

export function mountAgentAvatar(el, props) {
  if (!el) return
  getRoot(el).render(createElement(AgentAvatar, props))
}

export function mountAgentAvatarPicker(el, props) {
  if (!el) return
  getRoot(el).render(createElement(AgentAvatarPicker, props))
}

export function unmountAgentUi(el) {
  const root = roots.get(el)
  if (root) {
    root.unmount()
    roots.delete(el)
  }
}
