/**
 * 设置弹窗内布局：左侧分类 + 右侧多面板（各 Tab 独立 DOM，切换只改显隐，避免高度闪动）
 */
import {
  NAV_GROUPS,
  NAV_ICONS,
  NAV_LABELS,
  TAB_META,
  parseTabFromLocation,
  visibleSettingsTabs,
} from './meta.js'

const _panelMounted = new Set()
/** @type {Map<string, () => void>} */
const _tabCleanups = new Map()
/** @type {Map<string, Promise<void>>} */
const _mountInflight = new Map()

function settingsHubHtml() {
  const visible = new Set(visibleSettingsTabs())
  const groupBlocks = NAV_GROUPS.map((group) => {
    const tabs = group.tabs.filter((t) => visible.has(t))
    if (!tabs.length) return ''
    const buttons = tabs
      .map((tab) => {
        const label = NAV_LABELS[tab] ?? TAB_META[tab]?.title ?? tab
        const active = tab === 'general' ? ' settings-nav-item--active' : ''
        const id = tab === 'general' ? ' id="settings-tab-general"' : ''
        return `
        <button type="button" class="settings-nav-item${active}" data-settings-tab="${tab}"${id} role="tab" aria-selected="${tab === 'general' ? 'true' : 'false'}">
          <span class="settings-nav-ic" aria-hidden="true">${NAV_ICONS[tab] ?? ''}</span>
          <span>${label}</span>
        </button>`
      })
      .join('')
    return `
      <div class="settings-nav-group" data-nav-group="${group.id}">
        <div class="settings-nav-group-title">${group.title}</div>
        ${buttons}
      </div>`
  }).join('')

  const panels = visibleSettingsTabs()
    .map((tab) => {
      const active = tab === 'general'
      return `
      <div class="settings-subview settings-subview-panel" data-settings-panel="${tab}" role="tabpanel" id="settings-panel-wrap-${tab}" ${active ? '' : 'hidden'} aria-hidden="${active ? 'false' : 'true'}">
        <div class="settings-subview-panel-inner" id="settings-panel-inner-${tab}"></div>
      </div>`
    })
    .join('')

  return `
    <div class="settings-layout settings-layout--hub settings-layout--modal-hub">
      <nav class="settings-nav" aria-label="设置导航" role="tablist">
        <button type="button" class="settings-nav-back" data-settings-back>
          <span aria-hidden="true">←</span>
          <span>返回工作区</span>
        </button>
        ${groupBlocks}
      </nav>
      <div class="settings-hub-main">
        <div class="settings-subview-stack">
          ${panels}
        </div>
      </div>
    </div>
  `
}

function setNavActive(rootEl, tab) {
  rootEl.querySelectorAll('[data-settings-tab]').forEach((btn) => {
    const on = btn.dataset.settingsTab === tab
    btn.classList.toggle('settings-nav-item--active', on)
    btn.setAttribute('aria-selected', on ? 'true' : 'false')
  })
}

function setPanelVisible(rootEl, tab) {
  rootEl.querySelectorAll('[data-settings-panel]').forEach((panel) => {
    const on = panel.dataset.settingsPanel === tab
    panel.toggleAttribute('hidden', !on)
    panel.setAttribute('aria-hidden', on ? 'false' : 'true')
  })
}

function runTabCleanups() {
  for (const fn of _tabCleanups.values()) {
    try {
      fn()
    } catch {
      /* ignore */
    }
  }
  _tabCleanups.clear()
  _panelMounted.clear()
  _mountInflight.clear()
}

/**
 * @param {HTMLElement} rootEl
 * @param {string} tab
 */
