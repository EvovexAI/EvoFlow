/**
 * 设置弹窗：近全屏工作区内左分类 + 右嵌入各功能（非全页路由）
 */
import { navigate } from '../router.js'
import { setChatOverlayDefer } from '../lib/chat-overlay-defer.js'
import { applyModalTauriDragChrome, listenModalEscape } from '../lib/modal-chrome.js'

/** @type {{ overlay: HTMLElement, unlistenEscape: () => void, restoreHash: string, onThemePref?: () => void, routeEntry?: boolean } | null} */
let _instance = null

/** @type {Promise<typeof import('../pages/settings.js')> | null} */
let _settingsHubModPromise = null

const THEME_PREF_EVENT = 'evopanel-theme-pref-changed'

function parseRestoreHash(opts) {
  if (opts.routeEntry) return '/chat'
  const raw = window.location.hash.slice(1) || '/chat'
  const path = raw.split('?')[0]
  if (path === '/settings') return '/chat'
  return raw || '/chat'
}

function loadSettingsHubModule() {
  if (!_settingsHubModPromise) {
    _settingsHubModPromise = import('../pages/settings.js')
  }
  return _settingsHubModPromise
}

/**
 * Warm settings hub + default general tab during idle / hover.
 * @returns {Promise<typeof import('../pages/settings.js')>}
 */
export function prefetchSettingsModal() {
  loadSettingsHubModule()
  void import('../pages/general.js').catch(() => {})
  return loadSettingsHubModule()
}

async function flushSettingsBeforeClose(overlay) {
  const root = overlay?.querySelector('#settings-modal-root')
  const modelsPanel = root?.querySelector('[data-settings-panel="models"]:not([hidden])')
  if (modelsPanel) {
    try {
      const { flushMediaSettingsOnDone } = await import('../pages/settings/media.js')
      const ok = await flushMediaSettingsOnDone()
      if (!ok) return false
    } catch (err) {
      console.error('[settings-modal] flush media on done failed', err)
      return false
    }
  }
  try {
    const { flushWebSearchSettingsOnDone } = await import('../pages/settings/web-search.js')
    const ok = await flushWebSearchSettingsOnDone()
    if (!ok) return false
  } catch (err) {
    console.error('[settings-modal] flush web-search on done failed', err)
    return false
  }
  return true
}

function buildOverlayShell() {
  const overlay = document.createElement('div')
  overlay.className = 'react-chat-modal-overlay'
  overlay.id = 'evopanel-settings-modal-overlay'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-labelledby', 'evopanel-settings-modal-title')
  overlay.setAttribute('aria-busy', 'true')

  overlay.innerHTML = `
    <div class="react-chat-modal-card react-chat-modal-card--settings">
      <span id="evopanel-settings-modal-title" class="evopanel-sr-only">设置</span>
      <button type="button" class="react-chat-modal-close react-chat-modal-close--settings-corner" data-settings-modal-close aria-label="关闭">×</button>
      <div class="react-chat-modal-body react-chat-modal-body--settings">
        <div class="settings-modal-root settings-modal-root--boot" id="settings-modal-root">
          <div class="settings-modal-boot-loader" role="status" aria-live="polite">
            <div class="page-loader-spinner" aria-hidden="true"></div>
            <span class="page-loader-text">加载设置…</span>
          </div>
        </div>
      </div>
      <div class="react-chat-modal-actions react-chat-modal-actions--settings-compact">
        <button type="button" class="react-chat-modal-btn react-chat-modal-btn--ghost" data-settings-modal-cancel hidden>取消</button>
        <button type="button" class="react-chat-modal-btn react-chat-modal-btn--primary" data-settings-modal-done>完成</button>
      </div>
    </div>
  `
  return overlay
}

function bindOverlayHandlers(overlay) {
  const unlistenEscape = listenModalEscape(() => {
    void requestCloseSettingsModal({ flush: true })
  }, { overlay })

  overlay.addEventListener('click', async (e) => {
    if (e.target.closest('[data-settings-modal-done], [data-settings-back]')) {
      e.preventDefault()
      await requestCloseSettingsModal({ flush: true })
      return
    }
    if (e.target.closest('[data-settings-modal-close], [data-settings-modal-cancel]')) {
      e.preventDefault()
      await requestCloseSettingsModal({ flush: true })
      return
    }
    // 不因点击遮罩关闭：模型 API Key 等表单填到一半时容易误触丢失输入
  })

  const onThemePref = () => {
    const r = overlay.querySelector('#settings-modal-root')
    if (!r) return
    import('../pages/general.js').then(({ renderAppearanceBar }) => {
      const wrap = r.querySelector('.settings-embed-wrap')
      if (wrap && typeof renderAppearanceBar === 'function') renderAppearanceBar(wrap)
    })
  }

  return { unlistenEscape, onThemePref }
}

