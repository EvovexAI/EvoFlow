/**
 * 模态层：Tauri 遮罩可拖窗口 + Esc capture 关闭。
 */

export function isTauriDesktop() {
  return !!(typeof window !== 'undefined' && (window.__TAURI_INTERNALS__ || window.__TAURI__))
}

/**
 * 遮罩空白区可拖动窗口；面板区域标记 no-drag。
 * 适用于四周留白的普通弹窗（设置全屏弹窗请用 applyFullscreenModalTauriDragChrome）。
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
 * 全屏贴边弹窗（如设置）：没有遮罩空白可拖，必须在卡片顶部挂专用拖拽条。
 * 勿再给整卡打 data-tauri-no-drag，否则顶栏拖不动窗口。
 * @param {HTMLElement} overlay
 * @param {{ cardSelector?: string, dragSelector?: string }} [opts]
 */
export function applyFullscreenModalTauriDragChrome(overlay, opts = {}) {
  if (!isTauriDesktop() || !overlay) return
  const cardSelector = opts.cardSelector || '.react-chat-modal-card'
  const dragSelector = opts.dragSelector || '[data-fullscreen-modal-drag]'
  const card = overlay.querySelector(cardSelector)
  if (!card) return

  // 全屏卡盖住整窗：遮罩拖拽区无效，去掉以免误导后续维护
  overlay.removeAttribute('data-tauri-drag-region')
  card.removeAttribute('data-tauri-no-drag')

  const strips = card.querySelectorAll(dragSelector)
  strips.forEach((strip) => {
    strip.setAttribute('data-tauri-drag-region', '')
  })

  card
    .querySelectorAll(
      '[data-settings-modal-close], [data-settings-modal-cancel], [data-settings-modal-done], .react-chat-modal-actions, .ep-window-controls, .ep-window-controls-btn',
    )
    .forEach((el) => {
      el.setAttribute('data-tauri-no-drag', '')
    })

  void import('@tauri-apps/api/window')
    .then(({ getCurrentWindow }) => {
      const win = getCurrentWindow()
      strips.forEach((strip) => {
        if (strip.dataset.fullscreenModalDragBound) return
        strip.dataset.fullscreenModalDragBound = '1'
        strip.addEventListener('dblclick', () => void win.toggleMaximize())
      })
    })
    .catch(() => {})
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
