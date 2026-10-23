/**
 * WebView2 / Chromium 内部错误页地址。导航失败后 location.href 会变成这些，
 * 绝不能写回 pageUrl / 再 upsert，否则会陷入「反复打开 chrome-error」死循环。
 */
export function isBrowserInternalErrorUrl(url: string): boolean {
  const u = String(url || '').trim().toLowerCase()
  if (!u) return false
  return (
    u.startsWith('chrome-error:') ||
    u.startsWith('chrome://') ||
    u.startsWith('edge://') ||
    u.startsWith('devtools://') ||
    u.startsWith('about:neterror') ||
    u.includes('chromewebdata')
  )
}

/** 可写入标签 / 可交给 upsert 的地址；错误页则回退 fallback。 */
export function sanitizeBrowserPageUrl(url: string, fallback = ''): string {
  const raw = String(url || '').trim()
  if (!raw || isBrowserInternalErrorUrl(raw)) return String(fallback || '').trim()
  return raw
}

/** 是否值得对原生窗发起导航（空白页允许；错误页不允许）。 */
export function isNavigableBrowserUrl(url: string): boolean {
  const raw = String(url || '').trim()
  if (!raw) return false
  if (isBrowserInternalErrorUrl(raw)) return false
  return true
}

/**
 * CDP 已打开的页 vs 面板同步回来的地址是否同一趟加载。
 * 用于避免 agent navigate 后 FE 再 upsert 把同页刷第二遍。
 */
export function isSameBrowserLoad(a: string, b: string): boolean {
  const left = String(a || '').trim()
  const right = String(b || '').trim()
  if (!left || !right) return false
  if (left === right) return true
  try {
    const u = new URL(left)
    const v = new URL(right)
    if (u.origin !== v.origin || u.pathname !== v.pathname) {
      const strip = (s: string) => s.replace(/\/$/, '')
      const c = strip(left)
      const w = strip(right)
      const prefixOk = (shorter: string, longer: string) =>
        longer.startsWith(shorter) &&
        (longer.length === shorter.length || longer[shorter.length] === '?' || longer[shorter.length] === '#')
      return prefixOk(c, w) || prefixOk(w, c)
    }
    const cq = u.search.replace(/^\?/, '')
    const wq = v.search.replace(/^\?/, '')
    if (cq === wq) return true
    if (!cq || !wq) return true
    return wq.startsWith(cq) || cq.startsWith(wq)
  } catch {
    return false
  }
}
