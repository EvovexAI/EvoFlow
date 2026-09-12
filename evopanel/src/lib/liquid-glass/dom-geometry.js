/**
 * EvoFlow DOM → WebGL 光学几何（liquid-glass theme-layer / glass-shader 探测逻辑）
 */

const LENS_SELECTORS = [
  '.react-chat-aside-history-search',
  '.settings-theme-btn--active',
  '.evo-home-composer',
  '.role-search-input',
]

/** Layer-1 磨砂面板（复用 shader u_popovers 通道，最多 16 个） */
const FROST_PANEL_SELECTORS = [
  '.react-chat-info-rail',
  '.react-chat-workspace-panel',
  '.react-chat-right-stage-panel',
  '.react-chat-collab-exec-panel',
  '.react-chat-knowledge-map-panel',
  '.react-chat-browser-panel',
  '.react-chat-artifacts-panel',
  '.react-chat-platform-feedback-panel',
  '.knowledge-owned-page',
  '.knowledge-vaults-page',
  '#content > .page',
  '.page.settings-page',
  '.page.general-page',
]

const SIDEBAR_SELECTORS = '#app-shell-aside, .react-chat-session-aside, .shell-aside-host'
const CHAT_SELECTORS = '.react-chat-conversation-col, .react-chat-messages-wrap'
const HEADER_SELECTORS = '.react-chat-header, .react-chat-header--tauri-chrome'
const MODAL_SELECTORS = '.modal-overlay .modal, .react-chat-modal-overlay .react-chat-modal, .modal'

/** @type {HTMLElement[]} */
let _cachedLenses = []
/** @type {HTMLElement[]} */
let _cachedFrostPanels = []
let _scanCounter = 0
/** @type {WeakMap<HTMLElement, { rect: DOMRect; at: number }>} */
const _rectCache = new WeakMap()
/** @type {{ result: ReturnType<typeof collectEvoFlowGlassGeometry>; at: number } | null} */
let _geoCache = null

function rectCacheMs() {
  return document.documentElement.dataset.lgVideoBg === '1' ? 280 : 180
}

function geoThrottleMs() {
  return document.documentElement.dataset.lgVideoBg === '1' ? 140 : 0
}

function getCachedRect(el, now) {
  const cached = _rectCache.get(el)
  if (cached && now - cached.at < rectCacheMs()) return cached.rect
  const rect = el.getBoundingClientRect()
  _rectCache.set(el, { rect, at: now })
  return rect
}

function rectToLens(rect, dpr, screenH, radiusPx = 14) {
  const w = rect.width
  const h = rect.height
  if (w < 14 || h < 14) return null
  const halfW = (w * 0.5) * dpr
  const halfH = (h * 0.5) * dpr
  const radius = Math.min(radiusPx * dpr, halfH, halfW)
  return {
    centerX: (rect.left + w * 0.5) * dpr,
    centerY: (screenH - (rect.top + h * 0.5)) * dpr,
    halfW,
    halfH,
    radius,
  }
}

function pickLargestVisible(selectors) {
  const nodes = document.querySelectorAll(selectors)
  let best = null
  let bestArea = 0
  for (const el of nodes) {
    if (!(el instanceof HTMLElement) || el.offsetWidth === 0) continue
    const r = el.getBoundingClientRect()
    if (r.width < 20 || r.height < 20 || r.bottom <= 0 || r.top >= window.innerHeight) continue
    const area = r.width * r.height
    if (area > bestArea) {
      bestArea = area
      best = el
    }
  }
  return best
}

function isVisiblePanel(el) {
  if (!(el instanceof HTMLElement) || el.offsetWidth < 20 || el.offsetHeight < 20) return false
  const style = getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden') return false
  if (Number(style.opacity || 1) < 0.05) return false
  const r = el.getBoundingClientRect()
  return r.width >= 20 && r.height >= 20 && r.bottom > 0 && r.top < window.innerHeight
}

function collectFrostPanels(dpr, screenH, now) {
  const panels = []
  const seen = new Set()
  for (const el of _cachedFrostPanels) {
    if (!el.isConnected || seen.has(el)) continue
    if (!isVisiblePanel(el)) continue
    seen.add(el)
    const r = getCachedRect(el, now)
    const halfW = (r.width * 0.5) * dpr
    const halfH = (r.height * 0.5) * dpr
    const radius = Math.min(18 * dpr, halfW, halfH)
    panels.push({
      centerX: (r.left + r.width * 0.5) * dpr,
      centerY: (screenH - (r.top + r.height * 0.5)) * dpr,
      halfW,
      halfH,
      radius,
    })
    if (panels.length >= 16) break
  }
  return panels
}

