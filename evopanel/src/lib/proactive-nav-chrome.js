/**
 * 智能体员工子页：把 `.pro-page-nav` 浮到 Tauri 标题栏行（窗口最顶部）。
 * DOM 仍留在 page 内，便于 querySelector / 事件绑定。
 *
 * macOS 例外：系统原生 Overlay 标题栏下，窗口拖动只认标题栏那一条区域。
 * 把操作栏 fixed 上去会整条吃掉拖拽区（表现为「窗口锁死、拖不动」），
 * 因此 macOS 不启用，操作栏留在文档流内。
 */

/** macOS 原生标题栏模式由 tauri-titlebar.js 置位（html.evopanel-macos-titlebar） */
function isMacNativeTitlebar() {
  try {
    return document.documentElement.classList.contains('evopanel-macos-titlebar')
  } catch {
    return false
  }
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

  chrome.classList.add('tauri-main-chrome--employee-nav')
  page.classList.add('pro-employee-page--nav-in-chrome')

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
  if (page?._navChromeObserver) {
    try {
      page._navChromeObserver.disconnect()
    } catch {
      /* ignore */
    }
    page._navChromeObserver = null
  }
  const chrome = document.getElementById('tauri-main-chrome')
  if (chrome) chrome.classList.remove('tauri-main-chrome--employee-nav')
  page?.classList?.remove('pro-employee-page--nav-in-chrome')
}
