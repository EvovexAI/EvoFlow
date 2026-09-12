/**
 * 设置 → 资源（我的清单 + 已装资源包 + 市场）
 */
import '../../style/settings-resources.css'
import { mountMyResourcesInto, cleanup as cleanupMine } from './my-resources.js'
import {
  mountInstalledPacksInto,
  cleanup as cleanupInstalled,
} from './installed-packs.js'
import {
  mountResourceMarketInto,
  cleanup as cleanupMarket,
} from './resource-market.js'

/** @type {HTMLElement | null} */
let _root = null
/** @type {'mine' | 'installed' | 'market'} */
let _panel = 'mine'

function parsePanelFromHash() {
  const h = window.location.hash.slice(1) || ''
  const q = h.includes('?') ? h.split('?')[1] : ''
  const panel = new URLSearchParams(q).get('panel')
  if (panel === 'market' || panel === 'resource-market') return 'market'
  if (panel === 'installed' || panel === 'packs' || panel === 'installed-packs') return 'installed'
  if (panel === 'mine' || panel === 'my-resources') return 'mine'
  const tab = new URLSearchParams(q).get('tab')
  if (tab === 'resource-market') return 'market'
  return 'mine'
}

function shellHtml() {
  return `
    <div class="sr-root sr-root--unified">
      <div class="sr-subtabs" role="tablist" aria-label="资源分区">
        <button type="button" class="sr-subtab" role="tab" data-sr-panel="mine" aria-selected="true">我的</button>
        <button type="button" class="sr-subtab" role="tab" data-sr-panel="installed" aria-selected="false">已装</button>
        <button type="button" class="sr-subtab" role="tab" data-sr-panel="market" aria-selected="false">市场</button>
      </div>
      <div class="sr-panel sr-panel--fill" data-sr-pane="mine"></div>
      <div class="sr-panel sr-panel--fill" data-sr-pane="installed" hidden></div>
      <div class="sr-panel sr-panel--fill" data-sr-pane="market" hidden></div>
    </div>
  `
}

function syncHash(panel) {
  const params = new URLSearchParams()
  params.set('tab', 'resources')
  if (panel === 'market') params.set('panel', 'market')
  else if (panel === 'installed') params.set('panel', 'installed')
  window.history.replaceState(null, '', `#/settings?${params.toString()}`)
}

function normalizePanel(panel) {
  if (panel === 'market') return 'market'
  if (panel === 'installed' || panel === 'packs') return 'installed'
  return 'mine'
}

function setPanel(panel, { sync = true } = {}) {
  _panel = normalizePanel(panel)
  if (!_root) return
  _root.querySelectorAll('[data-sr-panel]').forEach((btn) => {
    const on = btn.getAttribute('data-sr-panel') === _panel
    btn.classList.toggle('is-active', on)
    btn.setAttribute('aria-selected', on ? 'true' : 'false')
  })
  for (const id of ['mine', 'installed', 'market']) {
    const pane = _root.querySelector(`[data-sr-pane="${id}"]`)
    if (pane) pane.hidden = id !== _panel
  }
  if (sync) syncHash(_panel)
}

function onClick(e) {
  const t = e.target
  if (!(t instanceof Element)) return
  const btn = t.closest('[data-sr-panel]')
  if (!btn || !_root?.contains(btn)) return
  setPanel(btn.getAttribute('data-sr-panel') || 'mine')
}

/**
 * @param {'mine'|'installed'|'market'} panel
 */
export function switchResourcesPanel(panel) {
  setPanel(panel, { sync: true })
}

/**
 * @param {HTMLElement} container
 * @param {{ initialPanel?: 'mine'|'installed'|'market' }} [opts]
 */
export async function mountResourcesInto(container, opts = {}) {
  cleanup()
  _root = container
  const initial = opts.initialPanel || parsePanelFromHash()
  container.innerHTML = shellHtml()
  container.addEventListener('click', onClick)

  const minePane = container.querySelector('[data-sr-pane="mine"]')
  const installedPane = container.querySelector('[data-sr-pane="installed"]')
  const marketPane = container.querySelector('[data-sr-pane="market"]')
  if (minePane instanceof HTMLElement) {
    await mountMyResourcesInto(minePane, { embedded: true })
  }
  if (installedPane instanceof HTMLElement) {
    await mountInstalledPacksInto(installedPane, { embedded: true })
  }
  if (marketPane instanceof HTMLElement) {
    await mountResourceMarketInto(marketPane, { embedded: true })
  }
  setPanel(initial, { sync: true })
}

export function cleanup() {
  cleanupMine()
  cleanupInstalled()
  cleanupMarket()
  if (_root) {
    _root.removeEventListener('click', onClick)
    _root = null
  }
  _panel = 'mine'
}
