/**
 * 窄屏底部导航（≤768px）：对话 / 任务 / 知识库 / 我的
 * 仅外壳；桌面宽屏不显示，不影响原侧栏与页面逻辑。
 */
import { navigate, isAuthRoute, isChatRoute, closeAppSidebarDrawer } from '../router.js'

const TABBAR_ID = 'mobile-tabbar'

const TABS = [
  {
    id: 'chat',
    label: '对话',
    match: (p) => isChatRoute(p),
    go: () => navigate('/chat'),
    icon: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>`,
  },
  {
    id: 'tasks',
    label: '任务',
    match: (p) => p === '/tasks' || p.startsWith('/task/'),
    go: () => navigate('/tasks'),
    icon: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>`,
  },
  {
    id: 'knowledge',
    label: '知识库',
    match: (p) => p === '/knowledge' || p.startsWith('/knowledge/'),
    go: () => navigate('/knowledge/owned'),
    icon: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M8 7h8M8 11h5"/></svg>`,
  },
  {
    id: 'me',
    label: '我的',
    match: (p) =>
      p === '/me' ||
      p === '/settings' ||
      p === '/general' ||
      p === '/models' ||
      p === '/proactive' ||
      p.startsWith('/proactive/') ||
      p === '/apps' ||
      p.startsWith('/apps/') ||
      p === '/expert' ||
      p === '/extensions' ||
      p.startsWith('/extensions/') ||
      p === '/cron' ||
      p === '/skills' ||
      p === '/tools' ||
      p === '/memory' ||
      p === '/mail',
    go: () => navigate('/me'),
    icon: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  },
]

function currentPath() {
  return (window.location.hash.slice(1) || '/chat').split('?')[0]
}

function shouldShowTabbar(path) {
  if (isAuthRoute(path)) return false
  const app = document.getElementById('app')
  if (app?.classList.contains('evopanel-auth-mode')) return false
  if (app?.classList.contains('evopanel-app-studio-mode')) return false
  return true
}

function syncActive(el) {
  const path = currentPath()
  el.querySelectorAll('[data-mobile-tab]').forEach((btn) => {
    const tab = TABS.find((t) => t.id === btn.dataset.mobileTab)
    btn.classList.toggle('is-active', !!(tab && tab.match(path)))
  })
  const app = document.getElementById('app')
  const inChatThread = !!app?.classList.contains('evopanel-mobile-chat-thread')
  if (app) {
    // 列表/其它 Tab 显示底栏；真正进对话时底栏收起（壳层 class 仍保留以便布局）
    app.classList.toggle('evopanel-mobile-tabbar-visible', shouldShowTabbar(path))
    app.classList.toggle('evopanel-route-chat', isChatRoute(path))
  }
  el.hidden = !shouldShowTabbar(path) || inChatThread

  const titleEl = document.querySelector('#mobile-topbar .mobile-topbar-title')
  if (titleEl) {
    const tab = TABS.find((t) => t.match(path))
    titleEl.textContent = tab?.label || 'EvoFlow'
  }
}

function onTabClick(e) {
  const btn = e.target.closest('[data-mobile-tab]')
  if (!btn) return
  const tab = TABS.find((t) => t.id === btn.dataset.mobileTab)
  if (!tab) return
  closeAppSidebarDrawer()
  const path = currentPath()
  if (tab.match(path) && tab.id !== 'chat') return
  // 对话 Tab：已在对话页则回到会话列表（微信式），否则进对话并打开列表
  if (tab.id === 'chat' && isChatRoute(path)) {
    window.dispatchEvent(new CustomEvent('evopanel:mobile-chat-list'))
    return
  }
  if (tab.id === 'chat') {
    try {
      sessionStorage.setItem('evopanel_pending_mobile_chat_list', '1')
    } catch {
      /* ignore */
    }
    tab.go()
    return
  }
  tab.go()
}

/** @type {HTMLElement | null} */
let _el = null

export function initMobileTabbar() {
  if (_el) return _el
  const host = document.getElementById('app')
  if (!host) return null

  const el = document.createElement('nav')
  el.id = TABBAR_ID
  el.className = 'mobile-tabbar'
  el.setAttribute('aria-label', '手机主导航')
  el.innerHTML = TABS.map(
    (t) => `
    <button type="button" class="mobile-tabbar-item" data-mobile-tab="${t.id}" aria-label="${t.label}">
      <span class="mobile-tabbar-ic">${t.icon}</span>
      <span class="mobile-tabbar-label">${t.label}</span>
    </button>`,
  ).join('')
  el.addEventListener('click', onTabClick)
  host.appendChild(el)
  _el = el

  const sync = () => syncActive(el)
  window.addEventListener('hashchange', sync)
  // 路由还会改 app class（auth / studio），用 MutationObserver 轻量同步显隐
  const app = document.getElementById('app')
  if (app) {
    const mo = new MutationObserver(sync)
    mo.observe(app, { attributes: true, attributeFilter: ['class'] })
  }
  sync()
  return el
}

export function refreshMobileTabbar() {
  if (_el) syncActive(_el)
}
