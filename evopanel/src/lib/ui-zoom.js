/**
 * 整体界面缩放（Ctrl+= 放大 / Ctrl+- 缩小 / Ctrl+0 复位）
 * 独立于「字体大小」偏好：本模块用 CSS zoom 等比缩放整个界面（含布局），
 * 两者可叠加。宽度持久化在 localStorage（xm-ui-zoom）。
 */
const KEY = 'xm-ui-zoom'
const MIN = 0.8
const MAX = 2.0
const STEP = 0.1

let _scale = (() => {
  const n = Number(localStorage.getItem(KEY) || 1)
  return Number.isFinite(n) && n >= MIN && n <= MAX ? n : 1
})()

let _toastTimer = null

export function getUiZoom() {
  return _scale
}

export function setUiZoom(next) {
  setScale(next)
}

let _tauriApiPromise = null

async function apply() {
  // Tauri 桌面端：用原生页面缩放（CSS zoom 在 WebKit 里对固定定位侧栏缩放不均）
  if (window.__TAURI_INTERNALS__) {
    try {
      if (!_tauriApiPromise) {
        _tauriApiPromise = import('@tauri-apps/api/core').then((m) => m.invoke)
      }
      const invoke = await _tauriApiPromise
      await invoke('set_webview_zoom', { scale: _scale })
      return
    } catch { /* 回退到 CSS zoom */ }
  }
  document.documentElement.style.zoom = _scale === 1 ? '' : String(_scale)
}

function toast(text) {
  let el = document.getElementById('ui-zoom-toast')
  if (!el) {
    el = document.createElement('div')
    el.id = 'ui-zoom-toast'
    el.style.cssText =
      'position:fixed;left:50%;bottom:56px;transform:translateX(-50%);z-index:99999;' +
      'background:rgba(24,24,28,.88);color:#e4e4e7;font-size:13px;padding:8px 16px;' +
      'border-radius:999px;border:1px solid rgba(128,128,128,.4);backdrop-filter:blur(6px);' +
      'pointer-events:none;transition:opacity .25s;opacity:0'
    document.body.appendChild(el)
  }
  el.textContent = text
  el.style.opacity = '1'
  clearTimeout(_toastTimer)
  _toastTimer = setTimeout(() => { el.style.opacity = '0' }, 1200)
}

function setScale(next) {
  const v = Math.min(MAX, Math.max(MIN, Math.round(next * 10) / 10))
  if (v === _scale) return
  _scale = v
  localStorage.setItem(KEY, String(_scale))
  apply()
  try {
    window.dispatchEvent(new CustomEvent('ui-zoom-change', { detail: { scale: _scale } }))
  } catch { /* ignore */ }
  toast(`界面缩放 ${Math.round(_scale * 100)}%`)
}

export function initUiZoom() {
  apply()
  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return
      const k = e.key
      if (k === '=' || k === '+' || e.code === 'NumpadAdd') {
        e.preventDefault()
        setScale(_scale + STEP)
      } else if (k === '-' || e.code === 'NumpadSubtract') {
        e.preventDefault()
        setScale(_scale - STEP)
      } else if (k === '0' || e.code === 'Numpad0') {
        e.preventDefault()
        setScale(1)
      }
    },
    { passive: false },
  )
  // Ctrl + 滚轮缩放
  window.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return
      e.preventDefault()
      setScale(_scale + (e.deltaY < 0 ? 0.05 : -0.05))
    },
    { passive: false },
  )
}
