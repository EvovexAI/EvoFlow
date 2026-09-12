/**
 * 极简 hash 路由
 */
import { setChatSurfaceVisible } from './react/lib/client-perf.js'
import { bootMark } from './lib/startup-trace.js'

const routes = {}
const _moduleCache = {}
let _contentEl = null
let _chatHostEl = null
let _loadId = 0
let _currentCleanup = null
let _initialized = false
/** 串行化 chat surface 可见性，避免 hide/show 异步乱序把 React 钉死在 hibernate */
let _chatSurfaceEpoch = 0

let _defaultRoute = '/chat'

/** ChatApp 首包较大，冷启动/开发态动态 import 可能超过 15s */
const MODULE_LOAD_TIMEOUT_MS = 45000
const PAGE_RENDER_TIMEOUT_MS = 30000

/** index.html 全屏开场层；淡出后移除（可安全多次调用） */
export function removeBootSplash() {
  const el = document.getElementById('boot-splash')
  if (!el || el.classList.contains('boot-splash--hide')) return
  bootMark('boot splash hide begin')
  el.classList.add('boot-splash--hide')
  const done = () => {
    try {
      el.remove()
      bootMark('boot splash removed')
    } catch (_) {}
  }
  el.addEventListener('transitionend', done, { once: true })
  setTimeout(done, 500)
}

function scheduleRemoveBootSplash() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      // Chat 首包较大，略延迟再撤层，减少「层消失后仍有一帧空白」感
      setTimeout(() => removeBootSplash(), 120)
    })
  })
}

export function registerRoute(path, loader) {
  routes[path] = loader
}

/** 支持 /task/:id、/project/:id、/workflow/:id 等动态段 */
function resolveLoader(path) {
  if (routes[path]) return routes[path]
  if (/^\/task\/[^/]+$/.test(path) && routes['/task/:id']) return routes['/task/:id']
  if (/^\/share\/[^/]+$/.test(path) && routes['/share/:id']) return routes['/share/:id']
  if (/^\/extensions\/[^/]+$/.test(path) && routes['/extensions/:id']) return routes['/extensions/:id']
  if (/^\/project\/[^/]+$/.test(path) && routes['/project/:id']) return routes['/project/:id']
  if (/^\/workflow\/[^/]+$/.test(path) && routes['/workflow/:id']) return routes['/workflow/:id']
  if (/^\/knowledge\/vaults$/.test(path) && routes['/knowledge/vaults']) return routes['/knowledge/vaults']
  if (/^\/knowledge\/owned$/.test(path) && routes['/knowledge/owned']) return routes['/knowledge/owned']
  if (/^\/knowledge\/owned\/[^/]+$/.test(path) && routes['/knowledge/owned/:id']) return routes['/knowledge/owned/:id']
  if (/^\/knowledge\/[^/]+$/.test(path) && routes['/knowledge/:id']) return routes['/knowledge/:id']
  if (/^\/proactive\/[^/]+\/work\/[^/]+$/.test(path) && routes['/proactive/:code/work/:taskId']) {
    return routes['/proactive/:code/work/:taskId']
  }
  if (/^\/proactive\/[^/]+\/item\/[^/]+$/.test(path) && routes['/proactive/:code/item/:itemId']) {
    return routes['/proactive/:code/item/:itemId']
  }
  if (path === '/proactive/board' && routes['/proactive/board']) return routes['/proactive/board']
  if (/^\/proactive\/[^/]+$/.test(path) && routes['/proactive/:code']) return routes['/proactive/:code']
  if (/^\/apps\/[^/]+\/run$/.test(path) && routes['/apps/:id/run']) return routes['/apps/:id/run']
  if (/^\/apps\/[^/]+\/history$/.test(path) && routes['/apps/:id/history']) return routes['/apps/:id/history']
  if (/^\/apps\/[^/]+$/.test(path) && routes['/apps/:id']) return routes['/apps/:id']
  if (/^\/agents\/team\/[^/]+$/.test(path) && routes['/agents/team/:code']) return routes['/agents/team/:code']
  if (/^\/runs\/[^/]+$/.test(path) && routes['/runs/:runId']) return routes['/runs/:runId']
  return null
}

export function isChatRoute(path) {
  const p = String(path || '').split('?')[0]
  return p === '/chat' || p === '/chat-react'
}

export function isAuthRoute(path) {
  const p = String(path || '').split('?')[0]
  return p === '/login' || p === '/qr-login' || p === '/auth/callback'
}

