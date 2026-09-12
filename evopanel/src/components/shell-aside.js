/**
 * 应用全局左侧壳：主导航 + React 会话列表（#shell-chat-panel）
 */
import { navigate, getCurrentRoute } from '../router.js'
import { getPanelSetting, patchPanelSettings } from '../lib/panel-settings.js'
import { SHOW_KNOWLEDGE_VAULT_NAV } from '../lib/nav-visibility.js'
import { installSessionListDebugGlobal } from '../lib/session-list-debug.js'
import { mountSessionNotify } from '../lib/mount-session-notify.js'
import { mountShellAccount } from './shell-account.js'
import { version as APP_VERSION } from '../../package.json'

installSessionListDebugGlobal()

const LS_SHELL_COLLAPSED = 'evopanel_shell_aside_collapsed'
const LS_SHELL_NAV_MORE = 'evopanel_shell_nav_more_expanded'

const MORE_NAV_PATHS = [
  '/cron',
  '/automation',
  '/knowledge',
  '/knowledge/vaults',
  '/assets',
  '/memory',
  '/skills',
  '/extensions',
]
// 评测中心(/eval)、会话调试(/observability)、系统日志(/logs)不挂侧栏，属运维内部入口，路径仍可直达

/** 与 react-chat.css 中 repeating-linear-gradient 周期（px）一致 */
const ASIDE_TITLE_SHIMMER_PERIOD_PX = 120
const ASIDE_TITLE_SHIMMER_DURATION_MS = 2600

let _asideTitleShimmerCancel = null
let _asideTitleShimmerIO = null
let _shellEl = null

function _stopAsideTitleShimmer() {
  if (typeof _asideTitleShimmerCancel === 'function') {
    _asideTitleShimmerCancel()
    _asideTitleShimmerCancel = null
  }
}

function _startAsideTitleShimmerLoop(titleEl) {
  _stopAsideTitleShimmer()
  titleEl.style.animation = 'none'
  titleEl.style.webkitAnimation = 'none'
  let cancelled = false
  let rafId = 0
  const tick = () => {
    if (cancelled) return
    const elapsed = performance.now() % ASIDE_TITLE_SHIMMER_DURATION_MS
    const pos = (elapsed / ASIDE_TITLE_SHIMMER_DURATION_MS) * ASIDE_TITLE_SHIMMER_PERIOD_PX
    titleEl.style.backgroundPosition = `${pos}px 50%`
    rafId = window.requestAnimationFrame(tick)
  }
  rafId = window.requestAnimationFrame(tick)
  _asideTitleShimmerCancel = () => {
    cancelled = true
    if (rafId) window.cancelAnimationFrame(rafId)
  }
}

