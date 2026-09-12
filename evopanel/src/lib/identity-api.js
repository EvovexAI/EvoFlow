/**
 * Identity / ACL API client.
 * Backend: /api/identity/*
 *
 * Field contract: identity key is ``principalId`` (not userId).
 */
import { gatewayProxy } from './tauri-api.js'

export async function getMe() {
  return gatewayProxy('GET', '/identity/me')
}

export async function listPrincipals() {
  return gatewayProxy('GET', '/identity/principals')
}

/** @param {string} principalId */
export async function getPrincipal(principalId) {
  return gatewayProxy('GET', `/identity/principals/${encodeURIComponent(principalId)}`)
}

/**
 * @param {string} principalId
 * @param {{ displayName?: string, primaryEmail?: string|null, username?: string }} body
 */
export async function updatePrincipal(principalId, body) {
  return gatewayProxy('PATCH', `/identity/principals/${encodeURIComponent(principalId)}`, body)
}

/**
 * Multipart avatar upload — stays on direct Gateway HTTP (FormData cannot go through
 * JSON-RPC gateway/call). Desktop Network may show this path; that is intentional.
 * @param {string} principalId
 * @param {Blob|File} blob
 * @param {string} [filename]
 */
export async function uploadPrincipalAvatar(principalId, blob, filename = 'avatar.webp') {
  const { getGatewayBaseUrl } = await import('./tauri-api.js')
  const { getAuthToken } = await import('./webui-remote.js')
  const base = await getGatewayBaseUrl()
  const form = new FormData()
  form.append('file', blob, filename)
  const headers = {}
  const token = getAuthToken()
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${base}/api/identity/principals/${encodeURIComponent(principalId)}/avatar`, {
    method: 'POST',
    body: form,
    headers,
  })
  const text = await res.text()
  let result
  try {
    result = JSON.parse(text)
  } catch {
    result = text
  }
  if (!res.ok) {
    const detail = result?.detail
    throw new Error(typeof detail === 'string' ? detail : `Upload failed: ${res.status}`)
  }
  return result
}

/** @param {string} principalId */
export async function deletePrincipalAvatar(principalId) {
  return gatewayProxy('DELETE', `/identity/principals/${encodeURIComponent(principalId)}/avatar`)
}

/**
 * @param {string} principalId
 * @param {{ newPassword?: string }} [body]
 */
export async function resetPrincipalPassword(principalId, body = {}) {
  return gatewayProxy('POST', `/identity/principals/${encodeURIComponent(principalId)}/reset-password`, body)
}

/**
 * @param {{ displayName: string, username?: string, password?: string, primaryEmail?: string, promoteAdmin?: boolean }} body
 */
export async function createPrincipal(body) {
  return gatewayProxy('POST', '/identity/principals', body)
}

/**
 * @param {string} principalId
 * @param {'active'|'deactivated'} status
 */
export async function setPrincipalStatus(principalId, status) {
  return gatewayProxy('POST', `/identity/principals/${encodeURIComponent(principalId)}/status`, { status })
}

/** @param {string} principalId */
export async function promoteAdmin(principalId) {
  return gatewayProxy('POST', `/identity/principals/${encodeURIComponent(principalId)}/promote-admin`)
}

/** @param {string} principalId */
export async function revokeAdmin(principalId) {
  return gatewayProxy('DELETE', `/identity/principals/${encodeURIComponent(principalId)}/admin`)
}

export async function listGroups() {
  return gatewayProxy('GET', '/identity/groups')
}

/** @param {{ name: string, kind?: string }} body */
export async function createGroup(body) {
  return gatewayProxy('POST', '/identity/groups', body)
}