/** 进入某个应用（画布 / 填参 / 运行历史）时整端沉浸，应用列表 `/apps` 除外 */
export function isAppStudioRoute(path) {
  const p = String(path || '').split('?')[0]
  return /^\/apps\/[^/]+(?:\/(?:run|history))?$/.test(p)
}

/** UI 扩展全页嵌套：与应用工作室同款沉浸（藏侧栏） */
export function isUiExtensionRoute(path) {
  const p = String(path || '').split('?')[0]
  return /^\/extensions\/[^/]+$/.test(p)
}

/** 只读分享页：隐藏全局侧栏 */
export function isShareViewRoute(path) {
  const p = String(path || '').split('?')[0]
  return /^\/share\/[^/]+$/.test(p)
}

/** 需要藏全局壳的沉浸路由（应用工作室 / UI 扩展 / 分享查看） */
export function isImmersiveShellRoute(path) {
  return isAppStudioRoute(path) || isUiExtensionRoute(path) || isShareViewRoute(path)
}

function setAuthShellMode(active) {
  const app = document.getElementById('app')
  if (app) app.classList.toggle('evopanel-auth-mode', active)
  if (active) {
    setChatHostVisible(false)
    closeAppSidebarDrawer()
  }
}

function setAppStudioShellMode(active) {
  const app = document.getElementById('app')
  if (app) app.classList.toggle('evopanel-app-studio-mode', !!active)
  if (active) closeAppSidebarDrawer()
}

/** Knowledge Vault 进入某个 Vault 详情时隐藏全局侧栏，返回列表恢复 */
export function setKnowledgeVaultDetailShellMode(active) {
  const app = document.getElementById('app')
  if (app) app.classList.toggle('evopanel-kv-detail-mode', !!active)
  if (active) closeAppSidebarDrawer()
  // 详情顶栏兼任标题栏：同步隐藏 #tauri-main-chrome
  void import('./lib/tauri-titlebar.js').then((m) => m.refreshTauriMainChromeVisibility?.())
}

export function setDefaultRoute(path) {
  _defaultRoute = path
}

