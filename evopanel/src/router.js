/**
 * 极简 hash 路由
 */
import { setChatSurfaceVisible } from './react/lib/client-perf.js'
import { bootMark } from './lib/startup-trace.js'
import { nextFrameSafe } from './lib/raf-safe.js'

const routes = {}
/** Cache key → module. Key is route *pattern* (e.g. `/apps/:id`), not raw path. */
const _moduleCache = {}
/** In-flight loads keyed same as `_moduleCache` — coalesce concurrent imports. */
const _moduleInflight = {}
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
/** UI: only escalate “still loading” copy after this (was 1.5s — too noisy). */
const SLOW_LOADER_HINT_MS = 2500
/** Persist route timing when import or render exceeds this. */
const ROUTE_TIMING_LOG_MS = 800

/**
 * Stabilize dynamic routes onto the registered pattern so `/apps/a` and `/apps/b`
 * share one module cache entry (same chunk). Without this, every id looked “cold”
 * and showed「首次加载页面模块」while only *render/data* was slow.
 */
export function routeModuleCacheKey(path) {
  const p = String(path || '').split('?')[0]
  if (!p) return p
  if (routes[p]) return p
  if (/^\/task\/[^/]+$/.test(p)) return '/task/:id'
  if (/^\/share\/[^/]+$/.test(p)) return '/share/:id'
  if (/^\/extensions\/[^/]+$/.test(p)) return '/extensions/:id'
  if (/^\/project\/[^/]+$/.test(p)) return '/project/:id'
  if (/^\/workflow\/[^/]+$/.test(p)) return '/workflow/:id'
  if (/^\/knowledge\/owned\/[^/]+$/.test(p)) return '/knowledge/owned/:id'
  if (/^\/knowledge\/vaults$/.test(p)) return '/knowledge/owned'
  if (/^\/knowledge\/[^/]+$/.test(p) && p !== '/knowledge/owned') return '/knowledge/:id'
  if (/^\/proactive\/[^/]+\/work\/[^/]+$/.test(p)) return '/proactive/:code/work/:taskId'
  if (/^\/proactive\/[^/]+\/item\/[^/]+$/.test(p)) return '/proactive/:code/item/:itemId'
  if (p === '/proactive/board') return '/proactive/board'
  if (/^\/proactive\/[^/]+$/.test(p)) return '/proactive/:code'
  if (/^\/apps\/[^/]+\/run$/.test(p)) return '/apps/:id/run'
  if (/^\/apps\/[^/]+\/history$/.test(p)) return '/apps/:id/history'
  if (/^\/apps\/[^/]+$/.test(p)) return '/apps/:id'
  if (/^\/agents\/team\/[^/]+$/.test(p)) return '/agents/team/:code'
  if (/^\/agents\/[^/]+$/.test(p)) return '/agents/:code'
  if (/^\/runs\/[^/]+$/.test(p)) return '/runs/:runId'
  return p
}

function persistRouterLog(level, message) {
  const line = String(message || '').slice(0, 11_500)
  if (!line) return
  try {
    if (typeof window === 'undefined') return
    if (!(window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__)) return
    void import('@tauri-apps/api/core')
      .then((m) => m.invoke('append_frontend_log', { level, message: line }))
      .catch(() => {})
  } catch {
    /* best-effort */
  }
}

function logRouteTiming(event, detail) {
  const importMs = Number(detail?.importMs || 0)
  const renderMs = Number(detail?.renderMs || 0)
  const totalMs = Number(detail?.totalMs || importMs + renderMs)
  const slow = totalMs >= ROUTE_TIMING_LOG_MS || importMs >= ROUTE_TIMING_LOG_MS || renderMs >= ROUTE_TIMING_LOG_MS
  if (!slow && event !== 'error') return
  const line =
    `[router] ${event} path=${detail?.path || '-'} cacheKey=${detail?.cacheKey || '-'} ` +
    `cached=${detail?.cached ? 1 : 0} import_ms=${importMs} render_ms=${renderMs} total_ms=${totalMs}` +
    (detail?.error ? ` error=${detail.error}` : '')
  if (event === 'error') {
    console.error(line)
    persistRouterLog('error', line)
  } else if (totalMs >= 3000) {
    console.warn(line)
    persistRouterLog('warn', line)
  } else {
    console.info(line)
    persistRouterLog('info', line)
  }
  try {
    bootMark(`router ${event}`, {
      path: detail?.path,
      cacheKey: detail?.cacheKey,
      cached: !!detail?.cached,
      importMs,
      renderMs,
      totalMs,
    })
  } catch {
    /* ignore */
  }
}

