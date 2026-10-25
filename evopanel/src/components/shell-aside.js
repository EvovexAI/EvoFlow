/**
 * 应用全局左侧壳：主导航 + React 会话列表（#shell-chat-panel）
 */
import { navigate, getCurrentRoute } from '../router.js'
import { getPanelSetting, patchPanelSettings } from '../lib/panel-settings.js'
import { SHOW_KNOWLEDGE_OWNED_NAV } from '../lib/nav-visibility.js'
import { installSessionListDebugGlobal } from '../lib/session-list-debug.js'
import { mountSessionNotify } from '../lib/mount-session-notify.js'
import { mountShellAccount } from './shell-account.js'
import { version as APP_VERSION } from '../../package.json'

/**
 * 侧栏图标:对齐 lucide-react 标准 (zcode 同款),14px / 1.5 stroke。
 * 这里用模板字符串渲染,避免引入 React.createElement 到非 JSX 文件。
 * 数据来源:node_modules/lucide-react/dist/esm/icons/<name>.mjs
 */
const ICONS = {
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  // lucide house — 工作台入口
  house:
    '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  listTodo: '<path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="m3 17 2 2 4-4"/><rect width="6" height="6" x="3" y="4" rx="1"/>',
  layoutGrid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.128a4 4 0 0 1 0 7.744"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  bookOpen: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  fileSearch: '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><circle cx="11.5" cy="14.5" r="2.5"/><path d="M13.3 16.3 15 18"/>',
  blocks: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/><path d="M14 14h7v7h-7z"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  moreHorizontal: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 1v2"/><path d="M12 21v2"/><path d="M4.22 4.22l1.42 1.42"/><path d="M18.36 18.36l1.42 1.42"/><path d="M1 12h2"/><path d="M21 12h2"/><path d="M4.22 19.78l1.42-1.42"/><path d="M18.36 5.64l1.42-1.42"/>',
}

/** 渲染一个 lucide 风格图标:14px / 1.5 stroke / currentColor */
function _lucide(name, size = 14, stroke = 1.5) {
  const body = ICONS[name] || ''
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
}

installSessionListDebugGlobal()

const LS_SHELL_COLLAPSED = 'evopanel_shell_aside_collapsed'
const LS_SHELL_NAV_MORE = 'evopanel_shell_nav_more_expanded'

