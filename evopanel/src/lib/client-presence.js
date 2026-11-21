/**
 * EvoPanel client instance registration — backend stops orphaned panel runs on gateway cold attach.
 *
 * Per-profile scoping: the instance id is prefixed with the active profile id
 * so two coexisting clients (installed = "default", dev = "dev") can never
 * collide on the same backend `client_presence` slot, and a Tauri dev window
 * and an installed client (when they happen to land on the same gateway) are
 * trivially distinguishable.
 */

const STORAGE_KEY = 'evopanel_client_instance_id'

function isTauriRuntime() {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
}

function readProfileId() {
  if (typeof window === 'undefined') return ''
  const raw = window.__EVOFLOW_PROFILE_ID__
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  try {
    const fromLs = localStorage.getItem('evoflow_profile_id')
    if (fromLs) return fromLs
  } catch {
    /* ignore */
  }
  return ''
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
    const profile = readProfileId() || 'unknown'
    const uuid = createClientInstanceId()
    id = `${profile}::${uuid}`
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
    const result = await attachInflight
    // 网关冷 attach / 客户端换 id 曾会批量掐 panel run；落 stream-stop 方便视口诊断看「谁停的」
    void noteClientAttachStop(result)
    return result
  } catch (e) {
    attachInflight = null
    throw e
  }
}

async function noteClientAttachStop(result) {
  if (!result || typeof result !== 'object') return
  try {
    const { logStreamStop } = await import('../react/lib/stream-stop-log.js')
    const stopped = result.stopped
    const chatKeys = Array.isArray(stopped?.chat_session_keys)
      ? stopped.chat_session_keys
      : []
    const reason = String(result.reason || stopped?.reason || '').trim()
    const cancelSkipped = !!result.cancel_skipped
    const reattached = !!result.reattached
    if (reattached) return
    if (cancelSkipped) {
      logStreamStop({
        trigger: reason === 'client_restart' ? 'client_restart_skip' : 'client_attach_skip',
        // 跳过批量停不是断流；记 normal，避免诊断里刷成「异常断流」
        hasEndMarker: true,
        detail: {
          whoZh:
            reason === 'client_restart'
              ? '客户端换实例 attach：默认未批量停止 panel run（可 stream-resume）'
              : '网关冷 attach：默认未批量停止 panel run（避免误掐刚发出的对话）',
          note: 'EVOFLOW_CLIENT_ATTACH_STOP_RUNS / EVOFLOW_CLIENT_RESTART_STOP_RUNS 可显式开启旧行为',
          cancel_skipped: true,
          reason: reason || null,
          previous_client_instance_id: result.previous_client_instance_id || null,
        },
      })
      return
    }
    if (chatKeys.length === 0) return
    for (const sk of chatKeys.slice(0, 12)) {
      logStreamStop({
        sessionKey: String(sk || ''),
        trigger: reason || 'client_attach',
        hasEndMarker: false,
        detail: {
          whoZh:
            reason === 'client_restart'
              ? '客户端换实例 attach：后端批量停止 panel run（非用户点停）'
              : '网关冷 attach：后端批量停止 panel run（非用户点停）',
          note: '历史误标「用户停止」的常见来源；现默认不再 stop（本条表示 opt-in 仍开着）',
          reason: reason || 'client_attach',
          stopped_count: chatKeys.length,
        },
      })
    }
  } catch {
    /* ignore — diag optional */
  }
}
