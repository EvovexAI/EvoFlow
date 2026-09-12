/**
 * WebUI remote-access API client.
 * Backend: /api/webui/* (status, enable, disable, login, qr-login, credentials, qr-token).
 */

import { gatewayProxy, getGatewayBaseUrl } from './tauri-api.js'

/**
 * Get WebUI status (public — no auth required).
 * @returns {Promise<{ enabled: boolean, running: boolean, admin_username: string, password_set: boolean, access_urls: string[], lan_ip: string|null }>}
 */
export async function getWebuiStatus() {
  return gatewayProxy('GET', '/webui/status')
}

/**
 * Enable WebUI remote access (local-only).
 * @param {{ username?: string, password?: string }} [body]
 * @returns {Promise<{ enabled: boolean, initial_password: string|null, admin_username: string, access_urls: string[] }>}
 */
export async function enableWebui(body = null) {
  return gatewayProxy('POST', '/webui/enable', body)
}

/**
 * Disable WebUI remote access (local-only).
 * @returns {Promise<{ disabled: boolean }>}
 */
export async function disableWebui() {
  return gatewayProxy('POST', '/webui/disable')
}

/**
 * Login with username + password.
 * @param {{ username: string, password: string }} body
 * @returns {Promise<{ token: string, expires_in_days: number, username: string }>}
 */
export async function login(body) {
  return gatewayProxy('POST', '/webui/login', body)
}

/**
 * Login with QR token.
 * @param {{ qr_token: string }} body
 * @returns {Promise<{ token: string, expires_in_days: number, username: string }>}
 */
export async function qrLogin(body) {
  return gatewayProxy('POST', '/webui/qr-login', body)
}

/**
 * Change admin password (local-only).
 * @param {{ new_password: string }} body
 * @returns {Promise<{ changed: boolean }>}
 */
export async function changePassword(body) {
  return gatewayProxy('POST', '/webui/change-password', body)
}

/**
 * Change admin username (local-only).
 * @param {{ new_username: string }} body
 * @returns {Promise<{ username: string }>}
 */
export async function changeUsername(body) {
  return gatewayProxy('POST', '/webui/change-username', body)
}

/**
 * Reset admin password to random (local-only). Returns new plaintext once.
 * @returns {Promise<{ new_password: string }>}
 */
export async function resetPassword() {
  return gatewayProxy('POST', '/webui/reset-password')
}

/**
 * Generate a QR login token (local-only, 5-min TTL).
 * @returns {Promise<{ token: string, expires_at_ms: number }>}
 */
export async function generateQrToken() {
  return gatewayProxy('POST', '/webui/generate-qr-token')
}

/**
 * Get LAN access URLs (local-only).
 * @returns {Promise<{ urls: string[], lan_ip: string|null }>}
 */
export async function getAccessUrls() {
  return gatewayProxy('GET', '/webui/access-urls')
}

/**
 * Get OIDC / SSO configuration (public — secret masked).
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getOidcConfig() {
  return gatewayProxy('GET', '/webui/oidc/config')
}

/**
 * Update OIDC configuration (local-only).
 * @param {Record<string, unknown>} body
 * @returns {Promise<Record<string, unknown>>}
 */
export async function updateOidcConfig(body) {
  return gatewayProxy('PUT', '/webui/oidc/config', body)
}

/**
 * Build the URL to start OIDC login (browser redirect).
 * @param {{ redirect?: string }} [opts]
 * @returns {Promise<string>}
 */
export async function buildOidcLoginUrl(opts = {}) {
  const redirect = opts.redirect || '/chat'
  const q = new URLSearchParams({ redirect })
  const base = (await getGatewayBaseUrl()).replace(/\/$/, '')
  const prefix = base ? `${base}/api` : '/api'
  return `${prefix}/webui/oidc/login?${q}`
}

/**
 * Store the JWT token in localStorage (for browser/remote sessions).
 * @param {string} token
 */
export function saveAuthToken(token) {
  try {
    localStorage.setItem('evoflow_webui_token', token)
    const maxAge = 7 * 86400
    document.cookie = `evoflow_webui_token=${encodeURIComponent(token)}; path=/; max-age=${maxAge}; SameSite=Lax`
  } catch { /* ignore */ }
}

/**
 * Get the stored JWT token.
 * @returns {string|null}
 */
export function getAuthToken() {
  try {
    return localStorage.getItem('evoflow_webui_token')
  } catch {
    return null
  }
}

/**
 * Clear the stored JWT token.
 */
export function clearAuthToken() {
  try {
    localStorage.removeItem('evoflow_webui_token')
    document.cookie = 'evoflow_webui_token=; path=/; max-age=0'
  } catch { /* ignore */ }
}

/**
 * Check if a JWT token exists.
 * @returns {boolean}
 */
export function hasAuthToken() {
  return !!getAuthToken()
}