/** index.html 全屏开场层；淡出后移除（可安全多次调用） */
export function removeBootSplash() {
  const el = document.getElementById('boot-splash')
  if (!el || el.classList.contains('boot-splash--hide')) return
  bootMark('boot splash hide begin')
  el.classList.add('boot-splash--hide')
  // 平台实况控制台随启动页停机（boot.js 监听，重复派发无副作用）
  try { window.dispatchEvent(new CustomEvent('ef:console-stop')) } catch (_) {}
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
  // rAF 在 WebView 被节流（遮挡/最小化）时可能长期不派发，用 setTimeout 兜底
  nextFrameSafe(() => {
    setTimeout(() => removeBootSplash(), 120)
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
  // /knowledge/vaults (legacy Obsidian vault route) is removed — redirect to owned KB home.
  if (/^\/knowledge\/vaults$/.test(path)) return routes['/knowledge/owned']
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
  if (/^\/agents\/[^/]+$/.test(path) && routes['/agents/:code']) return routes['/agents/:code']
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

/** 工作流画布 / 填参 / 历史（列表 `/apps` 除外）。侧栏收成图标栏，不再整栏隐藏。 */
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

/** 需要整栏藏全局壳的沉浸路由（UI 扩展 / 分享；工作流已改为图标栏） */
export function isImmersiveShellRoute(path) {
  return isUiExtensionRoute(path) || isShareViewRoute(path)
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

/** Agent 应用打开态：不全屏，侧栏收成图标栏（配合 ui-extension-shell 自动折叠） */
function setUiExtensionOpenMode(active) {
  const app = document.getElementById('app')
  if (app) app.classList.toggle('evopanel-uiext-open-mode', !!active)
}

/**
 * Knowledge detail (Owned KB) — enter detail view: hide global sidebar shell.
 * Kept for backward compat; the shell mode class also serves Owned KB.
 */
export function setKnowledgeDetailShellMode(active) {
  const app = document.getElementById('app')
  if (app) app.classList.toggle('evopanel-kb-detail-mode', !!active)
  if (active) closeAppSidebarDrawer()
  // Detail topbar doubles as title bar: hide the redundant Tauri chrome
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

const SHELL_FADE_OUT_MS = 110
let _chatHostHideTimer = null
let _contentHideTimer = null

/** 退出淡出：路由切换是 display 硬切换，先把旧宿主淡到 0 再藏，消除「闪一下」。
 *  只延迟 display 样式本身；setChatSurfaceVisible / hidden 的语义时机保持立即。 */
function hideShellElWithFade(el, hideFn, timerRef) {
  if (!el || el.hidden || el.style.display === 'none') {
    hideFn()
    return
  }
  el.style.transition = `opacity ${SHELL_FADE_OUT_MS}ms ease`
  // 强制一帧让 transition 生效（同帧设 transition+opacity 不会插值）
  void el.offsetWidth
  el.style.opacity = '0'
  if (timerRef.current) clearTimeout(timerRef.current)
  timerRef.current = setTimeout(() => {
    timerRef.current = null
    el.style.transition = ''
    el.style.opacity = ''
    hideFn()
  }, SHELL_FADE_OUT_MS)
}

function setChatHostVisible(visible) {
  if (!_chatHostEl) return
  if (_chatHostHideTimer) { clearTimeout(_chatHostHideTimer); _chatHostHideTimer = null }
  // 必须同步：动态 import().then 在快速切路由时会乱序，导致 chatSurfaceVisible 卡在 false，
  // ChatMessageStreamPane 一直渲染 hibernate 空壳，看起来像「对话空白，刷新才好」。
  const epoch = ++_chatSurfaceEpoch
  const next = !!visible
  setChatSurfaceVisible(next)
  // 防御 epoch，便于以后若改回异步路径仍可丢弃过期回调
  void epoch
  if (visible) {
    _chatHostEl.style.opacity = ''
    _chatHostEl.style.transition = ''
    _chatHostEl.hidden = false
    _chatHostEl.style.display = 'flex'
  } else {
    hideShellElWithFade(_chatHostEl, () => {
      _chatHostEl.hidden = true
      _chatHostEl.style.display = 'none'
    }, { get current() { return _chatHostHideTimer }, set current(v) { _chatHostHideTimer = v } })
  }
}

function setContentVisible(visible) {
  if (!_contentEl) return
  if (_contentHideTimer) { clearTimeout(_contentHideTimer); _contentHideTimer = null }
  if (visible) {
    _contentEl.style.opacity = ''
    _contentEl.style.transition = ''
    _contentEl.hidden = false
    _contentEl.style.display = ''
  } else {
    hideShellElWithFade(_contentEl, () => {
      _contentEl.hidden = true
      _contentEl.style.display = 'none'
    }, { get current() { return _contentHideTimer }, set current(v) { _contentHideTimer = v } })
  }
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
    if (!active && r === '/expert' && /^\/agents\/[^/]+$/.test(routePath) && !routePath.startsWith('/agents/team/')) active = true
    if (!active && r === '/proactive' && (routePath.startsWith('/proactive/') || routePath.startsWith('/runs/'))) active = true
    if (!active && r === '/expert' && ['/agents','/skills','/tools','/tasks','/cron','/automation'].some(p => routePath === p || routePath.startsWith(p + '/'))) active = true
    if (!active && r === '/knowledge' && (routePath === '/knowledge' || routePath === '/knowledge/vaults' || routePath.startsWith('/knowledge/owned'))) active = true
    if (!active && r === '/extensions' && (routePath === '/extensions' || routePath.startsWith('/extensions/'))) active = true
    item.classList.toggle('active', active)
  })
}

async function loadRouteModule(loader, path) {
  const cacheKey = routeModuleCacheKey(path)
  let mod = _moduleCache[cacheKey]
  if (mod) return { mod, cacheKey, cached: true, importMs: 0 }
  if (_moduleInflight[cacheKey]) {
    mod = await _moduleInflight[cacheKey]
    return { mod, cacheKey, cached: true, importMs: 0 }
  }
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const job = retryLoad(loader, 3, 500)
    .then((loaded) => {
      _moduleCache[cacheKey] = loaded
      return loaded
    })
    .finally(() => {
      delete _moduleInflight[cacheKey]
    })
  _moduleInflight[cacheKey] = job
  mod = await job
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now()
  return { mod, cacheKey, cached: false, importMs: Math.round(t1 - t0) }
}

/**
 * 慢加载占位升级：超过 SLOW_LOADER_HINT_MS 未完成时换成可理解的等待原因。
 * phase on dataset: 'module' | 'render' — 避免把「渲染/拉数」误写成「加载模块」。
 */
function upgradeSlowLoaderText(spinnerEl, startedAt, phase = 'module') {
  if (!spinnerEl) return
  const textEl = spinnerEl.querySelector('.page-loader-text')
  if (!textEl) return
  spinnerEl.dataset.loaderPhase = phase || 'module'
  spinnerEl.dataset.loaderStartedAt = String(startedAt || Date.now())
  if (spinnerEl.dataset.loaderTicking === '1') return
  spinnerEl.dataset.loaderTicking = '1'
  const tick = () => {
    if (!spinnerEl.isConnected) return
    void import('./lib/tauri-api.js')
      .then((m) => {
        if (!spinnerEl.isConnected) return
        const warming = typeof m.isGatewayWarming === 'function' ? m.isGatewayWarming() : false
        const started = Number(spinnerEl.dataset.loaderStartedAt || Date.now())
        const waitSec = Math.max(1, Math.round((Date.now() - started) / 1000))
        const curPhase = spinnerEl.dataset.loaderPhase || 'module'
        if (warming) {
          textEl.textContent = `网关就绪中…（已等待 ${waitSec} 秒）`
        } else if (curPhase === 'render') {
          textEl.textContent = `页面准备中…（已等待 ${waitSec} 秒）`
        } else {
          textEl.textContent = `加载页面…（已等待 ${waitSec} 秒）`
        }
        setTimeout(tick, 2000)
      })
      .catch(() => {})
  }
  setTimeout(tick, SLOW_LOADER_HINT_MS)
}

function setLoaderPhase(spinnerEl, phase, startedAt) {
  if (!spinnerEl?.isConnected) return
  const textEl = spinnerEl.querySelector('.page-loader-text')
  if (!textEl) return
  spinnerEl.dataset.loaderPhase = phase || 'module'
  if (startedAt) spinnerEl.dataset.loaderStartedAt = String(startedAt)
  if (phase === 'render') textEl.textContent = '页面准备中...'
  else textEl.textContent = '加载中...'
  upgradeSlowLoaderText(spinnerEl, startedAt || Date.now(), phase)
}

/**
 * Hover / idle warm: resolve + cache a route module before the user clicks.
 * Safe to call repeatedly; best-effort (errors swallowed by callers).
 */
export function prefetchRoute(path) {
  const p = String(path || '').split('?')[0]
  if (!p) return Promise.resolve(null)
  const cacheKey = routeModuleCacheKey(p)
  if (_moduleCache[cacheKey]) return Promise.resolve(_moduleCache[cacheKey])
  const loader = resolveLoader(p)
  if (!loader) return Promise.resolve(null)
  return loadRouteModule(loader, p)
    .then((r) => r.mod)
    .catch(() => null)
}

export function isRouteModuleCached(path) {
  return !!_moduleCache[routeModuleCacheKey(path)]
}

async function renderChatRoute(path, hash, thisLoad) {
  setContentVisible(false)
  setChatHostVisible(true)
  // 内容宿主正在随 110ms 退出淡出变透明，等淡出结束再清空，避免淡出中内容瞬间消失；
  // 期间用户切回内容路由（宿主重新可见）则跳过清理
  if (_contentEl) {
    setTimeout(() => {
      if (_contentEl && (_contentEl.hidden || _contentEl.style.display === 'none')) {
        _contentEl.innerHTML = ''
      }
    }, 150)
  }

  const loader = resolveLoader(path)
  if (!loader || !_chatHostEl) {
    removeBootSplash()
    return
  }

  const cacheKey = routeModuleCacheKey(path)
  const routeStarted = Date.now()
  let spinnerEl = null
  let loadInfo = { mod: null, cacheKey, cached: !!_moduleCache[cacheKey], importMs: 0 }
  try {
    if (!_moduleCache[cacheKey] && !isChatAppMounted()) {
      _chatHostEl.innerHTML = ''
      spinnerEl = document.createElement('div')
      spinnerEl.className = 'page-loader'
      spinnerEl.innerHTML = `
      <div class="page-loader-spinner"></div>
      <div class="page-loader-text">加载中...</div>
    `
      _chatHostEl.appendChild(spinnerEl)
      upgradeSlowLoaderText(spinnerEl, routeStarted, 'module')
    }
    loadInfo = await loadRouteModule(loader, path)
  } catch (e) {
    logRouteTiming('error', {
      path,
      cacheKey,
      cached: false,
      importMs: Date.now() - routeStarted,
      error: String(e?.message || e),
    })
    if (thisLoad === _loadId) showLoadError(_chatHostEl, hash, e)
    return
  }

  if (thisLoad !== _loadId) return

  let page
  const renderStarted = typeof performance !== 'undefined' ? performance.now() : Date.now()
  try {
    if (spinnerEl?.isConnected) setLoaderPhase(spinnerEl, 'render', routeStarted)
    const mod = loadInfo.mod
    const renderFn = mod.render || mod.default
    page = renderFn ? await withTimeout(renderFn(), PAGE_RENDER_TIMEOUT_MS, '页面渲染超时') : mod
  } catch (e) {
    console.error('[router] 页面渲染失败:', hash, e)
    delete _moduleCache[cacheKey]
    logRouteTiming('error', {
      path,
      cacheKey,
      cached: loadInfo.cached,
      importMs: loadInfo.importMs,
      renderMs: Math.round(
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) - renderStarted,
      ),
      error: String(e?.message || e),
    })
    if (thisLoad === _loadId) showLoadError(_chatHostEl, hash, e)
    return
  }
  const renderMs = Math.round(
    (typeof performance !== 'undefined' ? performance.now() : Date.now()) - renderStarted,
  )
  logRouteTiming('ok', {
    path,
    cacheKey,
    cached: loadInfo.cached,
    importMs: loadInfo.importMs,
    renderMs,
    totalMs: Date.now() - routeStarted,
  })
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

  // mod 在上方 try 块内声明；这里只能用 loadInfo.mod
  _currentCleanup = loadInfo.mod?.cleanup || null
  updateNavActive(path.split('?')[0])
  window.dispatchEvent(new CustomEvent('evopanel:chat-route-shown'))
  // 侧栏「工作台」从其他页面跳转：pending 标记本由 ChatApp 挂载时消费，
  // 但 ChatApp 是常驻组件、从其他路由切回不会重新挂载 —— 标记会永远滞留，
  // 用户看到的就是普通「新对话」页而不是工作台仪表盘。这里补消费。
  try {
    if (
      window.sessionStorage.getItem('evopanel_pending_open_home') === '1' &&
      isChatAppMounted()
    ) {
      window.sessionStorage.removeItem('evopanel_pending_open_home')
      window.dispatchEvent(new CustomEvent('evopanel:shell-open-home'))
    }
  } catch {
    /* ignore */
  }
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

  // 旧页面保留展示直至新页就绪，消除「内容瞬间消失 → 白屏转圈」的闪变；
  // 未缓存模块时叠一个不挡操作的居中加载指示（.page-loader--overlay）
  const cacheKey = routeModuleCacheKey(path)
  const routeStarted = Date.now()
  const moduleCached = !!_moduleCache[cacheKey]
  let spinnerEl = null
  if (!moduleCached && _contentEl.querySelector(':scope > .page')) {
    spinnerEl = document.createElement('div')
    spinnerEl.className = 'page-loader page-loader--overlay'
    spinnerEl.innerHTML = `
      <div class="page-loader-spinner"></div>
      <div class="page-loader-text">加载中...</div>
    `
    _contentEl.appendChild(spinnerEl)
    upgradeSlowLoaderText(spinnerEl, routeStarted, 'module')
  } else if (!moduleCached) {
    spinnerEl = document.createElement('div')
    spinnerEl.className = 'page-loader'
    spinnerEl.innerHTML = `
      <div class="page-loader-spinner"></div>
      <div class="page-loader-text">加载中...</div>
    `
    _contentEl.appendChild(spinnerEl)
    upgradeSlowLoaderText(spinnerEl, routeStarted, 'module')
  }

  let loadInfo = { mod: null, cacheKey, cached: moduleCached, importMs: 0 }
  try {
    loadInfo = await loadRouteModule(loader, path)
  } catch (e) {
    logRouteTiming('error', {
      path,
      cacheKey,
      cached: false,
      importMs: Date.now() - routeStarted,
      error: String(e?.message || e),
    })
    if (thisLoad === _loadId) showLoadError(_contentEl, hash, e)
    return
  }

  if (thisLoad !== _loadId) return

  let page
  const renderStarted = typeof performance !== 'undefined' ? performance.now() : Date.now()
  try {
    if (spinnerEl?.isConnected) setLoaderPhase(spinnerEl, 'render', routeStarted)
    else if (moduleCached) {
      // Module warm but first paint of this path may still wait on API — light overlay.
      const paintHintAt = Date.now()
      const hintTimer = setTimeout(() => {
        if (thisLoad !== _loadId || !_contentEl) return
        if (_contentEl.querySelector(':scope > .page-loader')) return
        spinnerEl = document.createElement('div')
        spinnerEl.className = 'page-loader page-loader--overlay'
        spinnerEl.innerHTML = `
          <div class="page-loader-spinner"></div>
          <div class="page-loader-text">页面准备中...</div>
        `
        _contentEl.appendChild(spinnerEl)
        upgradeSlowLoaderText(spinnerEl, paintHintAt, 'render')
      }, SLOW_LOADER_HINT_MS)
      // Clear timer once we finish (below); stash on local
      loadInfo._hintTimer = hintTimer
    }
    const mod = loadInfo.mod
    const renderFn = mod.render || mod.default
    page = renderFn ? await withTimeout(renderFn(), PAGE_RENDER_TIMEOUT_MS, '页面渲染超时') : mod
    if (loadInfo._hintTimer) clearTimeout(loadInfo._hintTimer)
  } catch (e) {
    if (loadInfo._hintTimer) clearTimeout(loadInfo._hintTimer)
    console.error('[router] 页面渲染失败:', hash, e)
    delete _moduleCache[cacheKey]
    logRouteTiming('error', {
      path,
      cacheKey,
      cached: loadInfo.cached,
      importMs: loadInfo.importMs,
      renderMs: Math.round(
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) - renderStarted,
      ),
      error: String(e?.message || e),
    })
    if (thisLoad === _loadId) showLoadError(_contentEl, hash, e)
    return
  }
  if (thisLoad !== _loadId) return

  const renderMs = Math.round(
    (typeof performance !== 'undefined' ? performance.now() : Date.now()) - renderStarted,
  )
  logRouteTiming('ok', {
    path,
    cacheKey,
    cached: loadInfo.cached,
    importMs: loadInfo.importMs,
    renderMs,
    totalMs: Date.now() - routeStarted,
  })

  _contentEl.innerHTML = ''
  if (typeof page === 'string') {
    _contentEl.innerHTML = page
  } else if (page instanceof HTMLElement) {
    _contentEl.appendChild(page)
  }

  // mod 在上方 try 块内声明；这里只能用 loadInfo.mod
  _currentCleanup = loadInfo.mod?.cleanup || null
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
      setUiExtensionOpenMode(false)
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
  setUiExtensionOpenMode(isUiExtensionRoute(path))

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