function _startAsideTitleShimmer(containerEl) {
  const titleEl = containerEl?.querySelector?.('.react-chat-aside-toolbar-title')
  if (!titleEl) return

  // 断开旧的 observer（如有）
  if (_asideTitleShimmerIO) {
    _asideTitleShimmerIO.disconnect()
    _asideTitleShimmerIO = null
  }
  _stopAsideTitleShimmer()

  // 页面不可见时也停止 RAF
  const onVisibilityChange = () => {
    if (document.hidden) _stopAsideTitleShimmer()
    else _startAsideTitleShimmerLoop(titleEl)
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  // IntersectionObserver：aside 不可见时停 RAF，可见时恢复
  if (typeof IntersectionObserver !== 'undefined' && containerEl) {
    _asideTitleShimmerIO = new IntersectionObserver((entries) => {
      const visible = entries[0]?.isIntersecting && !document.hidden
      if (visible) _startAsideTitleShimmerLoop(titleEl)
      else _stopAsideTitleShimmer()
    }, { threshold: 0.01 })
    _asideTitleShimmerIO.observe(containerEl)
  } else {
    // 降级：直接启动
    _startAsideTitleShimmerLoop(titleEl)
  }
}

function _isChatHashRoute() {
  const p = (getCurrentRoute() || '/chat').split('?')[0]
  return p === '/chat' || p === '/chat-react'
}

function _resolveShellEl() {
  return _shellEl || document.getElementById('app-shell-aside')
}

/** 侧栏收起后宽度为 0，折叠按钮不可见；在 #app 上挂全局展开钮（全路由可用） */
function _ensureExpandBtn() {
  let btn = document.getElementById('shell-aside-expand')
  if (btn) return btn
  btn = document.createElement('button')
  btn.type = 'button'
  btn.id = 'shell-aside-expand'
  btn.className = 'shell-aside-expand-btn'
  btn.title = '展开侧栏'
  btn.setAttribute('aria-label', '展开侧栏')
  btn.textContent = '»'
  btn.hidden = true
  btn.addEventListener('click', () => {
    setShellAsideCollapsed(false)
  })
  const aside = _resolveShellEl()
  if (aside?.parentNode) {
    aside.parentNode.insertBefore(btn, aside.nextSibling)
  } else {
    document.getElementById('app')?.appendChild(btn)
  }
  return btn
}

function _isAppStudioHashRoute() {
  const p = (getCurrentRoute() || '').split('?')[0]
  return /^\/apps\/[^/]+(?:\/(?:run|history))?$/.test(p) || /^\/extensions\/[^/]+$/.test(p)
}

function _syncExpandBtn(_collapsed = getShellAsideCollapsed()) {
  const btn = _ensureExpandBtn()
  // 折叠态改为 icon rail，侧栏内折叠钮即可展开；全局展开钮仅作兜底隐藏
  btn.hidden = true
  btn.classList.remove('is-visible')
}

function _applyCollapsed(collapsed) {
  const el = _resolveShellEl()
  if (!el) return
  if (!_shellEl) _shellEl = el
  void patchPanelSettings({ shellAsideCollapsed: !!collapsed }, { silent: true })
  el.classList.toggle('collapsed', !!collapsed)
  const btn = el.querySelector('#shell-aside-collapse')
  if (btn) {
    btn.title = collapsed ? '展开侧栏' : '折叠侧栏'
    btn.setAttribute('aria-label', collapsed ? '展开侧栏' : '折叠侧栏')
    btn.classList.toggle('is-collapsed', !!collapsed)
  }
  _syncExpandBtn(collapsed)
}

function _isMoreNavRoute(routePath) {
  const p = String(routePath || '')
  return (
    p === '/cron' ||
    p === '/automation' ||
    p.startsWith('/knowledge') ||
    p.startsWith('/knowledge/vaults') ||
    p === '/assets' ||
    p.startsWith('/assets/') ||
    p === '/memory' ||
    p.startsWith('/memory/') ||
    p === '/skills' ||
    p.startsWith('/skills/') ||
    p === '/extensions' ||
    p.startsWith('/extensions/')
  )
}

function _getNavMoreExpanded() {
  try {
    return localStorage.getItem(LS_SHELL_NAV_MORE) === '1'
  } catch {
    return false
  }
}

function _setNavMoreExpanded(expanded) {
  try {
    localStorage.setItem(LS_SHELL_NAV_MORE, expanded ? '1' : '0')
  } catch {
    /* ignore */
  }
  _applyNavMoreExpanded(expanded)
}

function _applyNavMoreExpanded(expanded) {
  const el = _resolveShellEl()
  if (!el) return
  const group = el.querySelector('[data-shell-nav-more]')
  if (!group) return
  group.classList.toggle('is-expanded', !!expanded)
  const toggle = group.querySelector('[data-shell-nav-more-toggle]')
  if (toggle) {
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false')
    toggle.classList.toggle('is-expanded', !!expanded)
  }
}

function _syncNavActive() {
  if (!_shellEl) return
  const routePath = (getCurrentRoute() || '/chat').split('?')[0]
  let moreChildActive = false
  _shellEl.querySelectorAll('[data-shell-nav]').forEach((btn) => {
    const target = btn.dataset.shellNav || ''
    let active = routePath === target
    if (target === '/chat' && (routePath === '/chat' || routePath === '/chat-react')) active = true
    if (target === '/expert' && ['/skills', '/tools', '/agents'].some(p => routePath === p || routePath.startsWith(p + '/'))) active = true
    if (target === '/tasks' && (routePath === '/tasks' || routePath.startsWith('/task/'))) active = true
    if (target === '/apps' && (routePath === '/apps' || routePath.startsWith('/apps/'))) active = true
    if (target === '/cron' && (routePath === '/cron' || routePath === '/automation')) active = true
    if (target === '/proactive' && (routePath === '/proactive' || routePath.startsWith('/proactive/'))) active = true
    if (target === '/extensions' && (routePath === '/extensions' || routePath.startsWith('/extensions/'))) active = true
    if (target === '/knowledge' || target === '/knowledge/vaults') {
      active =
        routePath === '/knowledge' ||
        routePath === '/knowledge/vaults' ||
        routePath.startsWith('/knowledge/')
    }
    if (target === '/assets') {
      active =
        routePath === '/assets' ||
        routePath.startsWith('/assets/') ||
        routePath === '/memory' ||
        routePath.startsWith('/memory/') ||
        routePath === '/skills' ||
        routePath.startsWith('/skills/')
    }
    btn.classList.toggle('active', active)
    if (active && MORE_NAV_PATHS.some((p) => target === p || target.startsWith(p))) moreChildActive = true
  })
  // 当前落在「更多」子项时自动展开，便于看见高亮
  if (moreChildActive || _isMoreNavRoute(routePath)) {
    _applyNavMoreExpanded(true)
  } else {
    _applyNavMoreExpanded(_getNavMoreExpanded())
  }
}

function _closeMobileShell() {
  const el = document.getElementById('app-shell-aside')
  const overlay = document.getElementById('shell-aside-overlay')
  if (el) el.classList.remove('shell-aside-open')
  if (overlay) overlay.classList.remove('visible')
}

/** @type {Promise<typeof import('./settings-modal.js')> | null} */
let _settingsModalModPromise = null

function _loadSettingsModalModule() {
  if (!_settingsModalModPromise) {
    _settingsModalModPromise = import('./settings-modal.js')
  }
  return _settingsModalModPromise
}

function _scheduleSettingsPrefetch() {
  const run = () => {
    _loadSettingsModalModule()
      .then((m) => m.prefetchSettingsModal?.())
      .catch(() => {})
  }
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(run, { timeout: 6000 })
  } else {
    setTimeout(run, 2500)
  }
}

