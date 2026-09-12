/**
 * postMessage bridge between host shell and embedded extension page.
 * Protocol: channel = "evoflow-extension", v = 1
 */
import { api } from './tauri-api.js'
import { navigate } from '../router.js'

const CHANNEL = 'evoflow-extension'

/**
 * @param {{ iframe: HTMLIFrameElement, extensionId: string, manifest: object }} opts
 * @returns {() => void} cleanup
 */
export function attachUiExtensionBridge({ iframe, extensionId, manifest }) {
  const allow = new Set(
    (manifest?.bridge?.origin_allowlist || []).map((o) => String(o || '').trim()).filter(Boolean),
  )
  // If entry is http(s), also allow its origin
  try {
    const entry = String(manifest?.ui?.entry || '')
    if (/^https?:/i.test(entry)) allow.add(new URL(entry).origin)
  } catch {
    /* ignore */
  }
  const perms = new Set(manifest?.permissions || ['embed'])

  const onMessage = async (event) => {
    const data = event.data
    if (!data || data.channel !== CHANNEL || Number(data.v) !== 1) return
    if (String(data.extensionId || '') !== String(extensionId)) return
    if (allow.size > 0 && event.origin && event.origin !== 'null' && !allow.has(event.origin)) {
      reply(event, data.requestId, false, null, 'origin 不在 allowlist')
      return
    }
    // Prefer messages from our iframe
    if (iframe.contentWindow && event.source && event.source !== iframe.contentWindow) {
      return
    }

    const method = String(data.method || '')
    const params = data.params && typeof data.params === 'object' ? data.params : {}

    try {
      if (method === 'ready') {
        requirePerm(perms, 'embed')
        reply(event, data.requestId, true, { extensionId, ok: true })
        return
      }
      if (method === 'context.get') {
        requirePerm(perms, 'context.read')
        reply(event, data.requestId, true, {
          extensionId,
          route: String(window.location.hash || ''),
          locale: navigator.language || 'zh-CN',
        })
        return
      }
      if (method === 'tasks.open') {
        requirePerm(perms, 'tasks.open')
        const tid = String(params.taskId || params.task_id || '').trim()
        if (!tid) throw new Error('taskId 必填')
        navigate(`/task/${encodeURIComponent(tid)}`)
        reply(event, data.requestId, true, { opened: tid })
        return
      }
      if (method === 'tasks.dispatch') {
        requirePerm(perms, 'tasks.dispatch')
        const agent = String(params.agent_code || params.agentCode || '').trim()
        const goal = String(params.goal || params.description || '').trim()
        if (!agent) throw new Error('agent_code 必填')
        if (!goal) throw new Error('goal 必填')
        const payload = {
          goal,
          description: String(params.description || goal).trim(),
          source: 'extension',
          from_agent: String(params.from_agent || extensionId).trim(),
        }
        const out = await api.proactiveDispatchRole(agent, payload)
        reply(event, data.requestId, true, out)
        return
      }
      if (method === 'extensions.open') {
        requirePerm(perms, 'embed')
        const targetId = String(params.id || params.extensionId || '').trim()
        if (!targetId) throw new Error('id 必填')
        const entry = String(params.entry || params.url || '').trim()
        if (entry) {
          try {
            sessionStorage.setItem(`evoflow_uiext_entry:${targetId}`, entry)
          } catch {
            /* ignore */
          }
        }
        navigate(`/extensions/${encodeURIComponent(targetId)}`)
        reply(event, data.requestId, true, { opened: targetId, entry: entry || null })
        return
      }
      reply(event, data.requestId, false, null, `未知 method: ${method}`)
    } catch (e) {
      reply(event, data.requestId, false, null, String(e?.message || e))
    }
  }

  window.addEventListener('message', onMessage)
  return () => window.removeEventListener('message', onMessage)
}

function requirePerm(perms, need) {
  if (!perms.has(need) && !(need === 'embed' && perms.size === 0)) {
    if (!perms.has(need)) throw new Error(`缺少权限: ${need}`)
  }
}

function reply(event, requestId, ok, result, error) {
  const target = event.source
  if (!target || typeof target.postMessage !== 'function') return
  const origin = event.origin && event.origin !== 'null' ? event.origin : '*'
  try {
    target.postMessage(
      {
        channel: CHANNEL,
        v: 1,
        requestId,
        ok,
        result: ok ? result : undefined,
        error: ok ? undefined : error || 'error',
      },
      origin,
    )
  } catch {
    try {
      target.postMessage(
        { channel: CHANNEL, v: 1, requestId, ok, result, error },
        '*',
      )
    } catch {
      /* ignore */
    }
  }
}

/** Optional helper for extension authors (injectable). */
export function createUiExtensionClient(extensionId) {
  const pending = new Map()
  window.addEventListener('message', (event) => {
    const data = event.data
    if (!data || data.channel !== CHANNEL || !data.requestId) return
    const p = pending.get(data.requestId)
    if (!p) return
    pending.delete(data.requestId)
    if (data.ok) p.resolve(data.result)
    else p.reject(new Error(data.error || 'bridge error'))
  })
  function call(method, params = {}) {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject })
      window.parent.postMessage(
        { channel: CHANNEL, v: 1, extensionId, requestId, method, params },
        '*',
      )
      setTimeout(() => {
        if (pending.has(requestId)) {
          pending.delete(requestId)
          reject(new Error('bridge timeout'))
        }
      }, 30000)
    })
  }
  return {
    ready: () => call('ready'),
    getContext: () => call('context.get'),
    openTask: (taskId) => call('tasks.open', { taskId }),
    dispatch: (agent_code, goal, extra = {}) =>
      call('tasks.dispatch', { agent_code, goal, ...extra }),
    openExtension: (id, entry) =>
      call('extensions.open', { id, entry: entry || undefined }),
  }
}
