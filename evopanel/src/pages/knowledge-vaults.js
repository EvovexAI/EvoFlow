/**
 * 路由动态导入入口使用 .js（与 chat-react 相同）。
 * UI 实现在 knowledge-vaults.jsx（design package）。
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { setKnowledgeVaultDetailShellMode } from '../router.js'
import KnowledgeVaultsPage from './knowledge-vaults.jsx'

let root = null

export async function render() {
  const wrap = document.createElement('div')
  wrap.className = 'page knowledge-vaults-outlet'
  wrap.setAttribute('data-testid', 'knowledge-vaults-page')

  const mount = document.createElement('div')
  mount.id = 'knowledge-vaults-root'
  wrap.appendChild(mount)

  root = createRoot(mount)
  root.render(createElement(KnowledgeVaultsPage))
  return wrap
}

export function cleanup() {
  setKnowledgeVaultDetailShellMode(false)
  if (root) {
    root.unmount()
    root = null
  }
}