function _bindSettingsPrefetchTrigger(el) {
  const btn = el.querySelector('#shell-footer-settings')
  if (!btn || btn.dataset.settingsPrefetchBound) return
  btn.dataset.settingsPrefetchBound = '1'
  let warmed = false
  const warm = () => {
    if (warmed) return
    warmed = true
    _loadSettingsModalModule()
      .then((m) => m.prefetchSettingsModal?.())
      .catch(() => {})
  }
  btn.addEventListener('pointerenter', warm, { passive: true })
  btn.addEventListener('focusin', warm)
}

/** Hover-warm heavy panels (same idea as session-list history prefetch). */
function _bindNavPanelPrefetch(el) {
  if (!el || el.dataset.navPrefetchBound) return
  el.dataset.navPrefetchBound = '1'
  const warmPath = (path) => {
    const p = String(path || '').trim()
    if (!p) return
    void import('../lib/nav-panel-prefetch.js')
      .then((m) => m.prefetchShellNav(p))
      .catch(() => {})
  }
  el.querySelectorAll('[data-shell-nav]').forEach((btn) => {
    const path = btn.dataset.shellNav
    if (!path || path === '/chat') return
    const warm = () => warmPath(path)
    btn.addEventListener('pointerenter', warm, { passive: true })
    btn.addEventListener('focusin', warm)
  })
  const moreToggle = el.querySelector('[data-shell-nav-more-toggle]')
  if (moreToggle) {
    const warmMore = () => {
      void import('../lib/nav-panel-prefetch.js')
        .then((m) => m.prefetchMoreNavPanels())
        .catch(() => {})
    }
    moreToggle.addEventListener('pointerenter', warmMore, { passive: true })
    moreToggle.addEventListener('focusin', warmMore)
  }
}

async function _openSettingsFromShell() {
  try {
    const { openSettingsModal } = await _loadSettingsModalModule()
    await openSettingsModal()
  } catch (e) {
    console.error('[shell-aside] open settings failed', e)
  }
}

