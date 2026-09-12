/**
 * 桌面端（Tauri）系统通知：Windows/macOS 通知中心（如 Win11 右下角气泡）。
 * Web 模式无操作。
 */

const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

const LS_ENABLED = 'evopanel_desktop_notify_enabled'

/** @type {Promise<boolean> | null} */
let permissionReady = null

/** @type {Map<string, number>} */
const recentTags = new Map()

/** @type {boolean | null} */
let actionListenerSupported = null

/** @type {Promise<unknown> | null} */
let actionListenerReady = null

const DEDUPE_MS = 4000

function isNotificationListenerUnsupported(err) {
  const msg = String(err?.message || err || '')
  return /registerListener|Command not found|not allowed/i.test(msg)
}


export function isDesktopNotifyEnabled() {
  if (!isTauri) return false
  try {
    const v = localStorage.getItem(LS_ENABLED)
    if (v === '0' || v === 'false') return false
  } catch {
    /* ignore */
  }
  return true
}

export function setDesktopNotifyEnabled(on) {
  try {
    localStorage.setItem(LS_ENABLED, on ? '1' : '0')
  } catch {
    /* ignore */
  }
}

async function ensurePermission() {
  if (!isTauri) return false
  if (permissionReady !== null) return permissionReady
  permissionReady = (async () => {
    try {
      const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification')
      let granted = await isPermissionGranted()
      if (!granted) {
        const p = await requestPermission()
        granted = p === 'granted'
      }
      return granted
    } catch (e) {
      console.warn('[desktop-notify] permission failed', e)
      return false
    }
  })()
  return permissionReady
}

function shouldSend(tag) {
  if (!tag) return true
  const now = Date.now()
  const last = recentTags.get(tag) || 0
  if (now - last < DEDUPE_MS) return false
  recentTags.set(tag, now)
  if (recentTags.size > 64) {
    for (const [k, t] of recentTags) {
      if (now - t > 60000) recentTags.delete(k)
    }
  }
  return true
}

function applyDeepLinkHash(hash) {
  const raw = String(hash || '').trim()
  if (!raw) return
  const next = raw.startsWith('#') ? raw : `#${raw}`
  try {
    if (String(window.location.hash || '') !== next) {
      window.location.hash = next
    } else {
      // Force hashchange consumers to re-apply highlight when already on the route
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    }
  } catch (e) {
    console.warn('[desktop-notify] deep link failed', e)
  }
}

/**
 * @param {{ title: string, body?: string, tag?: string, extra?: Record<string, unknown> }} opts
 */
export async function notifyDesktopCompletion(opts) {
  if (!isTauri || !isDesktopNotifyEnabled()) return
  const title = String(opts?.title || 'EvoFlow').trim() || 'EvoFlow'
  const body = String(opts?.body || '').trim()
  const tag = opts?.tag ? String(opts.tag) : ''
  if (!shouldSend(tag)) return
  try {
    const granted = await ensurePermission()
    if (!granted) return
    const { sendNotification } = await import('@tauri-apps/plugin-notification')
    /** @type {Record<string, unknown>} */
    const payload = body ? { title, body: body.slice(0, 500) } : { title }
    if (opts?.extra && typeof opts.extra === 'object') {
      payload.extra = opts.extra
    }
    sendNotification(payload)
  } catch (e) {
    console.warn('[desktop-notify] send failed', e)
  }
}

/** 应用启动时预请求通知权限，并监听点击深链（仅 Tauri） */
export function initDesktopNotifications() {
  if (!isTauri) return
  void ensurePermission()
  if (actionListenerReady || actionListenerSupported === false) return
  actionListenerReady = (async () => {
    try {
      const { onAction } = await import('@tauri-apps/plugin-notification')
      await onAction((notification) => {
        const extra = notification?.extra
        if (!extra || typeof extra !== 'object') return
        const hash = extra.hash || extra.route || extra.href
        if (hash) applyDeepLinkHash(String(hash))
      })
      actionListenerSupported = true
    } catch (e) {
      if (isNotificationListenerUnsupported(e)) {
        actionListenerSupported = false
        console.debug('[desktop-notify] click deep-link listener unavailable in this shell; rebuild Tauri app to enable')
        return
      }
      console.warn('[desktop-notify] onAction failed', e)
    }
  })()
}
