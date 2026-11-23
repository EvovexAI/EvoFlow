/**
 * 非主对话页挂载 V4 小V dock（React）。
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { XiaomiV4Dock } from './XiaomiV4Dock.tsx'
import { notifyLayoutChromeChanged } from '../../lib/layout-chrome.js'

/** @type {import('react-dom/client').Root | null} */
let _root = null
/** @type {HTMLElement | null} */
let _host = null
let _open = false

const XM_DOCK_MIN = 300

function savedWidthPx() {
  const n = Number(localStorage.getItem('xm-dock-width') || 0)
  const max = Math.min(640, Math.round(window.innerWidth * 0.7))
  return n >= XM_DOCK_MIN ? Math.min(n, max) : 400
}

function applyDockChrome(open) {
  try {
    const root = document.documentElement
    const w = `${savedWidthPx()}px`
    root.classList.toggle('is-xm-docked', !!open)
    root.style.setProperty('--xm-dock-width', open ? w : '0px')
    root.style.setProperty('--xm-v4-dock-width', open ? w : '0px')
    if (open) root.dataset.xmV4Dock = '1'
    else delete root.dataset.xmV4Dock
  } catch {
    /* ignore */
  }
  requestAnimationFrame(() => {
    notifyLayoutChromeChanged(open ? 'dock-open' : 'dock-close')
  })
}

function ensureHost() {
  if (_host && document.body.contains(_host)) return _host
  const el = document.createElement('div')
  el.id = 'xiaomi-v4-dock-host'
  el.className = 'xm-v4-dock-host'
  document.body.appendChild(el)
  _host = el
  return el
}

export function isXiaomiV4DockOpen() {
  return _open
}

/**
 * @param {{ onClose?: () => void }} [opts]
 */
export function openXiaomiV4Dock(opts = {}) {
  const host = ensureHost()
  if (!_root) _root = createRoot(host)
  const close = () => {
    closeXiaomiV4Dock()
    try {
      opts.onClose?.()
    } catch {
      /* ignore */
    }
  }
  _open = true
  applyDockChrome(true)
  _root.render(createElement(XiaomiV4Dock, { onClose: close }))
  try {
    window.dispatchEvent(new CustomEvent('evopanel:xiaomi-v4-dock', { detail: { open: true } }))
  } catch {
    /* ignore */
  }
}

export function closeXiaomiV4Dock() {
  _open = false
  applyDockChrome(false)
  try {
    _root?.render(null)
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(new CustomEvent('evopanel:xiaomi-v4-dock', { detail: { open: false } }))
  } catch {
    /* ignore */
  }
}

export function toggleXiaomiV4Dock(opts = {}) {
  if (_open) closeXiaomiV4Dock()
  else openXiaomiV4Dock(opts)
}
