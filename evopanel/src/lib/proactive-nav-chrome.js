/**
 * 智能体员工子页：把 `.pro-page-nav` 浮到 Tauri 标题栏行（窗口最顶部）。
 * DOM 仍留在 page 内，便于 querySelector / 事件绑定。
 */

/**
 * @param {HTMLElement} page
 */
export function mountEmployeeNavToChrome(page) {
  if (typeof document === 'undefined') return
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
