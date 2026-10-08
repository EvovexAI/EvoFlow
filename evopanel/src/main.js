/**
 * EvoFlow 桌面端入口
 */
import { registerRoute, initRouter, navigate, setDefaultRoute, removeBootSplash, isAuthRoute } from './router.js'
import { initShellAside, openMobileShellAside } from './components/shell-aside.js'
import { initTheme, attachSystemThemeListener } from './lib/theme.js'
import { initFontSizePreference } from './lib/font-size.js'
import { initUiZoom } from './lib/ui-zoom.js'
import { initAccentThemePreference } from './lib/accent-theme.js'
import { initSciFiUI } from './lib/sci-fi-theme.js'
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

// === 全局服务可用性 banner（vanilla DOM，任何路由都能看到；与 ChatApp banner 并行不冲突） ===
import {
  startServiceHealthPoll,
  onServiceHealthChange,
  triggerServiceHealthCheck,
  ServiceHealthState,
} from './lib/service-health.js'

// 仅在 production build 时开启 console 落盘（release 包调试用）
// dev 调试时禁用，避免 DevTools Network 被刷屏
if (import.meta.env.PROD) installConsoleFileLog()
bootMark('main module eval')
if (isTauri) initDesktopNotifications()
if (isTauri) initDesktopContextMenu()
if (isTauri) initDesktopDevtoolsHotkey()

// 样式（v3.5 阶段 F1 commit 1: 抽到 ./boot/0-styles.js,顺序敏感)
// import './style/variables.css' ... 33 个 import 已抽到 0-styles.js
import './boot/0-styles.js'

// v3.5 阶段 F1 commit 2: 启动期 3 个兜底(visibility / SkillHub 杀进程 /
// dynamic-import 失败 reload) 抽到 ./boot/3-recovery.js
import './boot/3-recovery.js'

// v3.5 阶段 F1 commit 3: 后端就绪轮询 + 离线兜底(backend-warming banner /
// backend-down overlay) 抽到 ./boot/backend-warm.js,只 export
// startBackendReadyPoll 给下面 IIFE 调
import { startBackendReadyPoll } from './boot/backend-warm.js'

// 初始化主题与面板设置（SQLite evoflow_app_settings / panel.ui）
initTheme()
initFontSizePreference()
initUiZoom()
initAccentThemePreference()
initSciFiUI()
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

/**
 * v3.5: 读 `localStorage.evoflowV4Shell` 决定 boot 时是否进 zcode 桌面新版。
 * 切到新版 = shell-aside.js 的"切到新版"按钮写 '1' + reload;切回老版 =
 * EvoFlowV4HeaderToggle 删 key + reload。默认 '0' / 没设 = 老版,符合
 * 用户"默认还是老版"的要求。
 */
function isV4ShellEnabled() {
  try {
    return window.localStorage.getItem('evoflowV4Shell') === '1'
  } catch {
    return false
  }
}

/**
 * v3.5: 把 `<V4ShellRoot>` 挂到 `<main id="content">`,独占主列,完全替代
 * 老版 ChatApp。原本 `#chat-persistent-host` 隐藏,`<main id="content">`
 * 显示(老版是 ChatApp 挂到 persistent-host 里 hide 掉,content 装别的页面
 * —— 新版反一反:persistent-host 不挂,content 装 V4ShellRoot)。
 *
 * V4ShellRoot 内部自带完整的 provider 栈(Lucide / Tooltip / Service /
 * Platform / Store / TabStore / DiffsWorker / CodingPlanUpgradeDialog /
 * ZCodeIntl) + EvoFlowApp(zcode App.tsx 适配版),用户看到的就是 zcode
 * 桌面 UI 全套 —— 不再是"老版 ChatApp 中间嵌 v4"那种割裂感。
 *
 * sessionId 暂传 null(v4 草稿态);EvoFlow 当前无 workspace 概念,
 * workspacePath 传 const EMPTY_WORKSPACE_PATH 占位。后续 v3.6+ 接
 * EvoFlow 真实 sessions list 注入 V4ShellRoot。
 */
const EVOFLOW_V4_WORKSPACE_PATH = '/evoflow/main'
let _v4ReactRoot = null
let _v4ContainerEl = null