export function navigate(path) {
  const target = String(path || '').replace(/^#/, '')
  const normalized = target.startsWith('/') ? target : `/${target}`
  const current = window.location.hash.slice(1) || ''
  if (current === normalized) {
    // Same hash: hashchange will not fire — reload explicitly
    loadRoute()
    return
  }
  window.location.hash = normalized
}

function setChatHostVisible(visible) {
  if (!_chatHostEl) return
  _chatHostEl.hidden = !visible
  _chatHostEl.style.display = visible ? 'flex' : 'none'
  // 必须同步：动态 import().then 在快速切路由时会乱序，导致 chatSurfaceVisible 卡在 false，
  // ChatMessageStreamPane 一直渲染 hibernate 空壳，看起来像「对话空白，刷新才好」。
  const epoch = ++_chatSurfaceEpoch
  const next = !!visible
  setChatSurfaceVisible(next)
  // 防御 epoch，便于以后若改回异步路径仍可丢弃过期回调
  void epoch
}

function setContentVisible(visible) {
  if (!_contentEl) return
  _contentEl.hidden = !visible
  _contentEl.style.display = visible ? '' : 'none'
}

export function initRouter(contentEl, opts = {}) {
  _contentEl = contentEl
  _chatHostEl = opts.chatHostEl || document.getElementById('chat-persistent-host')
  if (!_initialized) {
    window.addEventListener('hashchange', () => loadRoute())
    _initialized = true
  }
  loadRoute()
}

export function closeAppSidebarDrawer() {
  document.getElementById('app-shell-aside')?.classList.remove('shell-aside-open')
  document.getElementById('shell-aside-overlay')?.classList.remove('visible')
}

function updateNavActive(routePath) {
  document.querySelectorAll('.nav-item[data-route]').forEach(item => {
    const r = item.dataset.route || ''
    let active = routePath === r
    if (!active && r === '/apps' && routePath.startsWith('/apps/')) active = true
    if (!active && r === '/tasks' && routePath.startsWith('/task/')) active = true
    if (!active && r === '/projects' && routePath.startsWith('/project/')) active = true
    if (!active && r === '/agents' && routePath.startsWith('/agents/team/')) active = true
    if (!active && r === '/proactive' && (routePath.startsWith('/proactive/') || routePath.startsWith('/runs/'))) active = true
    if (!active && r === '/expert' && ['/agents','/skills','/tools','/tasks','/cron','/automation'].some(p => routePath === p || routePath.startsWith(p + '/'))) active = true
    if (!active && r === '/knowledge' && (routePath === '/knowledge' || routePath === '/knowledge/vaults' || routePath.startsWith('/knowledge/owned'))) active = true
    if (!active && r === '/knowledge/vaults' && (routePath === '/knowledge/vaults' || routePath === '/knowledge')) active = true
    if (!active && r === '/extensions' && (routePath === '/extensions' || routePath.startsWith('/extensions/'))) active = true
    item.classList.toggle('active', active)
  })
}

async function loadRouteModule(loader, path) {
  let mod = _moduleCache[path]
  if (!mod) {
    mod = await retryLoad(loader, 3, 500)
    _moduleCache[path] = mod
  }
  return mod
}

/**
 * Hover / idle warm: resolve + cache a route module before the user clicks.
 * Safe to call repeatedly; best-effort (errors swallowed by callers).
 */
export function prefetchRoute(path) {
  const p = String(path || '').split('?')[0]
  if (!p) return Promise.resolve(null)
  if (_moduleCache[p]) return Promise.resolve(_moduleCache[p])
  const loader = resolveLoader(p)
  if (!loader) return Promise.resolve(null)
  return loadRouteModule(loader, p).catch(() => null)
}

async function renderChatRoute(path, hash, thisLoad) {
  setContentVisible(false)
  setChatHostVisible(true)
  if (_contentEl) _contentEl.innerHTML = ''

  const loader = resolveLoader(path)
  if (!loader || !_chatHostEl) {
    removeBootSplash()
    return
  }

  let mod
  try {
    if (!_moduleCache[path] && !isChatAppMounted()) {
      _chatHostEl.innerHTML = ''
      const spinnerEl = document.createElement('div')
      spinnerEl.className = 'page-loader'
      spinnerEl.innerHTML = `
      <div class="page-loader-spinner"></div>
      <div class="page-loader-text">加载中...</div>
    `
      _chatHostEl.appendChild(spinnerEl)
    }
    mod = await loadRouteModule(loader, path)
  } catch (e) {
    console.error('[router] 模块加载失败:', hash, e)
    if (thisLoad === _loadId) showLoadError(_chatHostEl, hash, e)
    return
  }

  if (thisLoad !== _loadId) return

  let page
  try {
    const renderFn = mod.render || mod.default
    page = renderFn ? await withTimeout(renderFn(), PAGE_RENDER_TIMEOUT_MS, '页面渲染超时') : mod
  } catch (e) {
    console.error('[router] 页面渲染失败:', hash, e)
    delete _moduleCache[path]
    if (thisLoad === _loadId) showLoadError(_chatHostEl, hash, e)
    return
  }
  if (thisLoad !== _loadId) return

  if (typeof page === 'string') {
    _chatHostEl.innerHTML = page
  } else if (page instanceof HTMLElement) {
    if (page.parentElement !== _chatHostEl) {
      _chatHostEl.replaceChildren(page)
    }
  } else if (!_chatHostEl.childElementCount) {
    // 仅在宿主已被清空时才写错误态；绝不要在常驻 ChatApp 已挂载时 innerHTML=''
    console.error('[router] chat render returned non-element', page)
  }

  _currentCleanup = mod.cleanup || null
  updateNavActive(path.split('?')[0])
  window.dispatchEvent(new CustomEvent('evopanel:chat-route-shown'))
  scheduleRemoveBootSplash()
}

async function renderContentRoute(path, hash, thisLoad) {
  setChatHostVisible(false)
  setContentVisible(true)

  const loader = resolveLoader(path)
  if (!loader || !_contentEl) {
    removeBootSplash()
    return
  }

  _contentEl.innerHTML = ''

  let mod
  try {
    if (!_moduleCache[path]) {
      const spinnerEl = document.createElement('div')
      spinnerEl.className = 'page-loader'
      spinnerEl.innerHTML = `
      <div class="page-loader-spinner"></div>
      <div class="page-loader-text">加载中...</div>
    `
      _contentEl.appendChild(spinnerEl)
    }
    mod = await loadRouteModule(loader, path)
  } catch (e) {
    console.error('[router] 模块加载失败:', hash, e)
    if (thisLoad === _loadId) showLoadError(_contentEl, hash, e)
    return
  }

  if (thisLoad !== _loadId) return

  let page
  try {
    const renderFn = mod.render || mod.default
    page = renderFn ? await withTimeout(renderFn(), PAGE_RENDER_TIMEOUT_MS, '页面渲染超时') : mod
  } catch (e) {
    console.error('[router] 页面渲染失败:', hash, e)
    delete _moduleCache[path]
    if (thisLoad === _loadId) showLoadError(_contentEl, hash, e)
    return
  }
  if (thisLoad !== _loadId) return

  _contentEl.innerHTML = ''
  if (typeof page === 'string') {
    _contentEl.innerHTML = page
  } else if (page instanceof HTMLElement) {
    _contentEl.appendChild(page)
  }

  _currentCleanup = mod.cleanup || null
  updateNavActive(path.split('?')[0])
  scheduleRemoveBootSplash()
  void import('./lib/page-help.js').then((m) => {
    try {
      m.injectPageUsageGuide(_contentEl)
      m.checkOnboardingGuide(path)
      m.bindGuideShortcut()
    } catch (_) {}
  })
}

async function loadRoute() {
  const hash = window.location.hash.slice(1) || _defaultRoute
  const path = hash.split('?')[0]
  try {
    const { emitPageActivity } = await import('./lib/page-activity.js')
    const { extractPageContext } = await import('./components/global-assistant/assistant-context.js')
    const ctx = extractPageContext(path)
    emitPageActivity({
      type: 'route',
      module: ctx.module || undefined,
      label: ctx.label || path,
      entityId: ctx.contextId || undefined,
      detail: path,
    })
  } catch {
    /* ignore */
  }
  const loader = resolveLoader(path)
  if (!loader || (!_contentEl && !_chatHostEl)) {
    removeBootSplash()
    return
  }

  // Premium feature gate: keep URL, render in-place activate page
  try {
    const { isPremiumRoute, isPremiumActive } = await import('./lib/license.js')
    if (isPremiumRoute(path) && !isPremiumActive()) {
      const thisLoad = ++_loadId
      if (_currentCleanup) {
        try { _currentCleanup() } catch (_) {}
        _currentCleanup = null
      }
      setAuthShellMode(false)
      setAppStudioShellMode(false)
      setChatHostVisible(false)
      setContentVisible(true)
      if (!_contentEl) {
        removeBootSplash()
        return
      }
      _contentEl.innerHTML = ''
      try {
        const mod = await import('./pages/premium-activate.js')
        const page = await mod.render({ returnPath: path })
        if (thisLoad !== _loadId) return
        if (page instanceof HTMLElement) _contentEl.appendChild(page)
        _currentCleanup = mod.cleanup || null
        updateNavActive(path)
        scheduleRemoveBootSplash()
      } catch (e) {
        console.error('[router] premium activate page failed', e)
        if (thisLoad === _loadId) showLoadError(_contentEl, hash, e)
      }
      return
    }
  } catch {
    /* ignore — fail open only if module broken; API still 403 */
  }

  const thisLoad = ++_loadId

  if (_currentCleanup) {
    try { _currentCleanup() } catch (_) {}
    _currentCleanup = null
  }

  setAuthShellMode(isAuthRoute(path))
  setAppStudioShellMode(isImmersiveShellRoute(path))

  if (isChatRoute(path)) {
    await renderChatRoute(path, hash, thisLoad)
  } else {
    await renderContentRoute(path, hash, thisLoad)
  }
}

async function retryLoad(loader, maxRetries, delayMs) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await withTimeout(loader(), MODULE_LOAD_TIMEOUT_MS, '模块加载超时')
    } catch (e) {
      const msg = String(e?.message || e)
      const isRetryable =
        /fetch|network|connection|ERR_|超时|timeout/i.test(msg)
      if (i < maxRetries && isRetryable) {
        console.warn(`[router] 模块加载失败，${delayMs}ms 后重试 (${i + 1}/${maxRetries})...`)
        await new Promise(r => setTimeout(r, delayMs))
        continue
      }
      throw e
    }
  }
}

function withTimeout(promise, ms, msg) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms))
  ])
}

function showLoadError(container, hash, error) {
  removeBootSplash()
  const name = hash.replace('/', '') || 'unknown'
  container.innerHTML = `
    <div class="page-loader">
      <div style="color:var(--error,#ef4444);margin-bottom:12px">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
      </div>
      <div class="page-loader-text" style="color:var(--text-primary)">页面加载失败</div>
      <div style="color:var(--text-tertiary);font-size:12px;margin:8px 0 16px;max-width:400px;word-break:break-all">${escHtml(String(error?.message || error))}</div>
      <button onclick="location.hash='${hash}';location.reload()" style="padding:6px 20px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:13px">重新加载</button>
    </div>
  `
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

export function getCurrentRoute() {
  return window.location.hash.slice(1) || _defaultRoute
}

export function reloadCurrentRoute() {
  loadRoute()
}

/** ChatApp 是否已在常驻容器中挂载（即使当前路由不是 /chat） */
export function isChatAppMounted() {
  const host = _chatHostEl || document.getElementById('chat-persistent-host')
  return !!(host && host.childElementCount > 0)
}