function regionFromEl(el, dpr, screenH, radius = 14, now = 0) {
  if (!el) return null
  const r = getCachedRect(el, now)
  if (r.width < 20 || r.height < 20) return null
  return {
    has: 1,
    centerX: (r.left + r.width * 0.5) * dpr,
    centerY: (screenH - (r.top + r.height * 0.5)) * dpr,
    halfW: (r.width * 0.5) * dpr,
    halfH: (r.height * 0.5) * dpr,
    radius: radius * dpr,
  }
}

/**
 * @param {number} dpr
 * @param {number} screenH CSS px viewport height
 * @param {number} now performance.now()
 */
export function collectEvoFlowGlassGeometry(dpr, screenH, now) {
  const throttle = geoThrottleMs()
  if (_geoCache && throttle > 0 && now - _geoCache.at < throttle) {
    return _geoCache.result
  }

  _scanCounter++
  const scanEvery = document.documentElement.dataset.lgVideoBg === '1' ? 24 : 12
  if (_scanCounter % scanEvery === 0) {
    _cachedLenses = []
    for (const sel of LENS_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (el instanceof HTMLElement) _cachedLenses.push(el)
      }
    }
    _cachedFrostPanels = []
    for (const sel of FROST_PANEL_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (el instanceof HTMLElement) _cachedFrostPanels.push(el)
      }
    }
  }

  let sidebarWidthPx = 0
  const sidebarEl = document.querySelector(SIDEBAR_SELECTORS)
  if (sidebarEl instanceof HTMLElement) {
    const sRect = sidebarEl.getBoundingClientRect()
    if (sRect.width > 0) sidebarWidthPx = (sRect.left + sRect.width) * dpr
  }

  const chatEl = pickLargestVisible(CHAT_SELECTORS)
  const chat = regionFromEl(chatEl, dpr, screenH, 18, now) || { has: 0 }

  const headerEl = document.querySelector(HEADER_SELECTORS)
  const header = regionFromEl(headerEl, dpr, screenH, 0, now) || { has: 0 }

  let hasModal = 0
  let modalCenterX = 0
  let modalCenterY = 0
  let modalHalfW = 0
  let modalHalfH = 0
  let modalRadius = 20 * dpr
  let modalProgress = 0

  const overlay = document.querySelector('.modal-overlay, .react-chat-modal-overlay')
  const modalEl = overlay
    ? overlay.querySelector('.modal, .react-chat-modal') || document.querySelector(MODAL_SELECTORS)
    : document.querySelector('.modal:not([hidden])')

  if (modalEl instanceof HTMLElement && overlay instanceof HTMLElement) {
    const oStyle = getComputedStyle(overlay)
    const visible =
      oStyle.display !== 'none' &&
      oStyle.visibility !== 'hidden' &&
      Number(oStyle.opacity || 1) > 0.05
    if (visible) {
      const mRect = modalEl.getBoundingClientRect()
      if (mRect.width > 40 && mRect.height > 40) {
        hasModal = 1
        modalProgress = 1
        modalCenterX = (mRect.left + mRect.width * 0.5) * dpr
        modalCenterY = (screenH - (mRect.top + mRect.height * 0.5)) * dpr
        modalHalfW = (mRect.width * 0.5) * dpr
        modalHalfH = (mRect.height * 0.5) * dpr
      }
    }
  }

  const lenses = []
  for (const el of _cachedLenses) {
    if (!el.isConnected) continue
    if (el.closest('[role="dialog"] .modal, .react-chat-modal-overlay') && !el.matches('.react-chat-bottom-area')) {
      continue
    }
    const r = el.getBoundingClientRect()
    if (r.bottom <= 0 || r.top >= screenH) continue
    const isComposer = el.matches('.react-chat-bottom-area')
    const lens = rectToLens(r, dpr, screenH, isComposer ? 16 : 12)
    if (lens) lenses.push(lens)
  }

  const frostPanels = collectFrostPanels(dpr, screenH, now)

  const result = {
    sidebarWidthPx,
    chat,
    header,
    modal: { has: hasModal, modalCenterX, modalCenterY, modalHalfW, modalHalfH, modalRadius, modalProgress },
    lenses,
    frostPanels,
    now,
  }
  _geoCache = { result, at: now }
  return result
}
