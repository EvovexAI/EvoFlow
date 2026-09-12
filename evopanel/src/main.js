/**
 * EvoFlow 桌面端入口
 */
import { registerRoute, initRouter, navigate, setDefaultRoute, removeBootSplash, isAuthRoute } from './router.js'
import { initShellAside, openMobileShellAside } from './components/shell-aside.js'
import { initTheme, attachSystemThemeListener } from './lib/theme.js'
import { initFontSizePreference } from './lib/font-size.js'
import { initAccentThemePreference } from './lib/accent-theme.js'
import { initAppearanceBackground, applyBackgroundPreference } from './lib/appearance-background.js'
import { initLiquidGlass } from './lib/liquid-glass/index.js'
import { initPanelSettings, reloadPanelSettings, getPanelSetting, patchPanelSettings } from './lib/panel-settings.js'
import { initPanelAppearanceSync } from './lib/panel-appearance-sync.js'
import { loadActiveInstance, getActiveInstance, onInstanceChange, startGatewayPoll } from './lib/app-state.js'
import { wsClient } from './lib/ws-client.js'
import { api, checkBackendHealth, checkBackendReady, getDesktopBootId, isBackendOnline, kickAppServerPrewarm, onBackendStatusChange } from './lib/tauri-api.js'
import { version as APP_VERSION } from '../package.json'
import { statusIcon } from './lib/icons.js'
import { tryShowEngagement } from './components/engagement.js'
import {
  isTauri,
  checkAuth,
  showLoginOverlay,
  installEvopanelGlobalLoginHandler,
  LOGIN_LOGO_SVG as _logoSvg,
} from './lib/panel-login.js'
import { installConsoleFileLog } from './lib/console-file-log.js'
import { bootMark, bootPrintSummary } from './lib/startup-trace.js'
import { initDesktopNotifications } from './lib/desktop-notification.js'
import { initDesktopContextMenu } from './lib/desktop-context-menu.js'
import { initDesktopDevtoolsHotkey } from './lib/desktop-devtools-hotkey.js'

installConsoleFileLog()
bootMark('main module eval')
if (isTauri) initDesktopNotifications()
if (isTauri) initDesktopContextMenu()
if (isTauri) initDesktopDevtoolsHotkey()

// Pause infinite CSS when the window is occluded (Mac battery / compositor).
const syncAppOccluded = () => {
  try {
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
    if (hidden) document.documentElement.setAttribute('data-app-occluded', '1')
    else document.documentElement.removeAttribute('data-app-occluded')
  } catch {
    /* ignore */
  }
}
syncAppOccluded()
document.addEventListener('visibilitychange', syncAppOccluded)

// 关掉历史遗留的 SkillHub 原生悬浮 WebView（曾遮挡整个客户端）
if (isTauri) {
  const killSkillhubEmbed = () =>
    import('./lib/browser-embed-client.js')
      .then((m) => m.browserEmbedClose('skillhub-store'))
      .catch(() => {})
  void killSkillhubEmbed()
  window.addEventListener('hashchange', () => { void killSkillhubEmbed() })
}

// 动态 import 偶发失败（Vite HMR/缓存失效/网络抖动）时，自动重载一次避免页面卡死。
const DYNAMIC_IMPORT_RECOVERY_KEY = 'evopanel_dynamic_import_recovered'
window.addEventListener('unhandledrejection', (ev) => {
  const msg = String((ev && ev.reason && (ev.reason.message || ev.reason)) || '')
  if (!/Failed to fetch dynamically imported module/i.test(msg)) return
  const recovered = sessionStorage.getItem(DYNAMIC_IMPORT_RECOVERY_KEY) === '1'
  if (recovered) return
  try {
    sessionStorage.setItem(DYNAMIC_IMPORT_RECOVERY_KEY, '1')
  } catch {}
   
  console.warn('[boot] dynamic import failed, reloading once:', msg)
  window.location.reload()
})
window.setTimeout(() => {
  try { sessionStorage.removeItem(DYNAMIC_IMPORT_RECOVERY_KEY) } catch {}
}, 15000)

// 样式
import './style/variables.css'
import './style/reset.css'
import './style/layout.css'
import './style/components.css'
import './style/pages.css'
import './style/ef-side-drawer.css'
import './style/app-workflow-canvas.css'
import './style/app-workflow-studio-v2.css'
import './style/apps.css'
import './style/kb-wiki.css'
import './style/list-pager.css'
import './style/webui-login.css'
import './style/chat.css'
import './style/react-chat.css'
import './style/platform-feedback.css'
import './style/chat-redesign.css'
import './style/enterprise-workspace.css'
import './style/hover-bubble.css'
import './style/agents.css'
import './style/agent-avatar.css'
import './style/debug.css'
import './style/agent-trace.css'
import './style/obs-dashboard.css'
import './style/ai-drawer.css'
import './style/cron.css'
import './style/license-keys.css'
import './style/tauri-titlebar.css'
import './style/proactive.css'
import './style/license.css'
import './components/global-assistant/global-assistant.css'
import './style/ai-roundtable.css'
import './style/liquid-glass.css'
import './style/theme-surfaces.css'
import './style/assets-page.css'
import './style/theme-readability.css'
import './style/ef-module-head.css'
import './style/ef-panel-head.css'

// 初始化主题与面板设置（SQLite evoflow_app_settings / panel.ui）
initTheme()
initFontSizePreference()
initAccentThemePreference()
attachSystemThemeListener()
// 先等面板设置加载完成再初始化背景外观（透明效果、背景图等），
// 避免默认值覆盖用户已持久化的 transparency/opacity 设置
void initPanelSettings().then(() => {
  initAppearanceBackground()
  applyBackgroundPreference()
  initLiquidGlass()
})
initPanelAppearanceSync()

// === 访问密码保护（Web + 桌面端通用） ===
if (typeof document !== 'undefined' && isTauri) {
  document.documentElement.classList.add('evopanel-tauri')
}

installEvopanelGlobalLoginHandler()

// === 后端离线检测（Web 模式） ===
let _backendRetryTimer = null
let _backendReadyPollTimer = null