async function mountV4ShellToContent() {
  const content = document.getElementById('content')
  if (!content) return
  // 隐藏 chat-persistent-host 防止 ChatApp 单例被意外 mount
  const host = document.getElementById('chat-persistent-host')
  if (host) {
    host.hidden = true
    host.style.display = 'none'
  }
  bootMark('mountV4ShellToContent begin')
  try {
    const { createRoot } = await import('react-dom/client')
    const React = await import('react')
    const { V4ShellRoot } = await import('./react/v4shell/V4ShellRoot.tsx')

    // 已挂则不重复
    if (_v4ReactRoot && _v4ContainerEl?.isConnected && _v4ContainerEl.parentElement === content) {
      return
    }
    if (_v4ReactRoot) {
      try {
        _v4ReactRoot.unmount()
      } catch {
        /* ignore */
      }
      _v4ReactRoot = null
      _v4ContainerEl = null
    }
    _v4ContainerEl = document.createElement('div')
    _v4ContainerEl.id = 'v4-shell-host'
    _v4ContainerEl.style.height = '100%'
    content.replaceChildren(_v4ContainerEl)
    _v4ReactRoot = createRoot(_v4ContainerEl)
    // v3.5 阶段 C+: ErrorBoundary 包裹 V4ShellRoot。V4ShellRoot 内部
    // zcode provider 树很复杂(17+ 层 provider + 自定义 hooks),任何
    // 一处抛错都会让整个 root 变成空白页。用 ErrorBoundary 接住
    // 渲染期错,触发降级 → removeItem + reload,不让用户卡在空白。
    const V4ErrorBoundary = class extends React.Component {
      constructor(props) { super(props); this.state = { err: null } }
      static getDerivedStateFromError(err) { return { err } }
      componentDidCatch(err, info) {
        try { console.error('[v4shell] ErrorBoundary caught', err, info?.componentStack) } catch {}
      }
      componentDidUpdate(prev) {
        // 第一次出现 err 状态时,给用户看 1 秒错误提示,然后 reload
        // 回老版。ErrorBoundary 内的 setState 触发的二次 render 不会
        // 再走 componentDidUpdate(因为 err 没变,getDerivedStateFromError
        // 不会再次返回 err;但保险起见用 prev.state.err 比较)。
        if (this.state.err && !prev.state.err) {
          setTimeout(() => {
            try { window.location.reload() } catch { /* 静默 */ }
          }, 1000)
        }
      }
      render() {
        if (this.state.err) {
          // ErrorBoundary 触发 → 触发降级(走外层 catch 也接不住,因为
          // render 抛错是同步抛回 React 18 异步通道,不进 try/catch)
          try {
            localStorage.removeItem('evoflowV4Shell')
          } catch { /* 静默 */ }
          const msg = String(this.state.err?.message || this.state.err || 'unknown error')
            .replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]))
          return React.createElement('div', {
            style: { padding: 24, color: '#f87171', fontFamily: '-apple-system, system-ui', lineHeight: 1.6 }
          },
            React.createElement('h2', { style: { margin: '0 0 12px 0' } }, '新版运行时错误,已自动退回老版'),
            React.createElement('p', { style: { margin: '0 0 8px 0', color: '#94a3b8' } }, '错误信息: ', msg),
            React.createElement('p', { style: { margin: '0', color: '#94a3b8' } }, '1 秒后自动刷新...')
          )
        }
        return this.props.children
      }
    }
    _v4ReactRoot.render(
      React.createElement(V4ErrorBoundary, null,
        React.createElement(V4ShellRoot, {
          workspacePath: EVOFLOW_V4_WORKSPACE_PATH,
          sessionId: null,
          onSelectSession: () => {
            /* v3.5: EvoFlow 旧侧栏 selectedSessionKey 桥 —— 当前 v4 shell
               模式完全替代老版 ChatApp,旧侧栏已不渲染,这里 noop 即可。
               后续 v3.6 接 sessions 列表时,改为切 activeTaskId 时
               通知上层路由 / 弹层。 */
          },
        }),
      ),
    )
    bootMark('mountV4ShellToContent done')
  } catch (e) {
    bootMark('mountV4ShellToContent failed', { error: String(e?.message || e) })
    console.warn('[boot] mountV4ShellToContent failed', e)
    // v3.5 阶段 C+: 降级到老版 —— V4ShellRoot 挂载失败时(比如 provider
    // 树里某个依赖报错 / react 19 vs 18 hook 顺序冲突 / 缺资源),
    // 用户会看到空白 + 没入口回老版(BETA 横条在 V4ShellRoot 内,
    // 都没渲染就谈不到点)。直接 removeItem + reload 重走 boot,
    // localStorage.evoflowV4Shell !== '1' → 走老版 ChatApp 路径。
    // 比"空白页 + 无回退"好得多。
    try {
      localStorage.removeItem('evoflowV4Shell')
    } catch {
      /* private mode 静默 */
    }
    // 给用户一个可视化兜底(在 reload 前),如果 reload 因为任何原因没成功
    if (_v4ContainerEl) {
      _v4ContainerEl.innerHTML = `
        <div style="padding: 24px; color: #f87171; font-family: -apple-system, system-ui; line-height: 1.6;">
          <h2 style="margin: 0 0 12px 0;">新版加载失败,已自动退回老版</h2>
          <p style="margin: 0 0 8px 0; color: #94a3b8;">错误信息: ${String(e?.message || e).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]))}</p>
          <p style="margin: 0; color: #94a3b8;">1 秒后自动刷新...</p>
        </div>
      `
    }
    setTimeout(() => {
      try { window.location.reload() } catch { /* 静默 */ }
    }, 1000)
  }
}

