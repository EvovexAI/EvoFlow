/**
 * 智能体员工子页：把 `.pro-page-nav` 浮到 Tauri 标题栏行（窗口最顶部）。
 * DOM 仍留在 page 内，便于 querySelector / 事件绑定。
 *
 * macOS 例外：系统原生 Overlay 标题栏下，窗口拖动只认标题栏那一条区域。
 * 把操作栏 fixed 上去会整条吃掉拖拽区（表现为「窗口锁死、拖不动」），
 * 因此 macOS 不启用，操作栏留在文档流内。
 *
 * left 不再写死 --shell-aside-width：折叠 / 悬停展开 / 动画途中都按 #main-col
 * 实测左缘 + 内容 padding 对齐，避免盖住侧栏按钮。
 */

/** macOS 原生标题栏模式由 tauri-titlebar.js 置位（html.evopanel-macos-titlebar） */
function isMacNativeTitlebar() {
  try {
    return document.documentElement.classList.contains('evopanel-macos-titlebar')
  } catch {
    return false
  }
}

function readSpaceLgPx() {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--space-lg').trim()
    const n = parseFloat(raw)
    if (Number.isFinite(n)) return n
  } catch {
    /* ignore */
  }
  return 24
}

/**
 * @param {HTMLElement} page
 */
export function syncEmployeeNavInset(page) {
  if (!page?.classList?.contains('pro-employee-page--nav-in-chrome')) return
  const nav = page.querySelector('.pro-page-nav')
  if (!nav) return
  if (window.matchMedia('(max-width: 768px)').matches) {
    nav.style.left = `${readSpaceLgPx()}px`
    return
  }
  const mainCol = document.getElementById('main-col')
  if (!mainCol) return
  const left = Math.max(0, Math.round(mainCol.getBoundingClientRect().left + readSpaceLgPx()))
  nav.style.left = `${left}px`
}

function cleanupNavChrome(page) {
  if (page?._navChromeObserver) {
    try {
      page._navChromeObserver.disconnect()
    } catch {
      /* ignore */
    }
    page._navChromeObserver = null
  }
  if (typeof page?._navChromeCleanup === 'function') {
    try {
      page._navChromeCleanup()
    } catch {
      /* ignore */
    }
    page._navChromeCleanup = null
  }
  const nav = page?.querySelector?.('.pro-page-nav')
  if (nav) nav.style.left = ''
}

/**
 * @param {HTMLElement} page
 */
export function mountEmployeeNavToChrome(page) {
  if (typeof document === 'undefined') return
  if (isMacNativeTitlebar()) return
  const chrome = document.getElementById('tauri-main-chrome')
  if (!chrome) return

  const nav = page.querySelector('.pro-page-nav')
  if (!nav) return

  cleanupNavChrome(page)

  chrome.classList.add('tauri-main-chrome--employee-nav')
  page.classList.add('pro-employee-page--nav-in-chrome')

  const sync = () => {
    if (!document.body.contains(page)) {
      unmountEmployeeNavFromChrome(page)
      return
    }
    syncEmployeeNavInset(page)
  }

  sync()
  requestAnimationFrame(sync)

  const aside = document.getElementById('app-shell-aside')
  const mainCol = document.getElementById('main-col')
  const ro =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          sync()
          // 宽度 CSS transition 期间再跟一两帧，避免中途错位
          requestAnimationFrame(sync)
        })
      : null
  if (ro) {
    if (aside) ro.observe(aside)
    if (mainCol) ro.observe(mainCol)
  }

  const onWin = () => sync()
  window.addEventListener('resize', onWin)

  const mo =
    typeof MutationObserver !== 'undefined' && aside
      ? new MutationObserver(() => sync())
      : null
  mo?.observe(aside, { attributes: true, attributeFilter: ['class', 'style'] })

  const onTransition = (e) => {
    if (e?.propertyName && e.propertyName !== 'width' && e.propertyName !== 'min-width') return
    sync()
  }
  aside?.addEventListener('transitionend', onTransition)

  page._navChromeCleanup = () => {
    ro?.disconnect()
    mo?.disconnect()
    window.removeEventListener('resize', onWin)
    aside?.removeEventListener('transitionend', onTransition)
  }

  const observer = new MutationObserver(() => {
    if (!document.body.contains(page)) {
      unmountEmployeeNavFromChrome(page)
      observer.disconnect()
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  page._navChromeObserver = observer
}

/**
 * @param {HTMLElement} page
 */
export function unmountEmployeeNavFromChrome(page) {
  cleanupNavChrome(page)
  const chrome = document.getElementById('tauri-main-chrome')
  if (chrome) chrome.classList.remove('tauri-main-chrome--employee-nav')
  page?.classList?.remove('pro-employee-page--nav-in-chrome')
}