/**
 * Flush pending settings then close (返回工作区 / 完成).
 * @param {{ flush?: boolean, skipNavigate?: boolean }} [opts]
 */
export async function requestCloseSettingsModal(opts = {}) {
  const overlay =
    _instance?.overlay ?? document.getElementById('evopanel-settings-modal-overlay')
  if (opts.flush !== false && overlay) {
    const ok = await flushSettingsBeforeClose(overlay)
    if (!ok) return
  }
  closeSettingsModal({ skipNavigate: opts.skipNavigate })
}

/**
 * @param {{ skipNavigate?: boolean }} [opts]
 */
export function closeSettingsModal(opts = {}) {
  const overlay =
    _instance?.overlay ?? document.getElementById('evopanel-settings-modal-overlay')
  if (!overlay) return
  const hadInstance = !!_instance
  if (_instance?.onThemePref) {
    window.removeEventListener(THEME_PREF_EVENT, _instance.onThemePref)
  }
  if (_instance?.unlistenEscape) {
    _instance.unlistenEscape()
  }
  overlay.remove()
  import('../pages/settings.js')
    .then((m) => {
      if (typeof m.cleanupTabs === 'function') m.cleanupTabs()
    })
    .catch(() => {})
  const restore = _instance?.restoreHash ?? '/chat'
  const routeEntry = !!_instance?.routeEntry
  _instance = null
  setChatOverlayDefer('settings', false)
  if (hadInstance) {
    window.dispatchEvent(new CustomEvent('evopanel:settings-modal-closed'))
  }
  if (opts.skipNavigate) return
  const h = restore.startsWith('/') ? restore : `/${restore}`
  const targetPath = h.split('?')[0]
  const currentPath = (window.location.hash.slice(1) || '/chat').split('?')[0]
  if (routeEntry) {
    if (currentPath !== targetPath) navigate(h)
    return
  }
  // 弹窗模式：切换 Tab 时 replaceState 到 #/settings，但 Router 仍停留在 /chat。
  // 关闭时若 navigate('/chat') 会触发 hashchange → ChatApp 整页卸载重挂、SSE 断流。
  if (currentPath === '/settings') {
    history.replaceState(null, '', targetPath === '/chat' ? '#/chat' : `#${h}`)
  } else if (currentPath !== targetPath) {
    navigate(h)
  }
}

/**
 * @param {{ initialTab?: string, routeEntry?: boolean }} [opts]
 */
export async function openSettingsModal(opts = {}) {
  closeSettingsModal({ skipNavigate: true })

  const restoreHash = parseRestoreHash(opts)
  const routeEntry = !!opts.routeEntry
  const overlay = buildOverlayShell()
  const { unlistenEscape, onThemePref } = bindOverlayHandlers(overlay)

  document.body.appendChild(overlay)
  applyModalTauriDragChrome(overlay)
  window.addEventListener(THEME_PREF_EVENT, onThemePref)
  _instance = { overlay, unlistenEscape, restoreHash, onThemePref, routeEntry }

  setChatOverlayDefer('settings', true)
  window.dispatchEvent(new CustomEvent('evopanel:settings-modal-opened'))

  const hubPromise = loadSettingsHubModule()

  try {
    const { mountSettingsRoot } = await hubPromise
    const root = overlay.querySelector('#settings-modal-root')
    if (!root || !_instance) return
    root.classList.remove('settings-modal-root--boot')
    overlay.removeAttribute('aria-busy')
    await mountSettingsRoot(root, {
      // 弹窗叠在 /chat 上时不要改 hash，避免侧栏误判路由、关闭时 remount ChatApp
      syncHash: routeEntry,
      initialTab: opts.initialTab,
    })
  } catch (e) {
    console.error('[settings-modal]', e)
    closeSettingsModal()
    throw e
  }
}