const MORE_NAV_PATHS = [
  '/expert',
  '/agents',
  '/tools',
  '/cron',
  '/automation',
  '/knowledge',
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

function _clearHoverExpand(el = _resolveShellEl()) {
  if (!el) return
  el.classList.remove('is-hover-expanded', 'is-hover-expanded-ready')
}

function _applyCollapsed(collapsed) {
  const el = _resolveShellEl()
  if (!el) return
  if (!_shellEl) _shellEl = el
  void patchPanelSettings({ shellAsideCollapsed: !!collapsed }, { silent: true })
  el.classList.toggle('collapsed', !!collapsed)
  if (!collapsed) _clearHoverExpand(el)
  const btn = el.querySelector('#shell-aside-collapse')
  if (btn) {
    btn.title = collapsed ? '展开侧栏' : '折叠侧栏'
    btn.setAttribute('aria-label', collapsed ? '展开侧栏' : '折叠侧栏')
    btn.classList.toggle('is-collapsed', !!collapsed)
  }
  _syncExpandBtn(collapsed)
}

/** 桌面折叠态悬停：先变宽再挂会话列表，避免主栏回流 + 首帧大列表 layout */
function _bindHoverExpand(el) {
  if (!el || el.dataset.shellHoverExpandBound === '1') return
  el.dataset.shellHoverExpandBound = '1'

  const mq =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(hover: hover) and (pointer: fine) and (min-width: 769px)')
      : { matches: false }
  let leaveTimer = 0
  let readyTimer = 0

  const clearTimers = () => {
    if (leaveTimer) {
      window.clearTimeout(leaveTimer)
      leaveTimer = 0
    }
    if (readyTimer) {
      window.clearTimeout(readyTimer)
      readyTimer = 0
    }
  }

  el.addEventListener('pointerenter', () => {
    if (!mq.matches || !el.classList.contains('collapsed')) return
    clearTimers()
    el.classList.add('is-hover-expanded')
    // 等宽度动画走一段，再挂会话列表
    readyTimer = window.setTimeout(() => {
      readyTimer = 0
      if (el.classList.contains('is-hover-expanded') && el.classList.contains('collapsed')) {
        el.classList.add('is-hover-expanded-ready')
      }
    }, 260)
  })

  el.addEventListener('pointerleave', () => {
    clearTimers()
    leaveTimer = window.setTimeout(() => {
      leaveTimer = 0
      _clearHoverExpand(el)
    }, 100)
  })
}

function _isMoreNavRoute(routePath) {
  const p = String(routePath || '')
  return (
    p === '/expert' ||
    p.startsWith('/expert/') ||
    p === '/agents' ||
    p.startsWith('/agents/') ||
    p === '/tools' ||
    p.startsWith('/tools/') ||
    p === '/cron' ||
    p === '/automation' ||
    p.startsWith('/knowledge') ||
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
    if (target === '/knowledge') {
      active =
        routePath === '/knowledge' ||
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
      // 工作台：打开空会话仪表盘（EvoFlowHomeDashboard）；会话列表「新对话」才是空白草稿
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
    if (e.target.closest('.react-chat-aside-brand')) {
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
        <img class="react-chat-aside-brand-logo" src="/images/logo.png" alt="" width="18" height="18" />
        <span class="react-chat-aside-toolbar-title">EvoFlow</span>
        <span class="react-chat-aside-version">v${APP_VERSION}</span>
      </div>
      <button type="button" class="react-chat-aside-icon-btn shell-aside-collapse-btn" id="shell-aside-collapse" title="折叠侧栏" aria-label="折叠侧栏">
        ${_lucide('chevronLeft', 14, 1.5)}
      </button>
    </div>
    <nav class="react-chat-aside-primary" aria-label="产品导航">
      <button type="button" class="react-chat-aside-nav-item" data-shell-nav="/chat" data-shell-home="1" id="shell-btn-new-task" title="工作台" aria-label="工作台">
        <span class="react-chat-aside-nav-ic" aria-hidden>${_lucide('house')}</span>
        <span class="react-chat-aside-nav-label">工作台</span>
      </button>
      <button type="button" class="react-chat-aside-nav-item" data-shell-nav="/tasks" data-premium-nav="tasks" title="任务中心">
        <span class="react-chat-aside-nav-ic" aria-hidden>${_lucide('listTodo')}</span>
        <span class="react-chat-aside-nav-label">任务中心</span>
      </button>
      <button type="button" class="react-chat-aside-nav-item" data-shell-nav="/apps" data-premium-nav="apps" title="工作流">
        <span class="react-chat-aside-nav-ic" aria-hidden>${_lucide('layoutGrid')}</span>
        <span class="react-chat-aside-nav-label">工作流</span>
      </button>
      <button type="button" class="react-chat-aside-nav-item" data-shell-nav="/proactive" data-premium-nav="proactive" title="员工">
        <span class="react-chat-aside-nav-ic" aria-hidden>${_lucide('users')}</span>
        <span class="react-chat-aside-nav-label">员工</span>
      </button>
      <div class="shell-aside-nav-more" data-shell-nav-more>
        <button type="button" class="shell-aside-nav-more-toggle" data-shell-nav-more-toggle title="更多" aria-expanded="false" aria-controls="shell-nav-more-body">
          <span class="shell-aside-nav-more-line" aria-hidden="true"></span>
          <span class="shell-aside-nav-more-toggle-inner">
            <span class="shell-aside-nav-more-chevron" aria-hidden="true">${_lucide('chevronRight', 10, 1.75)}</span>
          </span>
          <span class="shell-aside-nav-more-line" aria-hidden="true"></span>
        </button>
        <div class="shell-aside-nav-more-body" id="shell-nav-more-body" role="group" aria-label="更多导航">
          <button type="button" class="react-chat-aside-nav-item" data-shell-nav="/expert" title="智能体 · 能力模板">
            <span class="react-chat-aside-nav-ic" aria-hidden>${_lucide('bot')}</span>
            <span class="react-chat-aside-nav-label">智能体</span>
          </button>
          <button type="button" class="react-chat-aside-nav-item" data-shell-nav="/cron" title="自动化">
            <span class="react-chat-aside-nav-ic" aria-hidden>${_lucide('clock')}</span>
            <span class="react-chat-aside-nav-label">自动化</span>
          </button>
          ${
            SHOW_KNOWLEDGE_OWNED_NAV
              ? `<button type="button" class="react-chat-aside-nav-item" data-shell-nav="/knowledge" data-testid="nav-knowledge-owned" title="知识库">
            <span class="react-chat-aside-nav-ic" aria-hidden>${_lucide('fileSearch')}</span>
            <span class="react-chat-aside-nav-label">知识库</span>
          </button>`
              : ''
          }
          <button type="button" class="react-chat-aside-nav-item" data-shell-nav="/assets" data-testid="nav-assets" title="资产中心">
            <span class="react-chat-aside-nav-ic" aria-hidden>${_lucide('bookOpen')}</span>
            <span class="react-chat-aside-nav-label">资产中心</span>
          </button>
          <button type="button" class="react-chat-aside-nav-item" data-shell-nav="/extensions" title="Agent应用">
            <span class="react-chat-aside-nav-ic" aria-hidden>${_lucide('blocks')}</span>
            <span class="react-chat-aside-nav-label">Agent应用</span>
          </button>

        </div>
      </div>
    </nav>
    <div class="shell-aside-nav-divider" aria-hidden="true"></div>
    <div id="shell-chat-panel" class="shell-aside-recent"></div>
    <div class="react-chat-aside-footer shell-aside-bottom-bar">
      <div class="shell-aside-account-mount" id="shell-aside-account-mount"></div>
      <button type="button" class="shell-footer-icon-btn" id="shell-footer-settings" title="设置" aria-label="设置">
        <span class="react-chat-aside-nav-ic" aria-hidden>${_lucide('settings')}</span>
      </button>
      <div class="shell-aside-notify-mount" id="shell-aside-notify-mount"></div>
    </div>
  `

  if (getPanelSetting('shellAsideCollapsed', false)) _applyCollapsed(true)
  else _applyCollapsed(false)

  _bindShell(el)
  _bindHoverExpand(el)
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