async function ensurePanelMounted(rootEl, tab) {
  // Security center always remounts: OS sandbox toggle must re-fetch SQLite-backed status.
  if (tab === 'security' && _panelMounted.has('security')) {
    const cleanup = _tabCleanups.get('security')
    if (typeof cleanup === 'function') {
      try {
        cleanup()
      } catch {
        /* ignore */
      }
    }
    _tabCleanups.delete('security')
    _panelMounted.delete('security')
    const inner = rootEl.querySelector('#settings-panel-inner-security')
    if (inner) inner.replaceChildren()
  }

  if (_panelMounted.has(tab)) return
  if (_mountInflight.has(tab)) {
    await _mountInflight.get(tab)
    return
  }

  const inner = rootEl.querySelector(`#settings-panel-inner-${tab}`)
  if (!inner) return

  const work = (async () => {
    inner.replaceChildren()

    try {
      switch (tab) {
        case 'general': {
          const g = await import('../general.js')
          if (!inner.isConnected) return
          const pane = document.createElement('div')
          pane.className = 'settings-modal-pane settings-modal-pane--general settings-embed-wrap'
          inner.appendChild(pane)
          await g.mountGeneralInto(pane)
          _tabCleanups.set('general', () => g.cleanup())
          break
        }
        case 'models': {
          const mod = await import('../models.js')
          if (!inner.isConnected) return
          await mod.mountModelsForSettingsModal(inner)
          _tabCleanups.set('models', () => mod.cleanup())
          break
        }
        case 'search': {
          const mod = await import('./web-search.js')
          if (!inner.isConnected) return
          const pane = document.createElement('div')
          pane.className = 'settings-modal-pane settings-modal-pane--search settings-embed-wrap'
          inner.appendChild(pane)
          await mod.mountWebSearchInto(pane)
          _tabCleanups.set('search', () => mod.cleanup())
          break
        }
        case 'im': {
          const mod = await import('../channels.js')
          if (!inner.isConnected) return
          mod.mountChannelsForSettingsModal(inner)
          _tabCleanups.set('im', () => mod.cleanup?.())
          break
        }
        case 'shortcuts': {
          const mod = await import('./shortcuts.js')
          if (!inner.isConnected) return
          const pane = document.createElement('div')
          pane.className = 'settings-modal-pane settings-modal-pane--shortcuts settings-embed-wrap'
          inner.appendChild(pane)
          await mod.mountShortcutsInto(pane)
          _tabCleanups.set('shortcuts', () => mod.cleanup())
          break
        }
        case 'usage': {
          const mod = await import('./usage.js')
          if (!inner.isConnected) return
          const pane = document.createElement('div')
          pane.className = 'settings-modal-pane settings-modal-pane--usage settings-embed-wrap'
          inner.appendChild(pane)
          await mod.mountUsageInto(pane)
          _tabCleanups.set('usage', () => mod.cleanup())
          break
        }
        case 'resources': {
          const mod = await import('./resources.js')
          if (!inner.isConnected) return
          const pane = document.createElement('div')
          pane.className = 'settings-modal-pane settings-modal-pane--resources settings-embed-wrap'
          inner.appendChild(pane)
          await mod.mountResourcesInto(pane)
          _tabCleanups.set('resources', () => mod.cleanup())
          break
        }
        case 'code-index': {
          const mod = await import('./code-index.js')
          if (!inner.isConnected) return
          const pane = document.createElement('div')
          pane.className = 'settings-modal-pane settings-modal-pane--code-index settings-embed-wrap'
          inner.appendChild(pane)
          await mod.mountCodeIndexInto(pane)
          _tabCleanups.set('code-index', () => mod.cleanup())
          break
        }
        case 'about': {
          const mod = await import('../about.js')
          if (!inner.isConnected) return
          const pane = document.createElement('div')
          pane.className = 'settings-modal-pane settings-modal-pane--about settings-embed-wrap'
          inner.appendChild(pane)
          mod.mountAboutInto(pane)
          _tabCleanups.set('about', () => mod.cleanup())
          break
        }
        case 'security': {
          const mod = await import('./security.js')
          if (!inner.isConnected) return
          const pane = document.createElement('div')
          pane.className = 'settings-modal-pane settings-modal-pane--security settings-embed-wrap'
          inner.appendChild(pane)
          await mod.mountSecurityInto(pane)
          _tabCleanups.set('security', () => mod.cleanup())
          break
        }
        case 'api': {
          const mod = await import('./remote.js')
          if (!inner.isConnected) return
          const pane = document.createElement('div')
          pane.className = 'settings-modal-pane settings-modal-pane--remote settings-embed-wrap'
          inner.appendChild(pane)
          await mod.mountRemoteInto(pane)
          _tabCleanups.set('api', () => mod.cleanup())
          break
        }
        case 'users': {
          const mod = await import('./users.js')
          if (!inner.isConnected) return
          const pane = document.createElement('div')
          pane.className = 'settings-modal-pane settings-modal-pane--users settings-embed-wrap'
          inner.appendChild(pane)
          await mod.mountUsersInto(pane)
          _tabCleanups.set('users', () => mod.cleanup())
          break
        }
        case 'sso': {
          const mod = await import('./sso.js')
          if (!inner.isConnected) return
          const pane = document.createElement('div')
          pane.className = 'settings-modal-pane settings-modal-pane--sso settings-embed-wrap'
          inner.appendChild(pane)
          await mod.mountSsoInto(pane)
          _tabCleanups.set('sso', () => mod.cleanup())
          break
        }
        case 'license': {
          const mod = await import('./license.js')
          if (!inner.isConnected) return
          const pane = document.createElement('div')
          pane.className = 'settings-modal-pane settings-modal-pane--license settings-embed-wrap'
          inner.appendChild(pane)
          await mod.mountLicenseInto(pane)
          _tabCleanups.set('license', () => mod.cleanup())
          break
        }
        default:
          break
      }
      _panelMounted.add(tab)
    } catch (e) {
      if (!inner.isConnected) return
      inner.innerHTML = `<div class="settings-subview-error" style="color:var(--error)">加载失败：${String(e)}</div>`
    }
  })()

  _mountInflight.set(tab, work)
  try {
    await work
  } finally {
    _mountInflight.delete(tab)
  }
}