/**
 * 在 document.body 顶层注入一个 vanilla DOM 服务健康 banner。
 *
 * 设计动机：ChatApp 是按需懒加载（用户在非聊天路由时根本不 mount），
 * 单纯在 ChatApp 里显示 banner 不能覆盖"用户在别的页面"或"ChatApp 加载中"的场景。
 * 这个兜底 banner 始终在 DOM 中，跟随 service-health 状态机同步显示。
 *
 * 视觉差异：ChatApp 内的 banner（受 layout 控制）和本 banner（fixed 顶部）并存，二者 UI
 * 一致但不会冲突；通常 ChatApp mount 后用户视觉上只看到一个。
 */
let _globalRecoveryBannerInstalled = false
function _installGlobalServiceBanner() {
  if (_globalRecoveryBannerInstalled) return
  if (typeof document === 'undefined' || !document.body) return
  _globalRecoveryBannerInstalled = true

  const host = document.createElement('div')
  host.id = 'evoflow-global-recovery-banner-host'
  host.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    'right:0',
    'z-index:2147483000', // 高于 toast/modal
    'display:none',
    'pointer-events:none',
  ].join(';')

  const bar = document.createElement('div')
  bar.className = 'evoflow-global-recovery-banner'
  bar.setAttribute('role', 'status')
  bar.setAttribute('aria-live', 'polite')

  const dot = document.createElement('span')
  dot.className = 'evoflow-global-recovery-dot'
  const text = document.createElement('span')
  text.className = 'evoflow-global-recovery-text'
  const action = document.createElement('button')
  action.type = 'button'
  action.className = 'evoflow-global-recovery-action'
  action.style.cssText = 'pointer-events:auto;cursor:pointer;background:transparent;border:0;padding:0;font:inherit;color:inherit;text-decoration:underline;text-underline-offset:2px;'
  action.textContent = '点击重试'
  action.addEventListener('click', () => {
    void triggerServiceHealthCheck({ manual: true })
  })

  bar.append(dot, text, action)
  host.appendChild(bar)
  // 侧栏底部已有小状态点，不需要全屏 banner；留 host 用于调试可见性
  // host.style.display = 'none' // 注释掉：完全不挂载，不占 DOM
  // document.body.appendChild(host) // 禁用全屏 banner

  let lastShown = null
  const apply = (state) => {
    if (state === ServiceHealthState.UNAVAILABLE) {
      bar.classList.add('evoflow-global-recovery-banner--unavailable')
      bar.classList.remove('evoflow-global-recovery-banner--degraded')
      text.textContent = '服务未启动或暂时不可用，请检查服务状态'
      action.style.display = ''
      action.disabled = false
      action.textContent = '点击重试'
      host.style.display = 'block'
      lastShown = ServiceHealthState.UNAVAILABLE
    } else if (state === ServiceHealthState.DEGRADED) {
      bar.classList.add('evoflow-global-recovery-banner--degraded')
      bar.classList.remove('evoflow-global-recovery-banner--unavailable')
      text.textContent = '服务正在初始化中，请稍候'
      action.style.display = ''
      action.disabled = true
      action.textContent = '初始化中…'
      host.style.display = 'block'
      lastShown = ServiceHealthState.DEGRADED
    } else {
      host.style.display = 'none'
      lastShown = null
    }
  }

  // 启动轮询 + 订阅
  startServiceHealthPoll()
  onServiceHealthChange((snap) => apply(snap.state))
  void apply(ServiceHealthState.UNKNOWN)
}

