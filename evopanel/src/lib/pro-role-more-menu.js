/**
 * 智能体员工「⋯」菜单：portal 到 body + fixed 锚定。
 *
 * 漂移根因：
 * - CSS `zoom`（界面缩放回退路径）下，getBoundingClientRect / client* 与
 *   position:fixed 的 CSS 像素不是同一套坐标系；直接把 rect 写进 top/left 会漂。
 * - WebView2 ZoomFactor 下两者通常一致，故用探测比例而不是盲目 / getUiZoom()。
 * - 先 append 到 body 再晚一拍写 left 时，fixed + left:auto 会先落在 static 位置
 *   （页面底部），慢机器上就像「漂到别处」。
 */

const LAYOUT_PROPS = ['position', 'top', 'left', 'right', 'bottom', 'max-height', 'visibility']

/**
 * client/visual 坐标 → position:fixed 用的 layout CSS 像素比例。
 * 仅当 CSS zoom（或等价）造成 rect 与 offset 偏离时返回 ≠1。
 * @returns {number}
 */
export function clientToLayoutScale() {
  try {
    const z = String(document.documentElement.style.zoom || '').trim()
    if (z) {
      const n = Number(z)
      if (Number.isFinite(n) && n > 0) return n
    }
  } catch {
    /* ignore */
  }
  try {
    const de = document.documentElement
    const ow = de.offsetWidth
    const rw = de.getBoundingClientRect().width
    if (ow > 0 && rw > 0) {
      const s = rw / ow
      if (Number.isFinite(s) && s > 0.5 && Math.abs(s - 1) > 0.02) return s
    }
  } catch {
    /* ignore */
  }
  return 1
}

function toLayout(n, scale) {
  return scale === 1 ? n : n / scale
}

function solidColors() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark'
  return dark
    ? { bg: '#1a2030', fg: '#e2e8f0', hover: '#243044', dangerHover: '#3f1d1d' }
    : { bg: '#ffffff', fg: '#0f172a', hover: '#f1f5f9', dangerHover: '#fee2e2' }
}

export function applyProRoleMoreSolidSurface(menu) {
  if (!menu) return
  const { bg, fg, hover, dangerHover } = solidColors()
  menu.style.setProperty('--pro-more-bg', bg)
  menu.style.setProperty('--pro-more-fg', fg)
  menu.style.setProperty('--pro-more-hover', hover)
  menu.style.setProperty('--pro-more-danger-hover', dangerHover)
  menu.style.setProperty('background', bg, 'important')
  menu.style.setProperty('background-color', bg, 'important')
  menu.style.setProperty('background-image', 'none', 'important')
  menu.style.setProperty('color', fg, 'important')
  menu.style.setProperty('opacity', '1', 'important')
  menu.style.setProperty('backdrop-filter', 'none', 'important')
  menu.style.setProperty('-webkit-backdrop-filter', 'none', 'important')
  menu.style.setProperty('z-index', '100050', 'important')
}

export function clearProRoleMoreSolidSurface(menu) {
  if (!menu) return
  ;[
    '--pro-more-bg',
    '--pro-more-fg',
    '--pro-more-hover',
    '--pro-more-danger-hover',
    'background',
    'background-color',
    'background-image',
    'color',
    'opacity',
    'backdrop-filter',
    '-webkit-backdrop-filter',
    'z-index',
  ].forEach((prop) => menu.style.removeProperty(prop))
}

function detachReposition(menu) {
  const cleanup = menu?._proMoreRepositionCleanup
  if (typeof cleanup === 'function') {
    try {
      cleanup()
    } catch {
      /* ignore */
    }
  }
  if (menu) menu._proMoreRepositionCleanup = null
}

function attachReposition(btn, menu) {
  detachReposition(menu)
  const reposition = () => {
    if (!menu || menu.hidden || !document.body.contains(btn)) return
    positionProRoleMoreMenu(btn, menu, { track: false })
  }
  const onScroll = () => reposition()
  const onResize = () => reposition()
  const onZoom = () => reposition()
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onResize)
  window.addEventListener('ui-zoom-change', onZoom)
  menu._proMoreRepositionCleanup = () => {
    window.removeEventListener('scroll', onScroll, true)
    window.removeEventListener('resize', onResize)
    window.removeEventListener('ui-zoom-change', onZoom)
  }
}

/**
 * @param {HTMLElement} btn
 * @param {HTMLElement} menu
 * @param {{ track?: boolean, placement?: 'below' | 'above' | 'auto' }} [opts]
 */