/**
 * @param {HTMLElement} rootEl
 * @param {string} tab
 * @param {{ initial?: boolean, syncHash?: boolean }} [opts]
 */
async function switchSettingsTab(rootEl, tab, opts = {}) {
  const visible = visibleSettingsTabs()
  if (!visible.includes(tab)) tab = 'general'

  if (!rootEl.querySelector('.settings-subview-stack')) return

  const syncHash = opts.syncHash !== false

  setNavActive(rootEl, tab)
  setPanelVisible(rootEl, tab)

  if (!opts.initial && syncHash) {
    if (tab === 'resources') {
      const h = window.location.hash.slice(1) || ''
      const q = h.includes('?') ? h.split('?')[1] : ''
      const panel = new URLSearchParams(q).get('panel')
      const params = new URLSearchParams()
      params.set('tab', 'resources')
      if (panel === 'market' || panel === 'mine' || panel === 'installed') params.set('panel', panel)
      window.history.replaceState(null, '', `#/settings?${params.toString()}`)
    } else {
      window.history.replaceState(null, '', `#/settings?tab=${encodeURIComponent(tab)}`)
    }
  }

  await ensurePanelMounted(rootEl, tab)
}

/**
 * @param {HTMLElement} rootEl
 * @param {{ syncHash?: boolean, initialTab?: string }} [options]
 */
export async function mountSettingsRoot(rootEl, options = {}) {
  const { syncHash = true, initialTab } = options
  rootEl.classList.add('settings-modal-hub-root')
  rootEl.innerHTML = settingsHubHtml()

  rootEl.addEventListener('click', (e) => {
    const back = e.target.closest('[data-settings-back]')
    if (back) {
      e.preventDefault()
      import('../../components/settings-modal.js').then((m) => {
        void m.requestCloseSettingsModal({ flush: true })
      })
      return
    }
    const btn = e.target.closest('[data-settings-tab]')
    if (!btn) return
    e.preventDefault()
    const t = btn.dataset.settingsTab
    if (!t) return
    switchSettingsTab(rootEl, t, { syncHash, initial: false })
  })

  const visible = visibleSettingsTabs()
  const requested = initialTab === 'plans' ? 'models' : initialTab
  const tab =
    requested && visible.includes(requested) ? requested : parseTabFromLocation()
  await switchSettingsTab(rootEl, tab, { initial: true, syncHash })
}

export function cleanupTabs() {
  runTabCleanups()
}

export function cleanup() {
  cleanupTabs()
  // 路由离开时关闭设置弹窗遮罩（overlay 挂在 body 上，不在 _contentEl 内）
  import('../../components/settings-modal.js').then((m) => {
    m.closeSettingsModal({ skipNavigate: true })
  }).catch(() => {})
}

/** 路由占位：打开弹窗 */
export async function render() {
  const el = document.createElement('div')
  el.className = 'settings-route-placeholder'
  el.setAttribute('aria-hidden', 'true')

  const hash = window.location.hash.slice(1) || ''
  const q = hash.includes('?') ? hash.split('?')[1] : ''
  const tab = new URLSearchParams(q).get('tab')

  requestAnimationFrame(async () => {
    const { openSettingsModal } = await import('../../components/settings-modal.js')
    const visible = visibleSettingsTabs()
    openSettingsModal({
      initialTab: tab && visible.includes(tab) ? tab : undefined,
      routeEntry: true,
    })
    // 弹窗已打开，移除占位元素
    el.remove()
  })

  return el
}
