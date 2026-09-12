/**
 * 模态层：Tauri 遮罩可拖窗口 + Esc capture 关闭。
 */

export function isTauriDesktop() {
  return !!(typeof window !== 'undefined' && (window.__TAURI_INTERNALS__ || window.__TAURI__))
}

/**
 * 遮罩空白区可拖动窗口；面板区域标记 no-drag。
 * @param {HTMLElement} overlay
 * @param {string} [panelSelector]
 */
export function applyModalTauriDragChrome(overlay, panelSelector = '.modal, .react-chat-modal-card') {
  if (!isTauriDesktop() || !overlay) return
  overlay.setAttribute('data-tauri-drag-region', '')
  overlay.querySelectorAll(panelSelector).forEach((el) => {
    el.setAttribute('data-tauri-no-drag', '')
  })
}

/**
 * @param {() => void} onClose
 * @param {{ overlay?: HTMLElement | null, deferToNested?: boolean }} [opts]
 * @returns {() => void}
 */
export function listenModalEscape(onClose, opts = {}) {
  const { overlay = null, deferToNested = false } = opts
  const handler = (e) => {
    if (e.key !== 'Escape') return
    if (deferToNested) {
      const all = document.querySelectorAll('.modal-overlay, .react-chat-modal-overlay')
      if (all.length > 1 && all[all.length - 1] !== overlay) return
    }
    e.preventDefault()
    e.stopImmediatePropagation()
    onClose()
  }
  document.addEventListener('keydown', handler, true)
  return () => document.removeEventListener('keydown', handler, true)
}
