/**
 * 设置 → 资源中心(获取资源 / 已装资源 / 打包分享)
 * 壳层:引导头部 + 带计数的分段导航;三个子面板各自挂载。
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
/** @type {'market' | 'installed' | 'mine'} */
let _panel = 'market'

const ICONS = {
  box: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>',
  compass: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36z"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>',
  share: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98m-.01-10.98-6.82 3.98"/></svg>',
}

function parsePanelFromHash() {
  const h = window.location.hash.slice(1) || ''
  const q = h.includes('?') ? h.split('?')[1] : ''
  const panel = new URLSearchParams(q).get('panel')
  if (panel === 'market' || panel === 'resource-market') return 'market'
  if (panel === 'installed' || panel === 'packs' || panel === 'installed-packs') return 'installed'
  if (panel === 'mine' || panel === 'my-resources') return 'mine'
  const tab = new URLSearchParams(q).get('tab')
  if (tab === 'resource-market') return 'market'
  // 默认落在「获取资源」,让新用户第一眼看到安装/导入入口
  return 'market'
}

function shellHtml() {
  const subtab = (panel, icon, label, hint) => `
    <button type="button" class="sr-subtab" role="tab" data-sr-panel="${panel}" aria-selected="false" title="${hint}">
      <span class="sr-subtab__icon">${icon}</span>
      <span>${label}</span>
      <span class="sr-subtab__count" data-sr-count="${panel}" hidden></span>
    </button>`
  return `
    <div class="sr-root sr-root--unified">
      <header class="sr-intro">
        <span class="sr-intro__icon">${ICONS.box}</span>
        <div class="sr-intro__text">
          <h2>资源中心</h2>
          <p>资源包 = 员工 + 工作流 + 技能的一键套装：从市场获取或导入本地包，装好即用；也能把本机资源打包分享给同事。</p>
        </div>
      </header>
      <div class="sr-subtabs" role="tablist" aria-label="资源分区">
        ${subtab('market', ICONS.compass, '获取资源', '从市场一键安装,或导入本地资源包')}
        ${subtab('installed', ICONS.check, '已装资源', '查看与管理已安装的资源包')}
        ${subtab('mine', ICONS.share, '打包分享', '勾选本机资源,打包导出给他人')}
      </div>
      <div class="sr-panel sr-panel--fill" data-sr-pane="market"></div>
      <div class="sr-panel sr-panel--fill" data-sr-pane="installed" hidden></div>
      <div class="sr-panel sr-panel--fill" data-sr-pane="mine" hidden></div>
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
  for (const id of ['market', 'installed', 'mine']) {
    const pane = _root.querySelector(`[data-sr-pane="${id}"]`)
    if (pane) pane.hidden = id !== _panel
  }
  if (sync) syncHash(_panel)
}

/** 子面板渲染完成后回报数量,显示在导航 badge 上 */
function onCount(e) {
  const detail = e.detail || {}
  const el = _root?.querySelector(`[data-sr-count="${detail.panel}"]`)
  if (!el) return
  const n = Number(detail.count ?? 0)
  el.hidden = !n
  el.textContent = n > 99 ? '99+' : String(n)
}

function onClick(e) {
  const t = e.target
  if (!(t instanceof Element)) return
  const btn = t.closest('[data-sr-panel]')
  if (!btn || !_root?.contains(btn)) return
  setPanel(btn.getAttribute('data-sr-panel') || 'market')
}

/**
 * @param {'market'|'installed'|'mine'} panel
 */
export function switchResourcesPanel(panel) {
  setPanel(panel, { sync: true })
}

/**
 * @param {HTMLElement} container
 * @param {{ initialPanel?: 'market'|'installed'|'mine' }} [opts]
 */
export async function mountResourcesInto(container, opts = {}) {
  cleanup()
  _root = container
  const initial = opts.initialPanel || parsePanelFromHash()
  container.innerHTML = shellHtml()
  container.addEventListener('click', onClick)
  container.addEventListener('sr-count', onCount)

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
    _root.removeEventListener('sr-count', onCount)
    _root = null
  }
  _panel = 'market'
}
