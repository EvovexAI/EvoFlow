/**
 * 无边框窗口：不在页面顶部单独占一条系统栏。
 * - /chat：窗口按钮在 React 顶栏（ChatApp）内
 * - 知识库详情：窗口按钮在 .kv-workspace-bar 内
 * - 其它路由：在 #main-col 顶部插入一条与内容同源的细栏（仍算「内容区」）
 * - macOS：改用系统原生标题栏（tauri.macos.conf.json 里 decorations/titleBarStyle:Overlay），
 *   顶栏需为交通灯让出高度，自绘窗口按钮隐藏 —— 由 html.evopanel-macos-titlebar 统一控制
 */

const MAIN_CHROME_ID = 'tauri-main-chrome'
const SCROLL_SHADOW_PX = 8
/** macOS 原生标题栏模式：置位后 CSS 才应用「为交通灯让位」的那组规则 */
const MACOS_TITLEBAR_CLASS = 'evopanel-macos-titlebar'

function isMacOs() {
  return /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '')
}

function routePath() {
  const hash = window.location.hash.slice(1) || '/chat'
  return hash.split('?')[0]
}

function isChatRoute() {
  return routePath() === '/chat'
}

// keep helper for potential callers
void isChatRoute

function getMainChrome() {
  return document.getElementById(MAIN_CHROME_ID)
}

function setMainChromeScrolled(scrolled) {
  const el = getMainChrome()
  if (!el) return
  el.classList.toggle('tauri-main-chrome--scrolled', Boolean(scrolled))
}

/** 读取主内容区（#content 或其内部滚动容器）的纵向滚动位置 */
function readContentScrollTop(scrollTarget) {
  const content = document.getElementById('content')
  if (!content) return 0
  let top = content.scrollTop || 0
  if (scrollTarget instanceof Element && content.contains(scrollTarget) && scrollTarget !== content) {
    top = Math.max(top, scrollTarget.scrollTop || 0)
  }
  return top
}

function syncMainChromeScrollShadow(scrollTarget) {
  const el = getMainChrome()
  if (!el || el.classList.contains('tauri-main-chrome--hidden')) {
    setMainChromeScrolled(false)
    return
  }
  setMainChromeScrolled(readContentScrollTop(scrollTarget) > SCROLL_SHADOW_PX)
}

function onMainContentScrollCapture(event) {
  const el = getMainChrome()
  if (!el || el.classList.contains('tauri-main-chrome--hidden')) return
  const content = document.getElementById('content')
  if (!content) return
  const target = event.target
  if (!(target instanceof Element)) return
  if (target !== content && !content.contains(target)) return
  setMainChromeScrolled(readContentScrollTop(target) > SCROLL_SHADOW_PX)
}

function syncMainChromeVisibility() {
  const el = getMainChrome()
  if (!el) return
  const path = routePath()
  const kvDetail =
    typeof document !== 'undefined' &&
    document.getElementById('app')?.classList.contains('evopanel-kv-detail-mode')
  // 聊天 / KV 详情顶栏自带窗口钮；应用工作室 / UI 扩展全屏沉浸时也不占顶栏白条
  const hide =
    path === '/chat' ||
    kvDetail ||
    /^\/apps\/[^/]+(?:\/(?:run|history))?$/.test(path) ||
    /^\/extensions\/[^/]+$/.test(path)
  el.classList.toggle('tauri-main-chrome--hidden', hide)
  el.setAttribute('aria-hidden', hide ? 'true' : 'false')
  if (hide) {
    setMainChromeScrolled(false)
  } else {
    syncMainChromeScrollShadow()
  }
}

/** 知识库详情壳层切换时同步隐藏/显示主列空 chrome */
export function refreshTauriMainChromeVisibility() {
  syncMainChromeVisibility()
}

async function bindWindowControls(root) {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const win = getCurrentWindow()
  root.querySelector('[data-ep-win="min"]')?.addEventListener('click', () => void win.minimize())
  root.querySelector('[data-ep-win="max"]')?.addEventListener('click', () => void win.toggleMaximize())
  root.querySelector('[data-ep-win="close"]')?.addEventListener('click', () => void win.close())
  const drag = root.querySelector('[data-tauri-main-chrome-drag]')
  drag?.addEventListener('dblclick', () => void win.toggleMaximize())
}

