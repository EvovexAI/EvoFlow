/**
 * Toast 通知组件
 */
/** @type {HTMLElement | null} */
let _container = null
/** @type {HTMLElement | null} */
let _containerTopRight = null
/** @type {Map<string, HTMLElement>} */
const _toastsByKey = new Map()

const SETTINGS_MODAL_ID = 'evopanel-settings-modal-overlay'
const SETTINGS_ERROR_ATTR = 'data-settings-modal-error'
/** Above `.react-chat-modal-overlay` (1000001) so toasts remain visible in Settings. */
const TOAST_ABOVE_MODAL_Z = '1000010'

/** @param {'top-center' | 'top-right'} [position] */
function ensureContainer(position = 'top-center') {
  if (position === 'top-right') {
    if (!_containerTopRight) {
      _containerTopRight = document.createElement('div')
      _containerTopRight.className = 'toast-container toast-container--top-right'
      document.body.appendChild(_containerTopRight)
    }
    return _containerTopRight
  }
  if (!_container) {
    _container = document.createElement('div')
    _container.className = 'toast-container'
    document.body.appendChild(_container)
  }
  return _container
}

function isSettingsModalOpen() {
  return !!document.getElementById(SETTINGS_MODAL_ID)
}

function syncToastLayer() {
  const settingsOpen = isSettingsModalOpen()
  const modalOpen =
    !!document.querySelector('.modal-overlay') ||
    !!document.querySelector('.react-chat-modal-overlay')
  const elevate = modalOpen || settingsOpen
  for (const container of [_container, _containerTopRight]) {
    if (!container) continue
    container.classList.toggle('toast-container--modal-open', settingsOpen)
    container.classList.toggle('toast-container--elevated', modalOpen)
    container.style.zIndex = elevate ? TOAST_ABOVE_MODAL_Z : ''
  }
}

function ensureSettingsErrorBanner(overlay) {
  let banner = overlay.querySelector(`[${SETTINGS_ERROR_ATTR}]`)
  if (banner) return banner

  const card = overlay.querySelector('.react-chat-modal-card')
  if (!card) return null

  banner = document.createElement('div')
  banner.className = 'settings-modal-error-banner'
  banner.setAttribute(SETTINGS_ERROR_ATTR, '')
  banner.setAttribute('role', 'alert')
  banner.hidden = true

  const body = card.querySelector('.react-chat-modal-body')
  if (body) {
    card.insertBefore(banner, body)
  } else {
    card.appendChild(banner)
  }
  return banner
}

function showSettingsErrorBanner(message) {
  const overlay = document.getElementById(SETTINGS_MODAL_ID)
  if (!overlay) return

  const banner = ensureSettingsErrorBanner(overlay)
  if (!banner) return

  banner.textContent = message
  banner.hidden = false
  banner.classList.add('settings-modal-error-banner--visible')

  if (banner._hideTimer) clearTimeout(banner._hideTimer)
  banner._hideTimer = setTimeout(() => {
    banner.hidden = true
    banner.classList.remove('settings-modal-error-banner--visible')
  }, 6000)
}

function clearToastHideTimer(el) {
  if (el?._hideTimer) {
    clearTimeout(el._hideTimer)
    el._hideTimer = 0
  }
  if (el?._removeTimer) {
    clearTimeout(el._removeTimer)
    el._removeTimer = 0
  }
}

function scheduleToastRemove(el, duration, key) {
  clearToastHideTimer(el)
  el.style.opacity = ''
  el.style.transform = ''
  el.style.transition = ''
  el._hideTimer = setTimeout(() => {
    el.style.opacity = '0'
    el.style.transform = 'translateY(6px) scale(0.98)'
    el.style.transition = 'opacity 250ms var(--ease-out-soft, ease-out), transform 250ms var(--ease-out-soft, ease-out)'
    el._removeTimer = setTimeout(() => {
      if (key && _toastsByKey.get(key) === el) _toastsByKey.delete(key)
      el.remove()
    }, 250)
  }, duration)
}

/**
 * @param {string} message
 * @param {'info'|'success'|'warning'|'error'} [type]
 * @param {{ duration?: number, action?: HTMLElement, key?: string, position?: 'top-center'|'top-right' }} [options]
 *   key: 相同 key 只保留一条（更新文案并重置计时），避免写入过程刷屏
 *   position: 默认 top-center；唤醒等旁路提示用 top-right，避免挡屏幕正中
 */
export function toast(message, type = 'info', options = {}) {
  const duration = options.duration || 3000
  const action = options.action // 可选的操作按钮（DOM 元素）
  const key = typeof options.key === 'string' && options.key ? options.key : ''
  const position = options.position === 'top-right' ? 'top-right' : 'top-center'

  // 确保默认容器也存在，便于统一抬升层级
  ensureContainer('top-center')
  const container = ensureContainer(position)
  syncToastLayer()

  if ((type === 'error' || type === 'warning') && isSettingsModalOpen()) {
    showSettingsErrorBanner(message)
  }

  if (key) {
    const existing = _toastsByKey.get(key)
    if (existing && existing.isConnected) {
      existing.className = `toast ${type}`
      const textSpan = existing.querySelector('span')
      if (textSpan) textSpan.textContent = message
      else existing.textContent = message
      scheduleToastRemove(existing, duration, key)
      return
    }
  }

  const el = document.createElement('div')
  el.className = `toast ${type}`
  if (key) {
    el.dataset.toastKey = key
    _toastsByKey.set(key, el)
  }

  const textSpan = document.createElement('span')
  textSpan.textContent = message
  el.appendChild(textSpan)

  // 如果有操作按钮，添加到 toast 中
  if (action instanceof HTMLElement) {
    el.appendChild(action)
  }

  container.appendChild(el)
  scheduleToastRemove(el, duration, key)
}

toast.success = (message, options = {}) => toast(message, 'success', options)
toast.error = (message, options = {}) => toast(message, 'error', options)
toast.warning = (message, options = {}) => toast(message, 'warning', options)
toast.info = (message, options = {}) => toast(message, 'info', options)