async function boot() {
  bootMark('boot() enter')
  // 早启动全局服务健康 banner（vanilla DOM；与 ChatApp banner 并存，UI 不冲突）
  try { _installGlobalServiceBanner() } catch (e) {
    try { console.warn('[boot] install global service banner failed', e) } catch {}
  }
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

  // v3.5: 提前在 boot() 顶层算 v4AtBoot,后续两处引用(分流 mount + 隐藏
  // 老版 shell-aside / banners)都能拿到。不能在 else-if 块内 const,
  // 块作用域外 line 967 那个 if 块读不到。
  const v4AtBoot = isV4ShellEnabled()

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
  // Owned KB is the only knowledge source.
  registerRoute('/knowledge', () => import('./pages/knowledge-owned.js'))
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
    // v3.5: v4 模式 = 整客户端换壳,根本不让老版 initShellAside / initMobileTabbar
    // 触碰 DOM。v3.5 阶段 B+ 修后还是"隐藏"级别(`display: none`),问题是
    // initShellAside 内部 _applyCollapsed 会改 className,跟我们的 display:none
    // 偶尔冲突(用户反馈"一会还是嵌套老页面")。改成"根本不调",DOM 里没有老版
    // shell-aside / mobile-topbar / ChatApp 元素,自然不会嵌套,也不会乱闪。
    if (v4AtBoot) {
      try {
        const { refreshLicenseStatus } = await import('./lib/license.js')
        await refreshLicenseStatus()
      } catch (e) {
        console.warn('[boot] license status unavailable', e)
      }
      await mountV4ShellToContent()
    } else {
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
    }
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
  // v3.5 阶段 C+: v4 模式跳过 initRouter(避免 hashchange / 启动
  // 默认路由 /chat 把 <main id="content"> 改写成 ChatApp 把 v4 shell
  // 覆盖,导致用户反馈的"一会还是嵌套老页面")。v4 模式整个客户端
  // 都被 zcode 桌面壳接管,hash 路由失去意义,用户行为都在 zcode 内
  // 发生(activeTaskId / draft 切换等都是 zcode App.tsx 内部状态机)。
  if (!v4AtBoot) {
    initRouter(content, { chatHostEl: document.getElementById('chat-persistent-host') })
  } else {
    bootMark('v4 shell mode: initRouter skipped (zcode owns navigation)')
  }
  bootMark('initRouter done')

  if (isTauri) {
    void import('./lib/background-voice.js').then(({ initBackgroundVoice }) => initBackgroundVoice())
  }

  // 全屏开场层见 index.html #boot-splash，由 router 首屏渲染后再淡出移除

    const mainCol = document.getElementById('main-col')
  if (!authOnlyBoot && mainCol) {
    // v3.5 阶段 C+: v4 模式分支上移到上面 (if v4AtBoot 早 return 那块),
    // 根本不让 initShellAside / initMobileTabbar / mobile-topbar
    // 触碰 DOM。这里只剩老版 mobile-topbar + 桌面无边框 chrome。
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

        // 欢迎引导 dialog（复刻 ZCode cloud-content-dialog 视觉）
        try {
          const { showCelebrateDialog } = await import('./components/celebrate-dialog.js')
          showCelebrateDialog({
            title: '欢迎使用 EvoFlow',
            descHtml:
              '<p>检测到尚未配置 AI 模型。先 <b>添加至少一个模型</b>，即可开始对话与任务。</p>',
            heroCaption: '让我们开始吧',
            icon: 'welcome',
            actions: [
              { label: '去配置模型', variant: 'primary' },
              { label: '稍后再说', variant: 'secondary' },
            ],
          })
        } catch {
          /* dialog 加载失败则退回 toast */
          const { toast } = await import('./components/toast.js')
          toast('👋 欢迎使用 EvoFlow! 请先配置至少一个 AI 模型', 'info', 5000)
        }
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
