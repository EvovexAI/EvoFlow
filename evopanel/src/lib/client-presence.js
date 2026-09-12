/**
 * EvoPanel client instance registration — backend stops orphaned panel runs on gateway cold attach.
 */

const STORAGE_KEY = 'evopanel_client_instance_id'

function isTauriRuntime() {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
}

function readStoredClientInstanceId() {
  try {
    const fromLocal = localStorage.getItem(STORAGE_KEY)
    if (fromLocal) return fromLocal
  } catch {
    /* ignore */
  }
  try {
    return sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStoredClientInstanceId(id) {
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.setItem(STORAGE_KEY, id)
  } catch {
    /* ignore */
  }
}

function createClientInstanceId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    /* ignore */
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export function getClientInstanceId() {
  let id = readStoredClientInstanceId()
  if (!id) {
    id = createClientInstanceId()
    writeStoredClientInstanceId(id)
  }
  if (isTauriRuntime() && typeof window !== 'undefined') {
    window.__evopanelClientInstanceId = id
  }
  return id
}

let attachInflight = null

/** Call once per page load before reading session execution state. */
export async function attachClientToGateway() {
  if (attachInflight) return attachInflight
  attachInflight = (async () => {
    const { gatewayJson } = await import('./gateway-json.js')
    return gatewayJson('POST', '/api/client/attach', {
      client_instance_id: getClientInstanceId(),
    })
  })()
  try {
    return await attachInflight
  } catch (e) {
    attachInflight = null
    throw e
  }
}