function _bindShell(el) {
  el.addEventListener('click', (e) => {
    const moreToggle = e.target.closest('[data-shell-nav-more-toggle]')
    if (moreToggle) {
      const group = moreToggle.closest('[data-shell-nav-more]')
      const next = !group?.classList.contains('is-expanded')
      _setNavMoreExpanded(next)
      return
    }
    const navBtn = e.target.closest('[data-shell-nav]')
    if (navBtn) {
      const path = navBtn.dataset.shellNav
      // 首页 / 工作台：回到空会话仪表盘（已在工作台则不重复新建）
      if (path === '/chat' && navBtn.dataset.shellHome) {
        if (_isChatHashRoute()) {
          window.dispatchEvent(new CustomEvent('evopanel:shell-open-home'))
        } else {
          try {
            sessionStorage.setItem('evopanel_pending_open_home', '1')
          } catch {
            /* ignore */
          }
          navigate('/chat')
        }
        _closeMobileShell()
        return
      }
      if (path) navigate(path)
      _closeMobileShell()
      return
    }
    if (e.target.closest('#shell-aside-collapse')) {
      const aside = _resolveShellEl()
      if (aside) _applyCollapsed(!aside.classList.contains('collapsed'))
      return
    }
    if (e.target.closest('#shell-footer-settings')) {
      void _openSettingsFromShell()
      _closeMobileShell()
    }
  })
}

export function getShellAsideCollapsed() {
  const el = _resolveShellEl()
  return !!el?.classList.contains('collapsed')
}

export function setShellAsideCollapsed(collapsed) {
  _applyCollapsed(!!collapsed)
}

export function toggleShellAsideCollapsed() {
  setShellAsideCollapsed(!getShellAsideCollapsed())
}

export function openMobileShellAside() {
  const el = document.getElementById('app-shell-aside')
  if (!el) return
  el.classList.add('shell-aside-open')
  let overlay = document.getElementById('shell-aside-overlay')
  if (!overlay) {
    overlay = document.createElement('div')
    overlay.id = 'shell-aside-overlay'
    overlay.className = 'shell-aside-overlay'
    overlay.addEventListener('click', _closeMobileShell)
    document.getElementById('app')?.appendChild(overlay)
  }
  requestAnimationFrame(() => overlay.classList.add('visible'))
}