function showBackendWarmingBanner() {
  // Do NOT insert a fixed full-width bar at body top — it covers the frameless
  // title drag region and blocks window move. Status lives in chat header /
  // composer (engineReady) and optionally in #tauri-main-chrome.
  const chrome = document.getElementById('tauri-main-chrome')
  if (!chrome) return
  let el = document.getElementById('backend-warming-banner')
  if (!el) {
    el = document.createElement('div')
    el.id = 'backend-warming-banner'
    el.className = 'tauri-main-chrome-status'
    el.setAttribute('role', 'status')
    el.setAttribute('data-tauri-drag-region', '')
    el.textContent = '引擎加载中…'
    const drag = chrome.querySelector('.tauri-main-chrome-drag')
    if (drag) drag.appendChild(el)
    else chrome.insertBefore(el, chrome.firstChild)
  }
}

function hideBackendWarmingBanner() {
  document.getElementById('backend-warming-banner')?.remove()
}

function startBackendReadyPoll() {
  if (!isTauri || _backendReadyPollTimer) return
  // Prefer injecting into chrome after boot; retry a few times if chrome not yet mounted.
  const tryShow = () => {
    showBackendWarmingBanner()
    if (!document.getElementById('backend-warming-banner') && document.getElementById('tauri-main-chrome')) {
      showBackendWarmingBanner()
    }
  }
  tryShow()
  setTimeout(tryShow, 400)
  let attempts = 0
  let everHealthy = false
  const maxAttempts = 240 // ~120s at 500ms
  const WARMING_TIMEOUT_ATTEMPTS = 180 // ~90s at 500ms
  const tick = async () => {
    attempts += 1
    if (await checkBackendReady()) {
      everHealthy = true
      hideBackendWarmingBanner()
      try {
        removeBootSplash()
      } catch {
        /* ignore */
      }
      if (_backendReadyPollTimer) {
        clearInterval(_backendReadyPollTimer)
        _backendReadyPollTimer = null
      }
      bootMark('backend ready ok (async poll)')
      void import('./lib/startup-trace.js')
        .then((m) => m.bootMarkEngineReady?.({ source: 'ready-poll' }))
        .catch(() => {})
      return
    }
    const healthOk = await checkBackendHealth()
    if (healthOk) {
      everHealthy = true
      // 仍未 /ready：续冷启动 hold，避免 LG lifespan 卡事件循环时被 guardian 杀掉
      void import('./lib/gateway-guardian-busy.js')
        .then((m) => m.markGatewayColdStartHold?.(90_000))
        .catch(() => {})
      // Runtime: warm stdio as soon as alive; /ready stays async for send gate only.
      void kickAppServerPrewarm('ready-poll-liveness').then((ok) => {
        if (ok) bootMark('app-server prewarm ok (liveness)')
      })
      return
    }
    if (everHealthy) {
      // 真故障（起过又挂了）
      hideBackendWarmingBanner()
      if (_backendReadyPollTimer) {
        clearInterval(_backendReadyPollTimer)
        _backendReadyPollTimer = null
      }
      showBackendDownOverlay()
      return
    }
    if (attempts >= WARMING_TIMEOUT_ATTEMPTS) {
      // 超时故障：从未健康过且超过 90s
      hideBackendWarmingBanner()
      if (_backendReadyPollTimer) {
        clearInterval(_backendReadyPollTimer)
        _backendReadyPollTimer = null
      }
      bootMark('backend ready timeout (async poll)')
      showBackendDownOverlay()
    }
    // 其余：保持 warming 横幅继续轮询
  }
  void tick()
  _backendReadyPollTimer = setInterval(tick, 500)
}