/**
 * @param {HTMLElement | null} mainColEl - #main-col
 * @param {HTMLElement | null} [insertBeforeEl] - 插在该元素之前（通常为 #mobile-topbar），使窗口条处于主列最顶
 */
export function initTauriFramelessChrome(mainColEl, insertBeforeEl) {
  if (typeof document === 'undefined') return
  if (!window.__TAURI_INTERNALS__) return
  if (document.getElementById(MAIN_CHROME_ID)) return

  document.documentElement.classList.add('evopanel-tauri-frameless')
  // macOS 用系统原生标题栏：置位后 CSS 才为交通灯让位，其它平台维持原紧凑顶栏
  if (isMacOs()) document.documentElement.classList.add(MACOS_TITLEBAR_CLASS)

  const mainCol = mainColEl || document.getElementById('main-col')
  if (!mainCol) return

  const chrome = document.createElement('div')
  chrome.id = MAIN_CHROME_ID
  chrome.className = 'tauri-main-chrome'
  chrome.setAttribute('role', 'toolbar')
  chrome.setAttribute('aria-label', '窗口')
  chrome.innerHTML = `
    <button type="button" class="tauri-chrome-nav-btn" data-tauri-no-drag title="展开侧栏" aria-label="展开侧栏">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18" aria-hidden="true">
        <line x1="3" y1="6" x2="21" y2="6"/>
        <line x1="3" y1="12" x2="21" y2="12"/>
        <line x1="3" y1="18" x2="21" y2="18"/>
      </svg>
    </button>
    <div class="tauri-main-chrome-drag" data-tauri-drag-region data-tauri-main-chrome-drag title="拖动窗口 · 双击最大化"></div>
    <div class="tauri-main-chrome-actions">
      <button type="button" class="tauri-chrome-guide-btn" data-tauri-no-drag title="使用指南（?）" aria-label="使用指南">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <circle cx="12" cy="12" r="10"/>
          <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/>
          <line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
      </button>
      <div class="ep-window-controls">
        <button type="button" class="ep-window-controls-btn ep-window-controls-btn--min" data-tauri-no-drag data-ep-win="min" title="最小化" aria-label="最小化">−</button>
        <button type="button" class="ep-window-controls-btn ep-window-controls-btn--max" data-tauri-no-drag data-ep-win="max" title="最大化" aria-label="最大化">□</button>
        <button type="button" class="ep-window-controls-btn ep-window-controls-btn--close" data-tauri-no-drag data-ep-win="close" title="关闭" aria-label="关闭">×</button>
      </div>
    </div>
  `
  if (insertBeforeEl && insertBeforeEl.parentNode === mainCol) {
    mainCol.insertBefore(chrome, insertBeforeEl)
  } else {
    mainCol.insertBefore(chrome, mainCol.firstChild)
  }

  void bindWindowControls(chrome)

  // 主导航（汉堡）：非 /chat 路由统一走这里展开左侧壳（/chat 由 ChatApp 顶栏自带）
  chrome.querySelector('.tauri-chrome-nav-btn')?.addEventListener('click', () => {
    // 动态 import，避免与 shell-aside 形成静态循环依赖
    import('../components/shell-aside.js')
      .then((m) => m.toggleShellAsideCollapsed())
      .catch(() => {})
  })

  // 绑定全局指南按钮
  const guideBtn = chrome.querySelector('.tauri-chrome-guide-btn')
  if (guideBtn) {
    guideBtn.addEventListener('click', () => {
      import('./page-help.js').then((m) => m.showPageHelpPanel()).catch(() => {})
    })
  }

  syncMainChromeVisibility()

  // capture：内部子滚动容器也能驱动标题栏底影（scroll 不冒泡）
  document.addEventListener('scroll', onMainContentScrollCapture, true)
  window.addEventListener('hashchange', syncMainChromeVisibility)
}
