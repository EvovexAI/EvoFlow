/**
 * Desktop/web JSON Gateway calls via gatewayProxy (pipe when warm on Tauri).
 * Prefer this over WebView fetch(`${base}/api/...`) so desktop never hits Gateway directly.
 */

function isTauri() {
  return typeof window !== 'undefined' && !!(window.__TAURI_INTERNALS__ || window.__TAURI__)
}

/**
 * @param {string} method
 * @param {string} path - must start with /api or / (normalized to /api…)
 * @param {unknown} [body]
 * @param {Record<string, string>|null} [query]
 */
export async function gatewayJson(method, path, body = null, query = null) {
  const { gatewayProxy } = await import('./tauri-api.js')
  let p = String(path || '')
  if (!p.startsWith('/')) p = `/${p}`
  if (!p.startsWith('/api/') && p !== '/api') {
    p = `/api${p.startsWith('/') ? p : `/${p}`}`
  }
  return gatewayProxy(String(method || 'GET').toUpperCase(), p, body, query)
}

/**
 * Parse `/api/foo?a=1` into path + query map.
 * @param {string} url
 * @returns {{ path: string, query: Record<string, string>|null }}
 */
export function splitApiUrl(url) {
  const raw = String(url || '')
  const qIdx = raw.indexOf('?')
  const pathPart = qIdx >= 0 ? raw.slice(0, qIdx) : raw
  const search = qIdx >= 0 ? raw.slice(qIdx + 1) : ''
  /** @type {Record<string, string>|null} */
  let query = null
  if (search) {
    query = {}
    new URLSearchParams(search).forEach((v, k) => {
      query[k] = v
    })
  }
  return { path: pathPart, query }
}

/**
 * fetch()-like shim: ok / status / json() / text(). Throws are converted to ok:false.
 * On non-Tauri browser, uses relative fetch (Vite proxy / same-origin).
 * @param {string} url - e.g. `/api/models` or `/api/chat/sessions/x`
 * @param {RequestInit & { body?: any }} [init]
 */
export async function gatewayFetch(url, init = {}) {
  const method = String(init.method || 'GET').toUpperCase()
  const { path, query } = splitApiUrl(url)

  if (!isTauri()) {
    const headers = new Headers(init.headers || {})
    try {
      const token = localStorage.getItem('evoflow_webui_token')
      if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`)
    } catch {
      /* ignore */
    }
    let body = init.body
    if (body != null && typeof body === 'object' && !(body instanceof FormData) && !(body instanceof Blob)) {
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
      body = JSON.stringify(body)
    }
    return fetch(path + (query ? `?${new URLSearchParams(query)}` : ''), {
      ...init,
      method,
      headers,
      body,
    })
  }

  let body = null
  if (init.body != null && init.body !== '') {
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    } else if (init.body instanceof FormData) {
      throw new Error('gatewayFetch does not support FormData; use multipart upload helpers')
    } else {
      body = init.body
    }
  }

  try {
    const data = await gatewayJson(method, path, body, query)
    const text = data == null ? '' : typeof data === 'string' ? data : JSON.stringify(data)
    return {
      ok: true,
      status: 200,
      async text() {
        return text
      },
      async json() {
        return data
      },
    }
  } catch (e) {
    const status = Number(e?.status) || 0
    const raw = e?.gatewayResult ?? e?.body
    const text =
      typeof raw === 'string'
        ? raw
        : raw != null
          ? JSON.stringify(raw)
          : String(e?.message || e || '')
    return {
      ok: false,
      status: status || 500,
      async text() {
        return text
      },
      async json() {
        return raw ?? { detail: text }
      },
    }
  }
}