function showBackendDownOverlay() {
  hideBackendWarmingBanner()
  removeBootSplash()
  if (document.getElementById('backend-down-overlay')) return
  const desktopHint = isTauri
    ? `
      <div style="background:var(--bg-tertiary);border-radius:var(--radius-md,8px);padding:14px 18px;margin:16px 0;text-align:left;font-family:var(--font-mono,monospace);font-size:12px;line-height:1.8;user-select:all;color:var(--text-secondary)">
        <div style="color:var(--text-tertiary);margin-bottom:4px"># 全周期时序（打开→引擎就绪）</div>
        <code style="display:block;white-space:pre-wrap;word-break:break-all;background:var(--bg-tertiary);padding:8px;border-radius:6px;font-size:11px;line-height:1.5">%USERPROFILE%\\.evoflow\\logs\\boot-cycle.log
# 搜 [BOOT-CYCLE] ；同时可看 gateway-startup / evopanel-startup / [BOOT]</code>
        ~/.evoflow/logs/evopanel-startup.log<br>
        ~/.evoflow/logs/evoflow-gateway-&lt;日期&gt;.log<br>
        ~/.evoflow/logs/langgraph-&lt;日期&gt;.log<br>
        ~/.evoflow/logs/frontend-&lt;日期&gt;.log
      </div>
      <button class="login-btn" id="btn-open-system-logs" type="button" style="margin-top:4px;background:transparent;border:1px solid var(--border);color:var(--text-secondary)">
        打开系统日志
      </button>
    `
    : `
      <div style="background:var(--bg-tertiary);border-radius:var(--radius-md,8px);padding:14px 18px;margin:16px 0;text-align:left;font-family:var(--font-mono,monospace);font-size:12px;line-height:1.8;user-select:all;color:var(--text-secondary)">
        <div style="color:var(--text-tertiary);margin-bottom:4px"># 开发模式</div>
        npm run dev<br>
        <div style="color:var(--text-tertiary);margin-top:8px;margin-bottom:4px"># 生产模式</div>
        npm run preview
      </div>
    `
  const overlay = document.createElement('div')
  overlay.id = 'backend-down-overlay'
  overlay.innerHTML = `
    <div class="login-card" style="text-align:center">
      ${_logoSvg}
      <div class="login-title" style="color:var(--error,#ef4444)">后端未启动</div>
      <div class="login-desc" style="line-height:1.8">
        ${isTauri ? '内置后端仍在启动或已异常退出。' : 'EvoFlow 后端服务未运行，无法获取真实数据。'}<br>
        <span style="font-size:12px;color:var(--text-tertiary)">${isTauri ? '请点击重新检测，或查看日志定位启动失败原因。' : '请在服务器上启动后端服务后刷新页面。'}</span>
      </div>
      ${desktopHint}
      <button class="login-btn" id="btn-backend-retry" style="margin-top:8px">
        <span id="backend-retry-text">重新检测</span>
      </button>
      <div id="backend-retry-status" style="font-size:12px;color:var(--text-tertiary);margin-top:12px"></div>
      ${isTauri && window.__yt_last_gateway_error ? `
        <div style="margin-top:10px;padding:10px 12px;background:var(--bg-tertiary);border-radius:8px;font-size:12px;color:var(--error,#ef4444);text-align:left;line-height:1.6;word-break:break-all">
          最近错误：${String(window.__yt_last_gateway_error).replace(/</g, '&lt;')}
        </div>
      ` : ''}
      <div style="margin-top:16px;font-size:11px;color:#aaa">
        v${APP_VERSION}
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  let retrying = false
  const btn = overlay.querySelector('#btn-backend-retry')
  const statusEl = overlay.querySelector('#backend-retry-status')
  const textEl = overlay.querySelector('#backend-retry-text')

  btn.addEventListener('click', async () => {
    if (retrying) return
    retrying = true
    btn.disabled = true
    textEl.textContent = '检测中...'
    statusEl.textContent = ''

    const ok = await checkBackendHealth()
    if (ok) {
      const ready = await checkBackendReady()
      statusEl.textContent = ready ? '后端已连接，正在加载...' : 'Agent 引擎仍在加载…'
      statusEl.style.color = 'var(--success,#22c55e)'
      overlay.classList.add('hide')
      setTimeout(() => { overlay.remove(); if (ready) location.reload() }, 600)
    } else {
      statusEl.textContent = '后端仍未响应，请确认服务已启动'
      statusEl.style.color = 'var(--error,#ef4444)'
      textEl.textContent = '重新检测'
      btn.disabled = false
      retrying = false
    }
  })

  overlay.querySelector('#btn-open-system-logs')?.addEventListener('click', () => {
    try {
      if (_backendRetryTimer) {
        clearInterval(_backendRetryTimer)
        _backendRetryTimer = null
      }
    } catch (_) {}
    overlay.remove()
    window.location.hash = '/logs'
  })

  // 自动轮询：每 5 秒检测一次
  if (_backendRetryTimer) clearInterval(_backendRetryTimer)
  _backendRetryTimer = setInterval(async () => {
    const ok = await checkBackendHealth()
    if (ok) {
      clearInterval(_backendRetryTimer)
      _backendRetryTimer = null
      const ready = await checkBackendReady()
      statusEl.textContent = ready ? '后端已连接，正在加载...' : 'Agent 引擎仍在加载…'
      statusEl.style.color = 'var(--success,#22c55e)'
      overlay.classList.add('hide')
      setTimeout(() => { overlay.remove(); if (ready) location.reload() }, 600)
    }
  }, 2000)
}

const content = document.getElementById('content')

let chatRouteModulePromise = null
let obsRouteModulePromise = null
let evalRouteModulePromise = null

async function createEvalRouteModule() {
  if (evalRouteModulePromise) return evalRouteModulePromise
  evalRouteModulePromise = (async () => {
    const { createRoot } = await import('react-dom/client')
    const React = await import('react')
    const EvalModule = await import('./react/eval/EvalApp.tsx')
    const EvalApp = EvalModule.default
    let evalReactRoot = null
    let originalAsideDisplay = null
    return {
      render: () => {
        const appShellAside = document.getElementById('app-shell-aside')
        const mainCol = document.getElementById('main-col')
        originalAsideDisplay = appShellAside?.style.display
        if (appShellAside) appShellAside.style.display = 'none'
        if (mainCol) mainCol.style.display = 'none'
        document.body.classList.add('eval-fullscreen-mode')

        document.getElementById('eval-fullscreen-root')?.remove()
        if (evalReactRoot) {
          try {
            evalReactRoot.unmount()
          } catch {
            /* ignore */
          }
          evalReactRoot = null
        }
        const container = document.createElement('div')
        container.id = 'eval-fullscreen-root'
        Object.assign(container.style, {
          position: 'fixed',
          inset: '0',
          zIndex: '9999',
          overflow: 'auto',
        })
        document.body.appendChild(container)
        evalReactRoot = createRoot(container)
        evalReactRoot.render(React.createElement(EvalApp))
      },
      cleanup: () => {
        const appShellAside = document.getElementById('app-shell-aside')
        const mainCol = document.getElementById('main-col')
        if (appShellAside && originalAsideDisplay !== null) {
          appShellAside.style.display = originalAsideDisplay
        }
        if (mainCol) mainCol.style.display = ''
        document.body.classList.remove('eval-fullscreen-mode')
        document.getElementById('eval-fullscreen-root')?.remove()
        if (!evalReactRoot) return
        try {
          evalReactRoot.unmount()
        } catch {
          /* ignore */
        }
        evalReactRoot = null
      },
    }
  })()
  try {
    return await evalRouteModulePromise
  } catch (e) {
    evalRouteModulePromise = null
    throw e
  }
}

async function createObsRouteModule() {
  if (obsRouteModulePromise) return obsRouteModulePromise
  obsRouteModulePromise = (async () => {
    const { createRoot } = await import('react-dom/client')
    const React = await import('react')
    const ObsModule = await import('./react/obs/ObsDashboardApp.tsx')
    const ObsDashboardApp = ObsModule.default
    let obsReactRoot = null
    let originalAsideDisplay = null
    let originalBodyClass = null
    return {
      render: () => {
        // 隐藏主界面侧边栏和外层容器，让 observability 独立全屏
        const appShellAside = document.getElementById('app-shell-aside')
        const mainCol = document.getElementById('main-col')
        originalAsideDisplay = appShellAside?.style.display
        originalBodyClass = document.body.className
        if (appShellAside) appShellAside.style.display = 'none'
        if (mainCol) mainCol.style.display = 'none'
        document.body.classList.add('obs-fullscreen-mode')

        document.getElementById('obs-fullscreen-root')?.remove()
        if (obsReactRoot) {
          try {
            obsReactRoot.unmount()
          } catch {
            /* ignore */
          }
          obsReactRoot = null
        }
        const container = document.createElement('div')
        container.id = 'obs-fullscreen-root'
        Object.assign(container.style, {
          position: 'fixed',
          inset: '0',
          zIndex: '9999',
          overflow: 'auto',
        })
        document.body.appendChild(container)
        obsReactRoot = createRoot(container)
        obsReactRoot.render(React.createElement(ObsDashboardApp))
        // 挂在 body 上全屏展示；勿 return DOM，否则 router 会把它塞进被隐藏的 #main-col
      },
      cleanup: () => {
        // 恢复主界面显示
        const appShellAside = document.getElementById('app-shell-aside')
        const mainCol = document.getElementById('main-col')
        if (appShellAside && originalAsideDisplay !== null) {
          appShellAside.style.display = originalAsideDisplay
        }
        if (mainCol) mainCol.style.display = ''
        document.body.classList.remove('obs-fullscreen-mode')
        const fullscreenRoot = document.getElementById('obs-fullscreen-root')
        if (fullscreenRoot) {
          fullscreenRoot.remove()
        }
        if (!obsReactRoot) return
        try {
          obsReactRoot.unmount()
        } catch {
          /* ignore */
        }
        obsReactRoot = null
      },
    }
  })()
  try {
    return await obsRouteModulePromise
  } catch (e) {
    obsRouteModulePromise = null
    throw e
  }
}

async function createAgentTraceRouteModule() {
  const hash = window.location.hash.slice(1) || ''
  const qs = hash.includes('?') ? new URLSearchParams(hash.split('?')[1]) : null
  if (qs?.get('thread_id')) {
    return import('./pages/agent-trace.js')
  }
  navigate('/observability')
  return {
    render() {
      const el = document.createElement('div')
      el.hidden = true
      return el
    },
  }
}

async function createAgentsRedirectModule() {
  navigate('/expert')
  return {
    render() {
      const el = document.createElement('div')
      el.hidden = true
      return el
    },
  }
}

async function createOperationsRedirectModule() {
  navigate('/observability')
  return {
    render() {
      const el = document.createElement('div')
      el.hidden = true
      return el
    },
  }
}

async function resolveChatAppComponent() {
  const mod = await import('./react/ChatApp.tsx')
  const Comp = mod.default
  if (typeof Comp === 'function') return Comp
  throw new Error(
    '[chat] ChatApp 默认导出无效（常见原因：Vite 热更新/缓存损坏）。请 Ctrl+Shift+R 强刷或重启 evopanel。',
  )
}

async function createChatRouteModule() {
  if (chatRouteModulePromise) return chatRouteModulePromise
  chatRouteModulePromise = (async () => {
    const { createRoot } = await import('react-dom/client')
    const React = await import('react')
    // 导出 render 函数，每次调用都重新创建 React 应用
    // 确保从其他页面跳转回来时组件能正确初始化
    let chatReactRoot = null
    let chatContainerEl = null
    let renderInflight = null
    return {
      render: async () => {
        if (renderInflight) return renderInflight
        renderInflight = (async () => {
          try {
            if (chatReactRoot && chatContainerEl?.isConnected) {
              return chatContainerEl
            }
            if (chatReactRoot) {
              try {
                chatReactRoot.unmount()
              } catch {
                /* ignore */
              }
              chatReactRoot = null
              chatContainerEl = null
            }
            const ChatApp = await resolveChatAppComponent()
            chatContainerEl = document.createElement('div')
            chatContainerEl.style.height = '100%'
            chatReactRoot = createRoot(chatContainerEl)
            chatReactRoot.render(React.createElement(ChatApp))
            return chatContainerEl
          } finally {
            renderInflight = null
          }
        })()
        return renderInflight
      },
      cleanup: () => {
        // 只隐藏，绝不清空宿主；ChatApp 单例必须常驻
        const host = document.getElementById('chat-persistent-host')
        if (host) {
          host.hidden = true
          host.style.display = 'none'
        }
        try {
          // 与 router.setChatHostVisible(false) 对齐；若路由稍后也会调，幂等即可
          void import('./react/lib/client-perf.js').then((m) => m.setChatSurfaceVisible(false))
        } catch {
          /* ignore */
        }
      },
    }
  })()
  try {
    return await chatRouteModulePromise
  } catch (e) {
    chatRouteModulePromise = null
    throw e
  }
}

async function ensureChatAppMounted() {
  const host = document.getElementById('chat-persistent-host')
  if (!host) return
  bootMark('ensureChatAppMounted begin')
  try {
    const mod = await createChatRouteModule()
    const page = await mod.render()
    if (page instanceof HTMLElement && page.parentElement !== host) {
      host.replaceChildren(page)
    }
    bootMark('ensureChatAppMounted done')
  } catch (e) {
    bootMark('ensureChatAppMounted failed', { error: String(e?.message || e) })
    console.warn('[boot] ensureChatAppMounted', e)
  }
}

async function boot() {
  bootMark('boot() enter')
  try {
    const { consumeAccountSwitchFlag, refreshMe } = await import('./lib/account-session.js')
    if (consumeAccountSwitchFlag()) {
      bootMark('account switch caches cleared')
    }
    // Warm identity early so chat send / shell chip don't race on null me.
    void refreshMe({ retries: 2 }).catch(() => {})
  } catch (e) {
    console.warn('[boot] account-session warm failed', e)
  }
  const initialPath = (window.location.hash.slice(1) || '/chat').split('?')[0]
  const authOnlyBoot = !isTauri && isAuthRoute(initialPath)

  setDefaultRoute('/chat')
  // 先注册所有路由，立即渲染 UI（不等后端检测）
  // 只使用 React 版本的 ChatApp
  registerRoute('/chat', createChatRouteModule)
  registerRoute('/me', () => import('./pages/mobile-me.js'))
  // 后台预热 Chat 首包，减少首次进入 #/chat 时的模块加载超时
  void createChatRouteModule().catch(() => {})
  registerRoute('/models', () => import('./pages/models.js'))
  registerRoute('/agents', createAgentsRedirectModule)
  registerRoute('/agents/team/:code', createAgentsRedirectModule)
  registerRoute('/assets', () => import('./pages/assets.js'))
  registerRoute('/memory', () => import('./pages/assets.js'))
  registerRoute('/memory/atoms', () => import('./pages/assets.js'))
  registerRoute('/skills', () => import('./pages/assets.js'))
  registerRoute('/skills/market', () => import('./pages/skills.js'))
  // Owned KB is the default knowledge home; Obsidian vaults under /knowledge/vaults
  registerRoute('/knowledge', () => import('./pages/knowledge-owned.js'))
  registerRoute('/knowledge/vaults', () => import('./pages/knowledge-vaults.js'))
  registerRoute('/knowledge/owned', () => import('./pages/knowledge-owned.js'))
  registerRoute('/knowledge/owned/:id', () => import('./pages/knowledge-owned.js'))
  registerRoute('/tools', () => import('./pages/tools.js'))
  registerRoute('/expert', () => import('./pages/expert.js'))
  registerRoute('/about', () =>
    Promise.resolve({
      render() {
        setTimeout(() => {
          const path = (window.location.hash.slice(1) || '').split('?')[0]
          if (path === '/about') window.location.hash = '/settings'
        }, 0)
        const el = document.createElement('div')
        el.hidden = true
        return el
      },
    }),
  )
  registerRoute('/channels', () => import('./pages/channels.js'))
  registerRoute('/cron', () => import('./pages/cron.js'))
  registerRoute('/automation', () => import('./pages/cron.js'))
  registerRoute('/proactive', () => import('./pages/proactive.js'))
  registerRoute('/proactive/board', () => import('./pages/proactive-work-board.js'))
  registerRoute('/proactive/:code', () => import('./pages/proactive-employee.js'))
  registerRoute('/proactive/:code/item/:itemId', () => import('./pages/proactive-employee.js'))
  registerRoute('/proactive/:code/work/:taskId', () => import('./pages/proactive-employee.js'))
  registerRoute('/runs/:runId', () => import('./pages/proactive-run.js'))
  registerRoute('/general', () => import('./pages/general.js'))
  registerRoute('/mail', () => import('./pages/mail.js'))
  registerRoute('/settings', () => import('./pages/settings.js'))
  // WebUI remote-access login pages
  registerRoute('/login', () => import('./pages/login.js'))
  registerRoute('/qr-login', () => import('./pages/login.js'))
  registerRoute('/auth/callback', () => import('./pages/login.js'))
  registerRoute('/apps', () => import('./pages/apps.js'))
  registerRoute('/apps/:id/run', () => import('./pages/apps-run.js'))
  registerRoute('/apps/:id/history', () => import('./pages/apps-history.js'))
  registerRoute('/apps/:id', () => import('./pages/apps-detail.js'))
  registerRoute('/tasks', () => import('./pages/tasks.js'))
  registerRoute('/items', () => import('./pages/items.js'))
  registerRoute('/task/:id', () => import('./pages/task-detail.js'))
  registerRoute('/share/:id', () => import('./pages/share-view.js'))
  registerRoute('/extensions', () => import('./pages/extensions.js'))
  registerRoute('/extensions/:id', () => import('./pages/ui-extension-shell.js'))
  registerRoute('/workflow/:id', () => import('./pages/workflow.js'))
  registerRoute('/bench/stream-perf', () => import('./pages/bench-stream-perf.js'))
  registerRoute('/bench/dual-session-perf', () => import('./pages/bench-dual-session-perf.js'))
  registerRoute('/observability', createObsRouteModule)
  registerRoute('/logs', () => import('./pages/system-logs.js'))
  registerRoute('/system-logs', () => import('./pages/system-logs.js'))
  registerRoute('/eval', createEvalRouteModule)
  registerRoute('/license-keys', () => import('./pages/license-keys.js'))
  void createObsRouteModule().catch(() => {})
  void createEvalRouteModule().catch(() => {})
  registerRoute('/debug/agent-trace', createAgentTraceRouteModule)
  registerRoute('/operations', createOperationsRedirectModule)
  bootMark('routes registered')

  if (!authOnlyBoot) {
    // License entitlements before shell nav (tasks/apps/proactive)
    try {
      const { refreshLicenseStatus } = await import('./lib/license.js')
      await refreshLicenseStatus()
    } catch (e) {
      console.warn('[boot] license status unavailable', e)
    }
    initShellAside(document.getElementById('app-shell-aside'))
    // 窄屏底部导航（宽屏不显示）
    try {
      const { initMobileTabbar } = await import('./components/mobile-tabbar.js')
      initMobileTabbar()
    } catch (e) {
      console.warn('[boot] initMobileTabbar failed', e)
    }
    // 侧栏 Portal 依赖 ChatApp 单例；须在 router 渲染 /chat 之前挂载，避免双实例各写一份列表
    await ensureChatAppMounted()
    try {
      const { installClientPerfHook } = await import('./react/lib/client-perf-hook.js')
      installClientPerfHook()
    } catch (e) {
      console.warn('[boot] client perf hook failed', e)
    }
    // 小V全局浮动助手：挂在 body，路由切换不卸载；登录页自动隐藏
    try {
      const { mountGlobalAssistant } = await import('./components/global-assistant/index.js')
      mountGlobalAssistant()
      // 再挂一次兜底（Chat 首屏晚于 boot 时）
      requestAnimationFrame(() => {
        try {
          mountGlobalAssistant()
        } catch {
          /* ignore */
        }
      })
    } catch (e) {
      console.warn('[boot] mountGlobalAssistant failed', e)
    }
  }
  initRouter(content, { chatHostEl: document.getElementById('chat-persistent-host') })
  bootMark('initRouter done')

  if (isTauri) {
    void import('./lib/background-voice.js').then(({ initBackgroundVoice }) => initBackgroundVoice())
  }

  // 全屏开场层见 index.html #boot-splash，由 router 首屏渲染后再淡出移除

  const mainCol = document.getElementById('main-col')
  if (!authOnlyBoot && mainCol) {
    // 移动端顶栏（汉堡菜单 + 标题）
    const topbar = document.createElement('div')
    topbar.className = 'mobile-topbar'
    topbar.id = 'mobile-topbar'
    topbar.innerHTML = `
    <button class="mobile-hamburger" id="btn-mobile-menu">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    </button>
    <span class="mobile-topbar-title">EvoFlow</span>
  `
    topbar.querySelector('.mobile-hamburger').addEventListener('click', openMobileShellAside)
    mainCol.prepend(topbar)
    /* 桌面无边框：窗口控制条插在主列最顶（在 mobile-topbar 之上），#/chat 时隐藏（控制钮已在 ChatApp 顶栏） */
    if (isTauri) {
      void import('./lib/tauri-titlebar.js').then((m) => m.initTauriFramelessChrome(mainCol, topbar))
    }
  }

  if (authOnlyBoot) return

  // 默认密码提醒横幅
  // Tauri 模式：确保 web session 存在（页面刷新后 cookie 可能丢失），然后加载实例和检测状态
  // Web dev-api 用 cookie 会话；桌面端仅用 sessionStorage，勿请求不存在的 /__api/*
  const ensureWebSession = !isTauri
    ? api.readPanelConfig().then(cfg => {
        if (cfg.accessPassword) {
          return fetch('/__api/auth_login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: cfg.accessPassword }),
          }).catch(() => {})
        }
      }).catch(() => {})
    : Promise.resolve()

  ensureWebSession.then(() => loadActiveInstance()).then(async () => {
    try {
      const { attachClientToGateway } = await import('./lib/client-presence.js')
      await attachClientToGateway()
    } catch (e) {
      console.warn('[evopanel] client attach failed (session cleanup skipped):', e)
    }
    if (window.location.hash === '#/setup' || window.location.hash === '#/dashboard') navigate('/chat')
    // evoflow 前端不再执行 evoflow/gateway 状态检查与自动连接逻辑

    // === 首次启动引导: 检测是否配置了模型 ===
    try {
      const listRes = await api.listModels()
      const models = Array.isArray(listRes?.models) ? listRes.models : []
      const hasModels = models.length > 0
      const isFirstRun = !sessionStorage.getItem('evopanel_has_run_before')
      // 只要检测过一次就标记已运行，避免每次刷新都判断为首次
      if (isFirstRun) {
        sessionStorage.setItem('evopanel_has_run_before', '1')
      }

      if (isFirstRun && !hasModels) {
        // 首次启动且没有配置模型,引导用户去配置
        navigate('/models')

        // 显示友好提示
        const { toast } = await import('./components/toast.js')
        toast('👋 欢迎使用 EvoFlow! 请先配置至少一个 AI 模型', 'info', 5000)
      }
    } catch {
      // 检测失败,静默忽略,不影响正常使用
    }

    // 实例切换时，重连 WebSocket + 重新检测状态
    onInstanceChange(async () => {
      wsClient.disconnect()
      autoConnectWebSocket()
    })

    // 全局监听后台任务完成/失败事件，自动刷新安装状态和侧边栏
    if (window.__TAURI_INTERNALS__) {
      import('@tauri-apps/api/event').then(async ({ listen }) => {
        const refreshAfterTask = async () => {
          // 清除 API 缓存，确保拿到最新状态
          const { invalidate } = await import('./lib/tauri-api.js')
          invalidate('get_version_info')
          if (window.location.hash === '#/setup' || window.location.hash === '#/dashboard') {
            navigate('/chat')
          }
        }
        await listen('upgrade-done', refreshAfterTask)
        await listen('upgrade-error', refreshAfterTask)
      }).catch(() => {})
    }
  })
}

async function autoConnectWebSocket() {
  // 旧项目的 Gateway WebSocket 自动连接逻辑已停用（避免硬编码 127.0.0.1:18789 等约定）
}

// === 全局版本更新检测（Windows 桌面端优先一键安装） ===
const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000 // 30 分钟
let _updateCheckTimer = null
/** @type {import('./lib/update-manager.js').UpdateOffer | null} */
let _pendingUpdateOffer = null
let _updateInstallInProgress = false
let _updateUiState = 'available' // available | downloading | ready

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function resolveUpdateOfferLocal() {
  const { resolveUpdateOffer } = await import('./lib/update-manager.js')
  return resolveUpdateOffer()
}

function bindUpdateBannerActions(banner, offer) {
  banner.querySelector('#btn-update-dismiss')?.addEventListener('click', () => {
    if (_updateInstallInProgress) return
    sessionStorage.setItem('evopanel_update_dismissed', offer.ver)
    banner.classList.add('update-banner-hidden')
  })

  banner.querySelector('#btn-update-skip-version')?.addEventListener('click', () => {
    if (_updateInstallInProgress) return
    sessionStorage.setItem('evopanel_update_dismissed', offer.ver)
    void patchPanelSettings({ dismissedUpdateVersion: offer.ver })
    banner.classList.add('update-banner-hidden')
  })

  banner.querySelector('#btn-update-install')?.addEventListener('click', () => {
    void runBannerUpdateAction(banner, 'download-and-install')
  })

  banner.querySelector('#btn-update-restart')?.addEventListener('click', () => {
    void runBannerUpdateAction(banner, 'install-now')
  })

  banner.querySelector('#btn-update-apply-frontend')?.addEventListener('click', () => {
    void runBannerUpdateAction(banner, 'frontend-apply')
  })
}

function renderUpdateBanner(banner, offer) {
  _pendingUpdateOffer = offer
  const ready = _updateUiState === 'ready'
  const downloading = _updateUiState === 'downloading' || _updateInstallInProgress
  const lockDismiss = downloading || ready

  const isFrontend = offer.kind === 'frontend-only'
  const primaryLabel = ready
    ? (isFrontend ? '立即应用' : '立即重启')
    : (isFrontend ? '立即更新界面' : (offer.oneClick ? '一键更新' : '下载安装包'))
  const primaryId = ready
    ? (isFrontend ? 'btn-update-apply-frontend' : 'btn-update-restart')
    : 'btn-update-install'

  banner.classList.remove('update-banner-hidden')
  banner.classList.toggle('update-banner-downloading', downloading || ready)
  banner.innerHTML = `
    <div class="update-banner-content">
      <div class="update-banner-text">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        <span class="update-banner-ver">${ready ? '更新已就绪' : `EvoFlow v${escapeHtml(offer.ver)} 可用`}</span>
        ${!ready && offer.changelog ? `<span class="update-banner-changelog">· ${escapeHtml(offer.changelog)}</span>` : ''}
        ${ready && !isFrontend ? '<span class="update-banner-changelog">· 重启后完成更新</span>' : ''}
        <div class="update-progress-wrap update-progress-hidden" id="update-banner-progress">
          <div class="update-progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
            <div class="update-progress-bar-fill" style="width:0%"></div>
          </div>
          <span class="update-progress-text"></span>
        </div>
      </div>
      ${offer.oneClick
    ? `<button type="button" class="btn btn-sm" id="${primaryId}">${primaryLabel}</button>`
    : `<a class="btn btn-sm" href="${escapeHtml(offer.manualUrl)}" target="_blank" rel="noopener">下载安装包</a>`}
      <a class="btn btn-sm btn-secondary" href="https://github.com/EvovexAI/EvoFlow/releases" target="_blank" rel="noopener">更新说明</a>
      ${lockDismiss ? '' : '<button type="button" class="btn btn-sm" id="btn-update-skip-version" title="本版本不再提示">本版本不再提示</button>'}
      ${lockDismiss ? '' : '<button type="button" class="update-banner-close" id="btn-update-dismiss" title="本次关闭">✕</button>'}
    </div>
  `

  bindUpdateBannerActions(banner, offer)
}

async function runBannerUpdateProgress(banner, progress) {
  const { applyUpdateProgressUi } = await import('./lib/update-progress.js')
  const root = banner.querySelector('#update-banner-progress')
  if (!root) return
  root.classList.remove('update-progress-hidden')
  applyUpdateProgressUi(root, progress)
}

async function runBannerUpdateAction(banner, action) {
  const offer = _pendingUpdateOffer
  if (!offer || _updateInstallInProgress) return

  const { runUpdateInstall, isUpdateReadyToInstall } = await import('./lib/update-manager.js')
  const onProgress = (p) => { void runBannerUpdateProgress(banner, p) }

  if (action === 'download-and-install' && isUpdateReadyToInstall(offer)) {
    action = 'install-now'
  }

  const btn = banner.querySelector('#btn-update-install, #btn-update-restart, #btn-update-apply-frontend')
  if (btn) {
    btn.disabled = true
    btn.textContent = action === 'install-now' ? '正在重启…' : '准备中…'
  }

  _updateInstallInProgress = true
  if (action !== 'install-now' && _updateUiState !== 'ready') {
    _updateUiState = 'downloading'
    renderUpdateBanner(banner, offer)
  }

  try {
    if (action === 'frontend-apply' || offer.kind === 'frontend-only') {
      await runUpdateInstall(offer, onProgress)
      return
    }

    const result = await runUpdateInstall(offer, onProgress, {
      forceRestart: false,
    })

    if (result?.deferred) {
      _updateUiState = 'ready'
      _updateInstallInProgress = false
      renderUpdateBanner(banner, offer)
      void onProgress({ phase: 'ready', message: '当前有任务进行中，请稍后再点「立即重启」' })
    }
  } catch (err) {
    _updateInstallInProgress = false
    _updateUiState = 'available'
    renderUpdateBanner(banner, offer)
    void onProgress({ message: `更新失败：${err?.message || err}` })
    const retryBtn = banner.querySelector('#btn-update-install, #btn-update-restart, #btn-update-apply-frontend')
    if (retryBtn) {
      retryBtn.disabled = false
      retryBtn.textContent = '重试更新'
    }
  }
}

async function maybeAutoDownloadUpdate(banner, offer) {
  if (!offer.oneClick || offer.kind !== 'full' || !offer.update) return
  const { isAutoDownloadUpdatesEnabled, isUpdateReadyToInstall, startBackgroundDownload } = await import('./lib/update-manager.js')
  if (!isAutoDownloadUpdatesEnabled()) return
  if (isUpdateReadyToInstall(offer)) {
    _updateUiState = 'ready'
    renderUpdateBanner(banner, offer)
    return
  }
  _updateUiState = 'downloading'
  renderUpdateBanner(banner, offer)
  try {
    await startBackgroundDownload(offer, (p) => {
      void runBannerUpdateProgress(banner, p)
      if (p.phase === 'ready') {
        _updateUiState = 'ready'
        renderUpdateBanner(banner, offer)
      }
    })
  } catch {
    _updateUiState = 'available'
    renderUpdateBanner(banner, offer)
  }
}

async function checkGlobalUpdate() {
  const banner = document.getElementById('update-banner')
  if (!banner || _updateInstallInProgress) return

  try {
    const offer = await resolveUpdateOfferLocal()
    if (!offer) return

    const dismissed = sessionStorage.getItem('evopanel_update_dismissed')
      || sessionStorage.getItem('evopanel_update_dismissed')
      || getPanelSetting('dismissedUpdateVersion', '')
    if (dismissed === offer.ver && _updateUiState !== 'ready') return

    const { isUpdateReadyToInstall } = await import('./lib/update-manager.js')
    if (isUpdateReadyToInstall(offer)) {
      _updateUiState = 'ready'
    }

    renderUpdateBanner(banner, offer)
    if (_updateUiState === 'available') {
      void maybeAutoDownloadUpdate(banner, offer)
    }
  } catch {
    // 检查失败静默忽略
  }
}

function startUpdateChecker() {
  if (!window.__TAURI_INTERNALS__) return
  setTimeout(checkGlobalUpdate, 5000)
  _updateCheckTimer = setInterval(checkGlobalUpdate, UPDATE_CHECK_INTERVAL)
}

/** WebUI 远程模式：浏览器直连 Gateway 时需 JWT（桌面端走 localhost 免鉴权）。 */
async function checkWebuiRemoteAuth() {
  if (isTauri) return true
  const hash = window.location.hash.slice(1) || ''
  const path = hash.split('?')[0]
  if (path === '/login' || path === '/qr-login' || path === '/auth/callback') return true
  if (/^\/share\/[^/]+$/.test(path)) return true
  try {
    const { getWebuiStatus, hasAuthToken } = await import('./lib/webui-remote.js')
    const status = await getWebuiStatus()
    if (!status?.enabled) return true
    if (hasAuthToken()) return true
    const redirect = path && path !== '/' ? path : '/chat'
    navigate(`/login?redirect=${encodeURIComponent(redirect)}`)
    return false
  } catch {
    return true
  }
}

// 启动：桌面端 liveness 后立即 boot（UI first）；/ready 后台轮询
;(async () => {
  bootMark('startup async begin', { tauri: isTauri })
  const maxChecks = isTauri ? 60 : 1
  let backendOk = false
  let healthAttempts = 0

  const waitForBackendHealth = async () => {
    for (let i = 0; i < maxChecks; i++) {
      healthAttempts = i + 1
      backendOk = await checkBackendHealth()
      if (backendOk) break
      if (isTauri) {
        const delayMs = i < 60 ? 100 : i < 90 ? 200 : 500
        await new Promise((r) => setTimeout(r, delayMs))
      }
    }
    bootMark(backendOk ? 'backend health ok' : 'backend health timeout', {
      attempts: healthAttempts,
      maxChecks,
    })
    return backendOk
  }

  const healthPromise = waitForBackendHealth()

  // liveness 通过后尽早拉 settings，不必等 boot() 结束
  if (isTauri) {
    healthPromise.then(async (ok) => {
      if (!ok) return
      void kickAppServerPrewarm('health-promise').then((warm) => {
        bootMark(warm ? 'app-server prewarm ok (health)' : 'app-server prewarm pending (health)')
      })
      try {
        await reloadPanelSettings()
        bootMark('panel settings reloaded (early)')
      } catch {
        /* ignore */
      }
    })
  }

  try {
    if (isTauri) {
      const auth = await checkAuth()
      bootMark(auth.ok ? 'auth ok' : 'auth required')
      if (!auth.ok) await showLoginOverlay(auth.mustChangePassword)

      // UI first: 不再等待 liveness 才 boot，立即启动渲染
      // healthPromise 继续后台跑，liveness 通过后 reloadPanelSettings
      bootMark(`ui-first boot id=${getDesktopBootId()}`)
      // 冷启动 hold：LG/DB 可能卡事件循环，禁止 guardian 在 /ready 前误杀 sidecar
      void import('./lib/gateway-guardian-busy.js')
        .then((m) => m.markGatewayColdStartHold?.())
        .catch(() => {})
      startBackendReadyPoll()
      startGatewayPoll()
      bootMark('ui-first boot (immediate, liveness async)')
      await boot()
      bootMark('boot() done')
    } else {
      backendOk = await healthPromise
      if (!backendOk) {
        showBackendDownOverlay()
        bootPrintSummary()
        return
      }
      try {
        await reloadPanelSettings()
        bootMark('panel settings reloaded')
      } catch {
        /* ignore */
      }
      const auth = await checkAuth()
      bootMark(auth.ok ? 'auth ok' : 'auth required')
      if (!auth.ok) await showLoginOverlay(auth.mustChangePassword)
      await checkWebuiRemoteAuth()
      await boot()
      bootMark('boot() done')
      const webuiReady = await checkWebuiRemoteAuth()
      if (!webuiReady) return
    }

    if (isTauri) {
      try {
        await reloadPanelSettings()
        bootMark('panel settings reloaded')
      } catch {
        /* ignore */
      }
      startGatewayPoll()
    }

    if (backendOk || isTauri) {
      import('./lib/skill-catalog.js').then((m) => m.prefetchSkillCatalog()).catch(() => {})
      const warmSettings = () => {
        import('./components/settings-modal.js')
          .then((m) => m.prefetchSettingsModal?.())
          .catch(() => {})
      }
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(warmSettings, { timeout: 10000 })
      } else {
        setTimeout(warmSettings, 4000)
      }
    }
  } catch (bootErr) {
    bootMark('boot() failed', { error: String(bootErr?.message || bootErr) })
    bootPrintSummary()
    removeBootSplash()
    console.error('[main] boot() 失败:', bootErr)
    const app = document.getElementById('app')
    if (app) app.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:20px;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
        <div style="font-size:48px;margin-bottom:16px">⚠️</div>
        <div style="font-size:18px;font-weight:600;margin-bottom:8px;color:#18181b">页面加载失败</div>
        <div style="font-size:13px;color:#71717a;max-width:400px;line-height:1.6;margin-bottom:16px">${String(bootErr?.message || bootErr).replace(/</g,'&lt;')}</div>
        <button onclick="location.reload()" style="padding:8px 20px;border-radius:8px;border:none;background:#6366f1;color:#fff;font-size:13px;cursor:pointer">刷新重试</button>
        <div style="margin-top:24px;font-size:11px;color:#a1a1aa">如果问题持续出现，请尝试重新安装 EvoFlow<br>或在 <a href="https://github.com/EvovexAI/EvoFlow/issues" target="_blank" style="color:#6366f1">GitHub Issues</a> 反馈</div>
      </div>`
  }
  startUpdateChecker()
  bootPrintSummary()

  // 初始化全局 AI 助手浮动按钮（延迟加载，不阻塞启动）
  setTimeout(async () => {
    const { initAIFab, registerPageContext, openAIDrawerWithError } = await import('./components/ai-drawer.js')
    initAIFab()

    
    // 挂到全局，供安装/升级失败时调用
    window.__openAIDrawerWithError = openAIDrawerWithError
  }, 500)
})()
