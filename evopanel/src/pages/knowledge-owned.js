/**
 * Owned knowledge base page entry.
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { setKnowledgeVaultDetailShellMode } from '../router.js'
import KnowledgeOwnedPage from './knowledge-owned.jsx'
import './knowledge-owned.css'
import '../style/ef-module-head.css'
import '../style/ef-panel-head.css'

let root = null

export async function render() {
  const wrap = document.createElement('div')
  wrap.className = 'page knowledge-owned-outlet'
  wrap.setAttribute('data-testid', 'knowledge-owned-page')

  const mount = document.createElement('div')
  mount.id = 'knowledge-owned-root'
  wrap.appendChild(mount)

  root = createRoot(mount)
  root.render(createElement(KnowledgeOwnedPage))
  void import('../lib/page-live-refresh.js').then(({ subscribePageLiveRefresh, softReloadCurrentRoute }) => {
    wrap._xmLiveUnsub = subscribePageLiveRefresh(() => softReloadCurrentRoute(), { domains: ['knowledge'] })
  })
  return wrap
}

export function cleanup() {
  setKnowledgeVaultDetailShellMode(false)
  try {
    document.querySelector('.knowledge-owned-outlet')?._xmLiveUnsub?.()
  } catch {
    /* ignore */
  }
  if (root) {
    root.unmount()
    root = null
  }
}
