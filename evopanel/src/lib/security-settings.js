/**
 * Security center API client.
 * Backend: /api/settings/security
 */

import { gatewayProxy, getGatewayBaseUrl } from './tauri-api.js'

const API_BASE = '/settings/security'

/** @type {Record<string, any> | null} */
let _cache = null

export const SECURITY_SETTINGS_CHANGED = 'evopanel:security-settings-changed'

function _dispatchChanged() {
  try {
    window.dispatchEvent(new CustomEvent(SECURITY_SETTINGS_CHANGED, { detail: { settings: _cache } }))
  } catch {
    /* ignore */
  }
}

/**
 * Fetch the full security-center config (merged with defaults + live execution_security).
 * @returns {Promise<{ settings: Record<string, any>, defaults: Record<string, any> }>}
 */
export async function fetchSecuritySettings() {
  const data = await gatewayProxy('GET', API_BASE, null, null, { preferGatewayHttp: true })
  _cache = data?.settings || {}
  _dispatchChanged()
  return data
}

/** Return cached settings (call fetchSecuritySettings first to populate). */
export function getCachedSecuritySettings() {
  return _cache
}

/**
 * Deep-merge a partial patch into the stored security config.
 * May include nested ``execution_security`` (routed to the OS sandbox layer).
 * @param {Record<string, any>} patch
 * @returns {Promise<Record<string, any>>} merged settings
 */
export async function patchSecuritySettings(patch) {
  const data = await gatewayProxy('PATCH', API_BASE, { settings: patch })
  _cache = data?.settings || {}
  _dispatchChanged()
  return _cache
}

/**
 * Replace the entire security-center policy config.
 * @param {Record<string, any>} settings
 * @returns {Promise<Record<string, any>>}
 */
export async function replaceSecuritySettings(settings) {
  const data = await gatewayProxy('PUT', API_BASE, { settings })
  _cache = data?.settings || {}
  _dispatchChanged()
  return _cache
}

/**
 * Live host OS sandbox status (profile / helpers / mode).
 * @returns {Promise<Record<string, any>>}
 */
export async function fetchExecutionSecurity() {
  return gatewayProxy('GET', `${API_BASE}/execution`)
}

/**
 * Update host OS sandbox enablement / profile / approval.
 * Persists to SQLite and updates in-memory config.
 * @param {Record<string, any>} patch
 * @returns {Promise<Record<string, any>>} live status snapshot
 */
export async function patchExecutionSecurity(patch) {
  let data = await gatewayProxy('PATCH', `${API_BASE}/execution`, patch)
  // Dedicated endpoint must return a status snapshot (top-level ``enabled``).
  // If a proxy/old gateway hit the parent PATCH instead, fall back to nested save.
  if (!data || typeof data.enabled !== 'boolean') {
    const settings = await patchSecuritySettings({ execution_security: patch })
    data = settings?.execution_security
  }
  if (!data || typeof data.enabled !== 'boolean') {
    throw new Error('保存失败：网关未返回执行安全状态')
  }
  if (_cache && typeof _cache === 'object') {
    _cache = { ..._cache, execution_security: data }
    _dispatchChanged()
  }
  return data
}

// ── Audit endpoints ──────────────────────────────────────────

/**
 * List audit records with optional pagination and event_type filter.
 * @param {{ limit?: number, offset?: number, event_type?: string }} [opts]
 * @returns {Promise<{ records: any[], total: number, limit: number, offset: number }>}
 */
export async function fetchSecurityAudit(opts = {}) {
  const query = {}
  if (opts.limit) query.limit = String(opts.limit)
  if (opts.offset) query.offset = String(opts.offset)
  if (opts.event_type) query.event_type = opts.event_type
  return gatewayProxy('GET', `${API_BASE}/audit`, null, query, { preferGatewayHttp: true })
}

/**
 * Clear all audit records.
 * @returns {Promise<{ deleted: number }>}
 */
export async function clearSecurityAudit() {
  return gatewayProxy('DELETE', `${API_BASE}/audit`)
}

/**
 * Export audit records as CSV (triggers browser download).
 */
export async function exportSecurityAudit() {
  const base = await getGatewayBaseUrl()
  window.open(`${base}/api${API_BASE}/audit/export`, '_blank')
}