export function positionProRoleMoreMenu(btn, menu, opts = {}) {
  if (!btn || !menu) return
  const track = opts.track !== false
  const placement = opts.placement || 'auto'
  const scale = clientToLayoutScale()
  const r = btn.getBoundingClientRect()
  const vw = toLayout(window.innerWidth, scale)
  const vh = toLayout(window.innerHeight, scale)
  const pad = 8

  // Portal to body so sibling cards (backdrop-filter / opacity stacking) cannot cover it,
  // and so it sits above #app (z-index:1) under translucent / liquid-glass themes.
  if (menu.parentElement !== document.body) {
    menu.dataset.proMoreHost = '1'
    menu._proMoreHost = menu.parentElement?.closest?.('.pro-role-more') || menu.parentElement
    document.body.appendChild(menu)
  }

  menu.classList.add('is-fixed')
  menu.style.setProperty('position', 'fixed', 'important')
  menu.style.setProperty('bottom', 'auto', 'important')
  menu.style.setProperty('right', 'auto', 'important')
  // Keep invisible until top+left are both written — avoids one-frame static-position flash.
  menu.style.setProperty('visibility', 'hidden', 'important')
  applyProRoleMoreSolidSurface(menu)
  menu.hidden = false

  const w = menu.offsetWidth || 148
  let left = Math.round(toLayout(r.right, scale) - w)
  left = Math.max(pad, Math.min(left, Math.round(vw - w - pad)))

  const maxH = Math.max(160, vh - pad * 2)
  const spaceBelow = Math.max(0, vh - toLayout(r.bottom, scale) - pad)
  const spaceAbove = Math.max(0, toLayout(r.top, scale) - pad)

  menu.style.setProperty('max-height', 'none', 'important')
  const mh = menu.scrollHeight || menu.offsetHeight || 0

  let top
  const preferAbove =
    placement === 'above' ||
    (placement === 'auto' && mh > spaceBelow && spaceAbove > spaceBelow)

  if (preferAbove) {
    const capped = Math.min(maxH, Math.max(120, spaceAbove))
    menu.style.setProperty('max-height', `${capped}px`, 'important')
    top = Math.max(pad, Math.round(toLayout(r.top, scale) - 4 - Math.min(mh, capped)))
  } else {
    const capped = Math.min(maxH, Math.max(120, spaceBelow || maxH))
    menu.style.setProperty('max-height', `${capped}px`, 'important')
    top = Math.round(toLayout(r.bottom, scale) + 4)
    if (top + Math.min(mh, capped) > vh - pad) {
      top = Math.max(pad, Math.round(vh - pad - Math.min(mh, capped)))
    }
  }

  menu.style.setProperty('top', `${top}px`, 'important')
  menu.style.setProperty('left', `${left}px`, 'important')
  menu.style.removeProperty('visibility')

  if (track) attachReposition(btn, menu)
}

/**
 * Menu may already be portaled to body — look in wrap first, then body host link.
 * @param {HTMLElement | null | undefined} wrap
 * @returns {HTMLElement | null}
 */
export function findProRoleMoreMenu(wrap) {
  if (!wrap) return null
  const local = wrap.querySelector('.pro-role-more-menu')
  if (local) return local
  return (
    [...document.body.querySelectorAll(':scope > .pro-role-more-menu.is-fixed, :scope > .pro-role-more-menu[data-pro-more-host]')].find(
      (m) => m._proMoreHost === wrap,
    ) || null
  )
}

/** True if event target is the wrap or its (possibly portaled) menu. */
export function isProRoleMoreEventTarget(wrap, target) {
  if (!wrap || !(target instanceof Element)) return false
  if (wrap.contains(target)) return true
  const menu = findProRoleMoreMenu(wrap)
  return !!(menu && menu.contains(target))
}

/**
 * Close one open ⋯ menu (wrap may be .pro-role-more; menu may already be on body).
 * @param {HTMLElement | null | undefined} wrap
 */
export function closeProRoleMoreMenu(wrap) {
  if (!wrap) return
  wrap.classList.remove('is-open')
  const btn = wrap.querySelector('.pro-role-more-btn')
  const menu = findProRoleMoreMenu(wrap)
  if (btn) btn.setAttribute('aria-expanded', 'false')
  if (!menu) return

  detachReposition(menu)
  menu.hidden = true
  menu.classList.remove('is-fixed')
  LAYOUT_PROPS.forEach((prop) => menu.style.removeProperty(prop))
  clearProRoleMoreSolidSurface(menu)
  const host = menu._proMoreHost
  if (host && menu.parentElement === document.body) {
    host.appendChild(menu)
  }
  menu._proMoreHost = null
  delete menu.dataset.proMoreHost
}

/**
 * @param {ParentNode | Document} [root]
 */
export function closeAllProRoleMoreMenus(root = document) {
  document.querySelectorAll('.pro-role-more.is-open').forEach((wrap) => {
    if (root !== document && !root.contains(wrap)) return
    closeProRoleMoreMenu(wrap)
  })
}

/**
 * Open (or refresh) the menu anchored to btn inside wrap.
 * @param {HTMLElement} wrap
 * @param {HTMLElement} btn
 * @param {HTMLElement} menu
 * @param {{ placement?: 'below' | 'above' | 'auto' }} [opts]
 */
export function openProRoleMoreMenu(wrap, btn, menu, opts = {}) {
  if (!wrap || !btn || !menu) return
  wrap.classList.add('is-open')
  btn.setAttribute('aria-expanded', 'true')
  positionProRoleMoreMenu(btn, menu, { track: true, placement: opts.placement || 'auto' })
}