export function initShellAside(el) {
  if (!el) return
  _stopAsideTitleShimmer()
  _shellEl = el
  el.id = 'app-shell-aside'
  el.className = 'react-chat-session-aside shell-aside-host'
  el.setAttribute('aria-label', '主导航')

  el.innerHTML = `
    <div class="react-chat-aside-toolbar">
      <div class="react-chat-aside-brand">
        <img class="react-chat-aside-brand-logo" src="/images/logo.png" alt="" width="14" height="14" />
        <span class="react-chat-aside-toolbar-title">EvoFlow</span>
        <span class="react-chat-aside-version">v${APP_VERSION}</span>
      </div>
      <button type="button" class="react-chat-aside-icon-btn shell-aside-collapse-btn" id="shell-aside-collapse" title="折叠侧栏" aria-label="折叠侧栏">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M15 6l-6 6 6 6"/>
        </svg>
      </button>
    </div>
    <nav class="react-chat-aside-primary" aria-label="产品导航">
      <button type="button" class="react-chat-aside-nav-item" data-shell-nav="/chat" data-shell-home="1" id="shell-btn-new-task" title="新建对话" aria-label="新建对话">
        <span class="react-chat-aside-nav-ic" aria-hidden>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <path d="M12 5v14M5 12h14"/>
          </svg>
        </span>
        <span class="react-chat-aside-nav-label">新建对话</span>
      </button>
      <button type="button" class="react-chat-aside-nav-item" data-shell-nav="/tasks" data-premium-nav="tasks" title="任务中心">
        <span class="react-chat-aside-nav-ic" aria-hidden>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M9 11l3 3L22 4"/>
            <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
          </svg>
        </span>
        <span class="react-chat-aside-nav-label">任务中心</span>
      </button>
      <button type="button" class="react-chat-aside-nav-item" data-shell-nav="/apps" data-premium-nav="apps" title="工作流">
        <span class="react-chat-aside-nav-ic" aria-hidden>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
            <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
          </svg>
        </span>
        <span class="react-chat-aside-nav-label">工作流</span>
      </button>
      <button type="button" class="react-chat-aside-nav-item" data-shell-nav="/expert" title="智能体">
        <span class="react-chat-aside-nav-ic" aria-hidden>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="7" width="18" height="12" rx="2"/>
            <circle cx="9" cy="12" r="1.5" fill="currentColor"/>
            <circle cx="15" cy="12" r="1.5" fill="currentColor"/>
            <path d="M9 3l3 2 3-2"/>
            <path d="M9 17h6"/>
          </svg>
        </span>
        <span class="react-chat-aside-nav-label">智能体</span>
      </button>
      <button type="button" class="react-chat-aside-nav-item" data-shell-nav="/proactive" data-premium-nav="proactive" title="智能体员工">
        <span class="react-chat-aside-nav-ic" aria-hidden>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
          </svg>
        </span>
        <span class="react-chat-aside-nav-label">员工</span>
      </button>
      <div class="shell-aside-nav-more" data-shell-nav-more>
        <button type="button" class="react-chat-aside-nav-item shell-aside-nav-more-toggle" data-shell-nav-more-toggle title="更多" aria-expanded="false" aria-controls="shell-nav-more-body">
          <span class="react-chat-aside-nav-ic" aria-hidden>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/>
              <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>
              <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>
            </svg>
          </span>
          <span class="react-chat-aside-nav-label">更多</span>
          <span class="shell-aside-nav-more-chevron" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 6l6 6-6 6"/>
            </svg>
          </span>
        </button>
        <div class="shell-aside-nav-more-body" id="shell-nav-more-body" role="group" aria-label="更多导航">
          <button type="button" class="react-chat-aside-nav-item" data-shell-nav="/cron" title="自动化">
            <span class="react-chat-aside-nav-ic" aria-hidden>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
            </span>
            <span class="react-chat-aside-nav-label">自动化</span>
          </button>
          ${
            SHOW_KNOWLEDGE_VAULT_NAV
              ? `<button type="button" class="react-chat-aside-nav-item" data-shell-nav="/knowledge" data-testid="nav-knowledge-owned" title="知识库">
            <span class="react-chat-aside-nav-ic" aria-hidden>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
                <path d="M8 7h8"/>
                <path d="M8 11h5"/>
                <circle cx="16.5" cy="15.5" r="2.5"/>
                <path d="m18.5 17.5 2 2"/>
              </svg>
            </span>
            <span class="react-chat-aside-nav-label">知识库</span>
          </button>`
              : ''
          }
          <button type="button" class="react-chat-aside-nav-item" data-shell-nav="/assets" data-testid="nav-assets" title="资产中心">
            <span class="react-chat-aside-nav-ic" aria-hidden>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/>
                <path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/>
              </svg>
            </span>
            <span class="react-chat-aside-nav-label">资产中心</span>
          </button>
          <button type="button" class="react-chat-aside-nav-item" data-shell-nav="/extensions" title="扩展应用">
            <span class="react-chat-aside-nav-ic" aria-hidden>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>
                <rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 17.5h7M17.5 14v7"/>
              </svg>
            </span>
            <span class="react-chat-aside-nav-label">扩展应用</span>
          </button>

        </div>
      </div>
    </nav>
    <div class="shell-aside-nav-divider" aria-hidden="true"></div>
    <div id="shell-chat-panel" class="shell-aside-recent"></div>
    <div class="react-chat-aside-footer shell-aside-bottom-bar">
      <div class="shell-aside-account-mount" id="shell-aside-account-mount"></div>
      <button type="button" class="shell-footer-icon-btn" id="shell-footer-settings" title="设置" aria-label="设置">
        <span class="react-chat-aside-nav-ic" aria-hidden>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="3"/>
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
          </svg>
        </span>
      </button>
      <div class="shell-aside-notify-mount" id="shell-aside-notify-mount"></div>
    </div>
  `

  if (getPanelSetting('shellAsideCollapsed', false)) _applyCollapsed(true)
  else _applyCollapsed(false)

  _bindShell(el)
  _scheduleSettingsPrefetch()
  _bindSettingsPrefetchTrigger(el)
  _bindNavPanelPrefetch(el)
  mountSessionNotify(el.querySelector('#shell-aside-notify-mount'))
  void mountShellAccount(el.querySelector('#shell-aside-account-mount'))

  window.addEventListener('hashchange', () => {
    _syncNavActive()
    _syncExpandBtn()
  })

  _syncNavActive()
  _syncExpandBtn()
  void import('../lib/ws-client.js').then(({ wsClient }) => {
    void wsClient.hydrateGlobalWorkspaceHistoryOnce()
  })
  _startAsideTitleShimmer(el)
}

/** Kept for callers after activate; premium menus stay always visible. */
export function refreshShellAsideNav() {
  const el = _shellEl || document.getElementById('app-shell-aside')
  if (!el) return
  el.querySelectorAll('[data-premium-nav]').forEach((btn) => {
    btn.removeAttribute('hidden')
  })
}


