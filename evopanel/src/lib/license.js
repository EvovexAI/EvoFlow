/** Runtime premium entitlement (tasks / apps / proactive). */

/**
 * 关闭后：不拦截高级功能路由；隐藏激活码/授权相关入口。
 * 激活/签发 API 与页面代码保留，改回 true 即可恢复校验与展示。
 */
export const LICENSE_GATE_ENABLED = false

/** @type {{
 *   machine_id: string,
 *   activated: boolean,
 *   expires_at: string | null,
 *   features: string[],
 *   status: string,
 *   activated_at: string | null,
 *   premium: boolean,
 *   days_remaining?: number | null,
 *   duration_days?: number | null,
 * } | null} */
let _status = null

/** @type {Array<() => void>} */
const _listeners = []

export function getLicenseStatus() {
  return _status
}

export function isPremiumActive() {
  if (!LICENSE_GATE_ENABLED) return true
  return !!( _status && _status.premium )
}

/**
 * @param {typeof _status} status
 */
export function setLicenseStatus(status) {
  _status = status
  for (const fn of _listeners.slice()) {
    try {
      fn()
    } catch {
      /* ignore */
    }
  }
}

/** @param {() => void} fn */
export function onLicenseChange(fn) {
  _listeners.push(fn)
  return () => {
    const i = _listeners.indexOf(fn)
    if (i >= 0) _listeners.splice(i, 1)
  }
}

/** Fetch and cache license status from Gateway. */
export async function refreshLicenseStatus() {
  const { api } = await import('./tauri-api.js')
  const st = await api.licenseStatus()
  setLicenseStatus(st && typeof st === 'object' ? st : null)
  return _status
}

/** Premium feature routes that require activation. */
export function isPremiumRoute(path) {
  const p = String(path || '').split('?')[0]
  if (p === '/tasks' || p.startsWith('/task/')) return true
  if (p === '/apps' || p.startsWith('/apps/')) return true
  if (p === '/proactive' || p.startsWith('/proactive/')) return true
  return false
}

export function licenseSettingsHash() {
  return '/settings?tab=license'
}
