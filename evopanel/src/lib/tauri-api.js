/**
 * Tauri API 封装层
 * Tauri 环境用 invoke，Web 模式走 dev-api 后端
 */

import {
  createWarmLatchState,
  enqueueWarmWait,
  isWarming as warmLatchIsWarming,
  noteLiveness,
  resetWarmLatch,
} from './gateway-warm-latch.js'

const isTauri = !!window.__TAURI_INTERNALS__
window.__yt_last_gateway_error = window.__yt_last_gateway_error || ''
/** Correlate desktop boot / gateway logs across frontend + sidecar. */
const _bootId =
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID().slice(0, 8)
    : `b${Date.now().toString(36).slice(-6)}`
if (typeof window !== 'undefined') window.__EVOFLOW_BOOT_ID__ = _bootId
/** Dedupe background index warm per workspace root / thread sandbox. */
const _codeIndexWarmKeys = new Set()

export function getDesktopBootId() {
  return _bootId
}

// 仅在 Web 模式下通过 HTTP 代理的命令（桌面端全部走原生 invoke）
const WEB_ONLY_CMDS = new Set()

let _cachedGatewayUrl = null

function envGatewayBaseUrl() {
  try {
    const env = import.meta.env || {}
    const url = env.VITE_EVOFLOW_GATEWAY_URL || ''
    if (typeof url === 'string' && url.trim()) return url.trim().replace(/\/+$/, '')
    const port = parseInt(String(env.VITE_EVOFLOW_GATEWAY_PORT || '').trim(), 10)
    if (Number.isFinite(port) && port > 0 && port < 65536) return `http://127.0.0.1:${port}`
  } catch {
    /* ignore */
  }
  return null
}

function runtimeGatewayBaseUrl() {
  if (typeof window === 'undefined') return null
  const raw = window.__EVOFLOW_GATEWAY_BASE__
  if (typeof raw === 'string' && raw.trim()) return raw.trim().replace(/\/+$/, '')
  return null
}

/** Browser Vite dev: use same-origin /api proxy (works for LAN IP, avoids CORS). */
function isBrowserDevViteProxy() {
  if (isTauri) return false
  try {
    return !!(import.meta.env && import.meta.env.DEV)
  } catch {
    return false
  }
}

/** Override Gateway base for browser dev (e.g. agent-trace standalone auto-probe). */
export function setGatewayBaseUrlOverride(baseUrl) {
  const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (typeof window !== 'undefined') {
    if (trimmed) window.__EVOFLOW_GATEWAY_BASE__ = trimmed
    else delete window.__EVOFLOW_GATEWAY_BASE__
  }
  _cachedGatewayUrl = trimmed || null
}

/** Probe common local Gateway ports when Vite env is unset. */
export async function probeGatewayBaseUrl(options = {}) {
  const ports = Array.isArray(options.ports) ? options.ports : [8070, 8012, 38012]
  const timeoutMs = Math.max(200, Number(options.timeoutMs) || 800)
  const kind = String(options.kind || 'liveness')
  if (isTauri) {
    for (const port of ports) {
      const base = `http://127.0.0.1:${port}`
      try {
        if (await _tauriHealthProbe(kind, timeoutMs, base)) return base
      } catch {
        /* try next */
      }
    }
    return null
  }
  const checks = ports.map(async (port) => {
    const base = `http://127.0.0.1:${port}`
    try {
      const path = kind === 'ready' ? '/health/ready' : '/health/liveness'
      const r = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) })
      if (r.ok) return base
    } catch {
      /* try next port */
    }
    return null
  })
  const results = await Promise.all(checks)
  return results.find((b) => b) || null
}

/** Clear cached Gateway base so the next resolve can pick up a healthy port. */
export function clearGatewayBaseUrlCache() {
  _cachedGatewayUrl = null
}

async function gatewayBaseLooksAlive(base, timeoutMs = 600) {
  const trimmed = String(base || '').trim().replace(/\/+$/, '')
  if (!trimmed) return false
  if (isTauri) {
    try {
      return await _tauriHealthProbe('liveness', timeoutMs, trimmed)
    } catch {
      return false
    }
  }
  try {
    const r = await fetch(`${trimmed}/health/liveness`, { signal: AbortSignal.timeout(timeoutMs) })
    return r.ok
  } catch {
    return false
  }
}

/** 获取 Gateway 后端地址（缓存结果，只 resolve 一次） */
export async function getGatewayBaseUrl() {
  if (_cachedGatewayUrl !== null) return _cachedGatewayUrl
  const fromRuntime = runtimeGatewayBaseUrl()
  if (fromRuntime) {
    _cachedGatewayUrl = fromRuntime
    return fromRuntime
  }
  // 浏览器 Vite dev（含 LAN 访问 192.168.x.x:1521）：走同源 /api 代理，勿直连 127.0.0.1
  if (isBrowserDevViteProxy()) {
    _cachedGatewayUrl = ''
    return ''
  }
  const fromEnv = envGatewayBaseUrl()
  if (fromEnv) {
    _cachedGatewayUrl = fromEnv
    return fromEnv
  }
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core')
    let base = String((await invoke('get_gateway_base_url')) || '').trim().replace(/\/+$/, '')
    // Empty = Rust found no healthy listener; Stale runtime (e.g. 8012) while stack is on 8070.
    if (!base || !(await gatewayBaseLooksAlive(base, 500))) {
      const probed = await probeGatewayBaseUrl({ ports: [8070, 8012, 8071, 8022, 8032], timeoutMs: 500 })
      if (probed) {
        setGatewayBaseUrlOverride(probed)
        return probed
      }
      // Do not cache empty/unhealthy — next resolve can pick up a late sidecar.
      return ''
    }
    _cachedGatewayUrl = base
    return base
  } else {
    _cachedGatewayUrl = ''
  }
  return _cachedGatewayUrl
}

// 返回 Gateway 地址
// - 浏览器开发模式：使用相对路径，走 Vite 代理（避免跨域和端口问题）
// - 桌面端：gatewayProxy 优先走 Rust invoke('gateway_proxy') → 本机 Gateway（避免 webview fetch Failed to fetch）
export function getBackendBaseURL() {
  // 检查是否在 Tauri 桌面环境
  const isTauriEnv = !!(
    window.__TAURI__?.core?.invoke ||
    window.__TAURI_INTERNALS__
  )

  if (isTauriEnv) {
    return ''
  }

  // 浏览器模式：使用相对路径 ''，让请求自动走当前 origin 的 Vite 代理
  return ''
}

const GATEWAY_RETRY_DELAYS_MS = [300, 500, 800, 1200, 2000]
const GATEWAY_RETRY_MAX = 60
const GATEWAY_RETRY_BUDGET_MS = 90_000
const _gatewayInflight = new Map()

/** Prefetch core model list as soon as liveness unlocks (ChatApp mounts later). */
let _modelCatalogPrefetch = null

function gatewayRetryDelayMs(attempt) {
  return GATEWAY_RETRY_DELAYS_MS[Math.min(attempt, GATEWAY_RETRY_DELAYS_MS.length - 1)]
}

function parseGatewayErrorMessage(status, result) {
  let msg = result?.detail || result?.error || result?.message || `Gateway API failed: ${status}`
  if (msg && typeof msg === 'object') {
    const errs = msg.errors || msg.detail?.errors
    if (Array.isArray(errs) && errs.length) {
      msg = msg.message || 'Validation failed:\n' + errs.map((e, i) => `${i + 1}. ${e}`).join('\n')
    } else {
      msg = msg.message || msg.error || JSON.stringify(msg)
    }
  }
  return String(msg || `Gateway API failed: ${status}`)
}

function gatewayErrorCode(result) {
  return String(result?.error || result?.detail?.error || '').toLowerCase()
}

function isRetryableGatewayResponse(status, result, method) {
  if (status === 503) return true
  const code = gatewayErrorCode(result)
  // Extended routers load in background — fail fast so app-server stdio / HTTP
  // stay free for /models and /messages instead of burning retry budget.
  if (code === 'loading_extended') return false
  if (code === 'starting_up' || code === 'warming_up') return true
  if (status === 404 && String(method || 'GET').toUpperCase() === 'GET') {
    const msg = String(result?.detail || result?.error || '').toLowerCase()
    if (msg === 'not found' && !_backendReady) return true
  }
  return false
}

/** Kick GET /models (+ primary) early so the composer model label is not empty for ~15–30s. */
export function prefetchModelCatalog(reason = 'engineReady') {
  if (!isTauri) return _modelCatalogPrefetch
  if (_modelCatalogPrefetch) return _modelCatalogPrefetch
  _modelCatalogPrefetch = (async () => {
    try {
      const [models, primary] = await Promise.all([
        gatewayProxy('GET', '/models', null, null, { silent: true }),
        gatewayProxy('GET', '/models/primary', null, null, { silent: true }).catch(() => null),
      ])
      try {
        console.info('[evoflow] model catalog prefetched', { reason })
      } catch {
        /* ignore */
      }
      return { models, primary }
    } catch (err) {
      _modelCatalogPrefetch = null
      throw err
    }
  })()
  _modelCatalogPrefetch.catch(() => {})
  return _modelCatalogPrefetch
}

/** ChatApp reuses the in-flight / completed prefetch when present. */
export function getModelCatalogPrefetch() {
  return _modelCatalogPrefetch
}

async function gatewayProxyOnce(method, path, body = null, query = null, options = null) {
  const silent = !!(options && options.silent)
  const timeoutMs = Number(options?.timeoutMs)
  const apiPath = String(path || '').startsWith('/api/')
    ? String(path)
    : `/api${String(path || '').startsWith('/') ? path : `/${path || ''}`}`

  // 桌面端：优先走常驻 app-server 管道；未暖好则 Rust gateway_proxy → Gateway
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core')
    /** @type {Record<string, string> | null} */
    let queryMap = null
    if (query && typeof query === 'object') {
      queryMap = {}
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '') continue
        queryMap[k] = String(v)
      }
      if (!Object.keys(queryMap).length) queryMap = null
    }
    /** @type {Record<string, string>} */
    let headers = {}
    try {
      const { getAuthToken } = await import('./webui-remote.js')
      const token = getAuthToken()
      if (token) headers.Authorization = `Bearer ${token}`
    } catch { /* ignore */ }

    // preferGatewayHttp：打开会话历史等延迟敏感读路径，避开 stdio 管道排队
    const preferGatewayHttp = !!(options && options.preferGatewayHttp)

    try {
      const {
        shouldUseAppServerApiPipe,
        appServerGatewayCall,
        isAppServerWarm,
      } = await import('./app-server-client.js')
      if (shouldUseAppServerApiPipe() && isAppServerWarm() && !preferGatewayHttp) {
        if (!silent) {
          console.info('[evoflow] api transport=app-server-pipe', String(method || 'GET').toUpperCase(), apiPath)
        }
        const proxied = await appServerGatewayCall({
          method: String(method || 'GET').toUpperCase(),
          path: apiPath,
          body: body == null ? null : body,
          query: queryMap,
          headers,
          timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null,
        })
        const status = Number(proxied?.status) || 0
        const result = proxied?.body
        if (!proxied?.ok) {
          const msg =
            proxied?.error ||
            parseGatewayErrorMessage(status, result) ||
            `Gateway API failed: ${status}`
          const err = new Error(String(msg))
          err.status = status
          err.gatewayResult = result
          err.retryable = isRetryableGatewayResponse(status, result, method)
          if (!silent) {
            window.__yt_last_gateway_error = String(msg)
            appendFrontendLog('error', `[app-server gateway/call] ${method} ${apiPath} :: ${msg}`)
          }
          throw err
        }
        return result
      }
    } catch (e) {
      // Pipe unavailable / RPC error with no HTTP status → fall through to gateway_proxy
      if (e && typeof e.status === 'number' && e.status > 0) throw e
      if (!silent) {
        console.warn('[evoflow] app-server API pipe fallback to gateway_proxy', e)
      }
    }

    let proxied
    try {
      proxied = await invoke('gateway_proxy', {
        request: {
          method: String(method || 'GET').toUpperCase(),
          path: apiPath,
          body: body == null ? null : body,
          query: queryMap,
          // 必须是 map：Rust `headers: BTreeMap` 不接受 JSON null（任务中心等无 token 时会炸）
          headers,
        },
      })
      if (preferGatewayHttp && !silent) {
        console.info(
          '[evoflow] api transport=gateway-proxy-http',
          String(method || 'GET').toUpperCase(),
          apiPath,
        )
      }
    } catch (e) {
      const msg = String(e?.message || e || 'gateway_proxy failed')
      const err = new Error(msg)
      err.status = 0
      err.retryable = /网关请求失败|网关未就绪|connection|refused|timed out|timeout|warming/i.test(msg)
      if (!silent) {
        window.__yt_last_gateway_error = msg
        appendFrontendLog('error', `[gateway_proxy] ${method} ${apiPath} :: ${msg}`)
      }
      throw err
    }
    const status = Number(proxied?.status) || 0
    const result = proxied?.body
    if (!proxied?.ok) {
      const msg =
        proxied?.error ||
        parseGatewayErrorMessage(status, result) ||
        `Gateway API failed: ${status}`
      const err = new Error(String(msg))
      err.status = status
      err.gatewayResult = result
      err.retryable = isRetryableGatewayResponse(status, result, method)
      if (!silent) {
        window.__yt_last_gateway_error = String(msg)
        appendFrontendLog('error', `[gateway_proxy] ${method} ${apiPath} :: ${msg}`)
      }
      throw err
    }
    return result
  }

  const headers = body ? { 'Content-Type': 'application/json' } : {}
  try {
    const { getAuthToken } = await import('./webui-remote.js')
    const token = getAuthToken()
    if (token) headers.Authorization = `Bearer ${token}`
  } catch { /* ignore */ }
  const fetchOpts = {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  }
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    fetchOpts.signal = AbortSignal.timeout(timeoutMs)
  }

  const base = await getGatewayBaseUrl()
  let url = `${base}${apiPath}`
  if (query && Object.keys(query).length > 0) {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue
      params.append(k, String(v))
    }
    const qs = params.toString()
    if (qs) url += '?' + qs
  }

  const res = await fetch(url, fetchOpts)
  const text = await res.text()
  let result
  try { result = JSON.parse(text) } catch { result = text }
  if (!res.ok) {
    const msg = parseGatewayErrorMessage(res.status, result)
    if (res.status === 401 && !path.startsWith('/webui/login') && !path.startsWith('/qr-login') && !path.startsWith('/webui/qr-login')) {
      try {
        const { getWebuiStatus, clearAuthToken } = await import('./webui-remote.js')
        const status = await getWebuiStatus()
        if (status?.enabled) {
          clearAuthToken()
          if (typeof window !== 'undefined') window.location.hash = '/login'
        }
      } catch { /* ignore */ }
    }
    const err = new Error(msg)
    err.status = res.status
    err.gatewayResult = result
    err.retryable = isRetryableGatewayResponse(res.status, result, method)
    if (!silent) {
      window.__yt_last_gateway_error = msg
      appendFrontendLog('error', `[gateway_direct] ${method} ${path} :: ${msg}`)
    }
    throw err
  }
  return result
}

function gatewayInflightKey(method, path, query) {
  if (String(method || 'GET').toUpperCase() !== 'GET') return null
  // Include a token fingerprint so /identity/me never shares an in-flight
  // response across account switches in the same page lifetime.
  let authFp = 'anon'
  try {
    const token = localStorage.getItem('evoflow_webui_token') || ''
    if (token) authFp = `t${token.length}:${token.slice(0, 8)}:${token.slice(-6)}`
  } catch {
    /* ignore */
  }
  const q = query && typeof query === 'object' ? query : null
  const base = `${method}:${path}@${authFp}`
  if (!q || !Object.keys(q).length) return base
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue
    params.append(k, String(v))
  }
  const qs = params.toString()
  return qs ? `${base}?${qs}` : base
}

async function gatewayProxyWithRetry(method, path, body = null, query = null, options = null) {
  const silent = !!(options && options.silent)
  const skipRetry = !!(options && options.skipRetry)
  const startedAt = Date.now()
  let lastErr = null
  let maxAttempts = GATEWAY_RETRY_MAX
  let budgetMs = GATEWAY_RETRY_BUDGET_MS
  for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
    if (Date.now() - startedAt > budgetMs) break
    try {
      return await gatewayProxyOnce(method, path, body, query, options)
    } catch (err) {
      lastErr = err
      const code = gatewayErrorCode(err?.gatewayResult)
      // loading_extended is a 503 but must not retry (clogs first-paint APIs).
      if (code === 'loading_extended') break
      const retryable = !skipRetry && (err?.retryable || err?.status === 503)
      if (!retryable || attempt >= maxAttempts) break
      const delay = Number(err?.gatewayResult?.retry_after_ms) || gatewayRetryDelayMs(attempt)
      await new Promise((r) => setTimeout(r, delay))
      if (isTauri && attempt % 3 === 2) {
        try { await checkBackendReady() } catch { /* ignore */ }
      }
    }
  }
  if (!silent && lastErr) {
    const msg = String(lastErr?.message || lastErr || 'unknown gateway error')
    window.__yt_last_gateway_error = msg
    appendFrontendLog('error', `[gateway_direct] ${method} ${path} :: ${msg}`)
  }
  throw lastErr
}

// 直接访问 Gateway API
// - Tauri / 已配置 VITE_EVOFLOW_GATEWAY_* / runtime override：直连 Gateway（如 8012、8070）
// - 浏览器 dev 且无上述配置：相对路径 /api/* 走 Vite 代理（页面 origin 如 1521）
export async function gatewayProxy(method, path, body = null, query = null, options = null) {
  // 探针类调用（checkBackendHealth/Ready）不走队列
  const isProbe = options && options.__probe__
  if (!isProbe) {
    for (let warmAttempt = 0; warmAttempt < 3; warmAttempt += 1) {
      const warmP = _gatewayWarmQueue(method, path, body, query, options)
      if (!warmP) break
      try {
        await warmP
        break
      } catch (e) {
        const msg = String(e?.message || e || '')
        // reload reset rejects waiters — re-enqueue under the new latch
        if (!msg.includes('warming reset') || warmAttempt >= 2) throw e
      }
    }
  }
  const skipDedup = !!(options && options.skipDedup)
  const key = skipDedup ? null : gatewayInflightKey(method, path, query)
  if (key && _gatewayInflight.has(key)) {
    return _gatewayInflight.get(key)
  }
  const work = gatewayProxyWithRetry(method, path, body, query, options)
  if (key) {
    _gatewayInflight.set(key, work)
    // finally alone does not count as a rejection handler — without this, Chrome
    // reports "Uncaught (in promise)" even when the caller later .catch()es.
    work.catch(() => {})
    work.finally(() => {
      if (_gatewayInflight.get(key) === work) _gatewayInflight.delete(key)
    })
  }
  return work
}

function appendFrontendLog(level, message) {
  if (!window.__TAURI__ || !_invokeReady) return
  const tagged = String(message || '').includes(`[boot:${_bootId}]`)
    ? message
    : `[boot:${_bootId}] ${message}`
  _invokeReady
    .then((tauriInvoke) => tauriInvoke('append_frontend_log', { level, message: tagged }))
    .catch(() => {})
}

// SkillHub 技能市场（桌面端无 dev-api invoke：直接调 Convex + Gateway 安装）
const SKILLHUB_CONVEX_QUERY = 'https://wry-manatee-359.convex.cloud/api/query'

// SkillHub CDN 下载基址（支持 CORS：access-control-allow-origin: *，返回 application/zip）
const SKILLHUB_DOWNLOAD_BASE = 'https://wry-manatee-359.convex.site/api/v1/download'

/**
 * 直接从 SkillHub CDN 下载技能 zip 并走 install-local 接口安装。
 * 绕过网关 install-from-market —— 该链路中网关用 httpx 代下 CDN，
 * CDN 偶发对服务器端请求返回 409，导致前端报 "Market download failed: HTTP 409"。
 * CDN 本身支持 CORS，前端直接 fetch 即可拿 zip，再上传到 install-local 走完整安全校验。
 */
async function downloadAndInstallSkillZip(slug, ownerHandle = null) {
  const cleanSlug = String(slug || '').trim()
  if (!cleanSlug) throw new Error('Invalid slug')
  let url = `${SKILLHUB_DOWNLOAD_BASE}?slug=${encodeURIComponent(cleanSlug)}`
  const owner = String(ownerHandle || '').trim()
  if (owner) url += `&ownerHandle=${encodeURIComponent(owner)}`

  const resp = await fetch(url)
  if (!resp.ok) {
    const hint = resp.status === 404 ? '（技能不存在或 ownerHandle 不匹配）' : ''
    throw new Error(`技能包下载失败 (HTTP ${resp.status})${hint}`)
  }
  const blob = await resp.blob()
  if (blob.size < 64) throw new Error('技能包内容为空或无效')
  // 从 content-disposition 提取文件名，回退到 slug.zip
  const cd = resp.headers.get('content-disposition') || ''
  const fnameMatch = cd.match(/filename="?([^"]+)"?/i)
  const filename = fnameMatch ? fnameMatch[1] : `${cleanSlug}.zip`
  const file = new File([blob], filename, { type: 'application/zip' })
  return api.uploadSkillFile(file)
}

async function callSkillHubConvex(funcPath, args = {}) {
  const resp = await fetch(SKILLHUB_CONVEX_QUERY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'convex-client': 'npm-1.34.1' },
    body: JSON.stringify({ path: funcPath, args }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!resp.ok) {
    const t = await resp.text().catch(() => '')
    throw new Error(`SkillHub HTTP ${resp.status}: ${t.substring(0, 200)}`)
  }
  const data = await resp.json()
  if (data.status === 'error') throw new Error(data.errorMessage || 'Convex server error')
  return data.value
}

function mapSkillHubSkill(item) {
  const s = item?.skill || item || {}
  return {
    slug: s.slug || '',
    name: s.displayName || s.name || '',
    description: s.summary || s.description || '',
    stars: s.stats?.stars || 0,
    downloads: s.stats?.downloads || 0,
    versionId: s.latestVersionId || '',
    ownerHandle: item?.ownerHandle || '',
    tags: s.tags ? Object.keys(s.tags) : [],
    source: 'skillhub',
  }
}

async function skillsSkillHubSearchDesktop(query, cursor) {
  const q = String(query || '').trim().toLowerCase()
  const pageSize = 50
  const convexArgs = {
    dir: 'desc',
    highlightedOnly: false,
    nonSuspiciousOnly: true,
    numItems: pageSize,
    sort: 'downloads',
  }
  if (cursor) convexArgs.cursor = String(cursor)

  const result = await callSkillHubConvex('skills:listPublicPageV4', convexArgs)

  let rawItems = []
  if (Array.isArray(result?.page)) rawItems = result.page
  else if (Array.isArray(result)) rawItems = result

  const skills = rawItems.map((item) => item)

  let list = skills
  if (q) {
    list = list.filter(
      (item) => {
        const s = item?.skill || item || {}
        return (s.slug || '').toLowerCase().includes(q) ||
          (s.displayName || '').toLowerCase().includes(q) ||
          (s.summary || '').toLowerCase().includes(q)
      },
    )
  }

  return {
    skills: list.map(mapSkillHubSkill),
    hasMore: !!result?.nextCursor,
    cursor: result?.nextCursor || null,
    total: list.length,
  }
}

// 带缓存的 Gateway 调用（用于不常变的数据）
function cachedGateway(method, path, ttl = 30000) {
  const key = `gw:${method}:${path}`
  const cached = _cache.get(key)
  if (cached && Date.now() - cached.ts < ttl) return Promise.resolve(cached.val)
  const p = gatewayProxy(method, path).then(val => {
    _cache.set(key, { val, ts: Date.now() })
    return val
  })
  _cache.set(key, { val: p, ts: 0 }) // 防止并发请求
  return p
}

// 预加载 Tauri invoke，避免每次 API 调用都做动态 import
const _invokeReady = isTauri
  ? import('@tauri-apps/api/core').then(m => m.invoke)
  : null

// 简单缓存：避免页面切换时重复请求后端
const _cache = new Map()
const _inflight = new Map() // in-flight 请求去重，防止缓存过期后同一命令并发 spawn 多个进程
const CACHE_TTL = 15000 // 15秒

// 网络请求日志（用于调试）
const _requestLogs = []
const MAX_LOGS = 100

function logRequest(cmd, args, duration, cached = false) {
  const log = {
    timestamp: Date.now(),
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false, fractionalSecondDigits: 3 }),
    cmd,
    args: JSON.stringify(args),
    duration: duration ? `${duration}ms` : '-',
    cached
  }
  _requestLogs.push(log)
  if (_requestLogs.length > MAX_LOGS) {
    _requestLogs.shift()
  }
}

// 导出日志供调试页面使用
export function getRequestLogs() {
  return _requestLogs.slice()
}

export function clearRequestLogs() {
  _requestLogs.length = 0
}

function cachedInvoke(cmd, args = {}, ttl = CACHE_TTL) {
  const key = cmd + JSON.stringify(args)
  const cached = _cache.get(key)
  if (cached && Date.now() - cached.ts < ttl) {
    logRequest(cmd, args, 0, true)
    return Promise.resolve(cached.val)
  }
  // in-flight 去重：同一个 key 的请求正在执行中，复用同一个 Promise
  // 避免缓存过期瞬间多个调用者同时 spawn 进程（ARM 设备上的 CPU 爆满根因）
  if (_inflight.has(key)) {
    return _inflight.get(key)
  }
  const p = invoke(cmd, args).then(val => {
    _cache.set(key, { val, ts: Date.now() })
    _inflight.delete(key)
    return val
  }).catch(err => {
    _inflight.delete(key)
    throw err
  })
  _inflight.set(key, p)
  return p
}

// 清除指定命令的缓存（写操作后调用）
function invalidate(...cmds) {
  for (const [k] of _cache) {
    if (cmds.some(c => k.startsWith(c))) _cache.delete(k)
  }
}

// 导出 invalidate 供外部使用
export { invalidate }

// 函数声明：确保在 gatewayProxy 调用之前已定义（函数声明会被 hoisting）
async function invoke(cmd, args = {}) {
  const start = Date.now()
  if (_invokeReady && !WEB_ONLY_CMDS.has(cmd)) {
    const tauriInvoke = await _invokeReady
    const result = await tauriInvoke(cmd, args)
    const duration = Date.now() - start
    logRequest(cmd, args, duration, false)
    return result
  }
  // Web 模式：调用 dev-api 后端（真实数据）
  const result = await webInvoke(cmd, args)
  const duration = Date.now() - start
  logRequest(cmd, args, duration, false)
  return result
}

// Web 模式：通过 Vite 开发服务器的 API 端点调用真实后端
async function webInvoke(cmd, args) {
  const resp = await fetch(`/__api/${cmd}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  if (resp.status === 401) {
    // Tauri 模式下不触发登录浮层（Tauri 有自己的认证流程）
    if (!isTauri && window.__evopanel_show_login) window.__evopanel_show_login()
    throw new Error('需要登录')
  }
  // 检测后端是否可用：如果返回的是 HTML（非 JSON），说明后端未运行
  const ct = (resp.headers.get('content-type') || '').toLowerCase()
  if (ct.includes('text/html') || ct.includes('text/plain')) {
    throw new Error('后端服务未运行，该功能需要 Web 部署模式')
  }
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }))
    throw new Error(data.error || `HTTP ${resp.status}`)
  }
  return resp.json()
}

function normalizeAgentToWebShape(agent) {
  const name = String(agent?.name || '').trim()
  const model = (typeof agent?.model === 'string')
    ? agent.model
    : (agent?.model?.primary || agent?.model?.id || null)
  const description = String(agent?.description || '').trim()
  return {
    name,
    description,
    model: model || null,
    tool_groups: Array.isArray(agent?.tool_groups) ? agent.tool_groups : null,
    soul: typeof agent?.soul === 'string' ? agent.soul : null,
    isDefault: !!agent?.isDefault || name === 'main',
  }
}

// 后端连接状态
let _backendOnline = null // null=未检测, true=在线, false=离线
let _backendReady = null // null=未检测, true=LangGraph ready, false=warming
const _backendListeners = []
const _backendReadyListeners = []

// === 网关预热队列（冷启动 / reload 期间挂起 HTTP 请求，liveness 通过后放行） ===
const _warmLatch = createWarmLatchState()

/** 通知网关 liveness 状态（由 checkBackendHealth / checkBackendReady 调用）。
 *  单次抖动不重新挂起；连续失败或显式 reset（reload）才会再 hold。 */
export function noteGatewayLiveness(ok) {
  const action = noteLiveness(_warmLatch, !!ok)
  if (action === 'reset') {
    appendFrontendLog('warn', `[boot:${_bootId}] warm latch reset (liveness_fail_streak)`)
  } else if (action === 'released' && ok) {
    appendFrontendLog('info', `[boot:${_bootId}] warm latch released (liveness ok)`)
  }
}

/** Drop warm latch so subsequent gatewayProxy calls wait again (reload / crash). */
export function resetGatewayWarmLatch(reason = 'manual') {
  if (!isTauri) return
  resetWarmLatch(_warmLatch, reason)
  clearGatewayBaseUrlCache()
  appendFrontendLog('warn', `[boot:${_bootId}] warm latch reset (${reason})`)
}

/** 网关是否处于预热期（当前 latch 未放行，含 reload 后再次 warming）。 */
export function isGatewayWarming() {
  return isTauri && warmLatchIsWarming(_warmLatch)
}

/** 网关预热队列：若 liveness 未通过，挂起请求直到通过或超时（同 key 复用同一 Promise）。 */
function _gatewayWarmQueue(method, path, body, _query, _options) {
  if (!isTauri || !warmLatchIsWarming(_warmLatch)) return null
  const key = `${method}:${path}:${body ? JSON.stringify(body).slice(0, 80) : ''}`
  return enqueueWarmWait(_warmLatch, key)
}

export function onBackendStatusChange(fn) {
  _backendListeners.push(fn)
  return () => { const i = _backendListeners.indexOf(fn); if (i >= 0) _backendListeners.splice(i, 1) }
}

export function onBackendReadyChange(fn) {
  _backendReadyListeners.push(fn)
  return () => { const i = _backendReadyListeners.indexOf(fn); if (i >= 0) _backendReadyListeners.splice(i, 1) }
}

export function isBackendOnline() { return _backendOnline }
export function isBackendReady() { return _backendReady }

/** Singleflight: warm stdio pipe as soon as Gateway is alive (not waiting for /ready). */
let _appServerPrewarmKick = null
export function kickAppServerPrewarm(reason = 'liveness') {
  if (!isTauri) return Promise.resolve(false)
  if (_appServerPrewarmKick) return _appServerPrewarmKick
  _appServerPrewarmKick = import('./app-server-client.js')
    .then((m) => m.prewarmAppServer())
    .then((ok) => {
      try {
        console.info('[evoflow] app-server prewarm kick', { reason, ok: !!ok })
      } catch {
        /* ignore */
      }
      if (!ok) {
        // Allow retry on next liveness tick if handshake failed early.
        _appServerPrewarmKick = null
      }
      return !!ok
    })
    .catch(() => {
      _appServerPrewarmKick = null
      return false
    })
  return _appServerPrewarmKick
}

function _setBackendOnline(v) {
  if (_backendOnline !== v) {
    _backendOnline = v
    _backendListeners.forEach(fn => { try { fn(v) } catch {} })
  }
}

// 后端健康检查（须在 checkBackendReady 之前，避免 TDZ）
const LIVENESS_TIMEOUT_MS = 1200

/** Once true during cold start, ignore transient false (event-loop stall / LG init). */
let _engineReadyStickyUntil = 0
const ENGINE_READY_STICKY_MS = 180_000

function _setBackendReady(v) {
  if (v) {
    _engineReadyStickyUntil = Date.now() + ENGINE_READY_STICKY_MS
  } else if (_backendReady === true && Date.now() < _engineReadyStickyUntil) {
    try {
      console.info('[evoflow] engineReady sticky: ignore false (gateway warming)')
    } catch {
      /* ignore */
    }
    return
  }
  if (_backendReady !== v) {
    _backendReady = v
    try {
      console.info('[evoflow] engineReady=', !!v)
    } catch {
      /* ignore */
    }
    if (v) {
      void import('./startup-trace.js')
        .then((m) => m.bootMarkEngineReady?.({ source: 'tauri-api' }))
        .catch(() => {})
      // Don't wait for ChatApp mount — model label should fill as soon as core routers serve.
      try {
        prefetchModelCatalog('engineReady')
      } catch {
        /* ignore */
      }
    }
    _backendReadyListeners.forEach(fn => { try { fn(v) } catch {} })
  }
}

async function _tauriHealthProbe(kind = 'liveness', timeoutMs = 2500, baseUrl = null) {
  const { invoke } = await import('@tauri-apps/api/core')
  const payload = {
    kind: String(kind || 'liveness'),
    timeoutMs: Math.max(500, Number(timeoutMs) || 2500),
  }
  const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (trimmed) payload.baseUrl = trimmed
  const result = await invoke('gateway_health_probe', payload)
  if (result && typeof result === 'object') {
    const base = String(result.baseUrl || '').trim().replace(/\/+$/, '')
    if (base && result.ok) setGatewayBaseUrlOverride(base)
    return !!result.ok
  }
  return !!result
}

/** LangGraph / agent engine readiness.
 *  Desktop: unlock composer on liveness  — full /ready + LG lifespan continue in background.
 *  Web: still wait for /health/ready.
 */
export async function checkBackendReady() {
  if (isTauri) {
    try {
      let ok = await _tauriHealthProbe('liveness', LIVENESS_TIMEOUT_MS)
      if (!ok) {
        clearGatewayBaseUrlCache()
        const probed = await probeGatewayBaseUrl({
          ports: [8070, 8012, 8071, 8022, 8032],
          timeoutMs: 500,
          kind: 'liveness',
        })
        if (probed) {
          setGatewayBaseUrlOverride(probed)
          ok = await _tauriHealthProbe('liveness', LIVENESS_TIMEOUT_MS, probed)
        }
      }
      // Sticky: once unlocked, treat transient probe failures as still ready.
      if (!ok && _backendReady === true && Date.now() < _engineReadyStickyUntil) {
        return true
      }
      _setBackendReady(ok)
      if (ok) {
        noteGatewayLiveness(true)
        kickAppServerPrewarm('engine-ready-liveness')
      }
      return ok || (_backendReady === true && Date.now() < _engineReadyStickyUntil)
    } catch {
      if (_backendReady === true && Date.now() < _engineReadyStickyUntil) return true
      _setBackendReady(false)
      return false
    }
  }
  try {
    const resp = await fetch('/health/ready', { signal: AbortSignal.timeout(5000) })
    const ok = resp.ok
    _setBackendReady(ok)
    return ok
  } catch {
    _setBackendReady(false)
    return false
  }
}

/** Block until Gateway reports ready (desktop boot gate / home dashboard). */
export async function waitForBackendReady(maxWaitMs = 120_000) {
  if (await checkBackendReady()) return true
  const deadline = Date.now() + maxWaitMs
  let attempt = 0
  while (Date.now() < deadline) {
    const elapsed = maxWaitMs - Math.max(0, deadline - Date.now())
    const delay = elapsed < 15_000 ? 120 : elapsed < 45_000 ? 250 : 500
    await new Promise((r) => setTimeout(r, delay))
    attempt += 1
    if (await checkBackendReady()) return true
    if (isTauri && attempt % 4 === 3) {
      try { await checkBackendHealth() } catch { /* ignore */ }
    }
  }
  return false
}

export async function checkBackendHealth() {
  if (isTauri) {
    try {
      let ok = await _tauriHealthProbe('liveness', LIVENESS_TIMEOUT_MS)
      if (!ok) {
        clearGatewayBaseUrlCache()
        const probed = await probeGatewayBaseUrl({ ports: [8070, 8012, 8071, 8022, 8032], timeoutMs: 500 })
        if (probed) {
          setGatewayBaseUrlOverride(probed)
          ok = await _tauriHealthProbe('liveness', LIVENESS_TIMEOUT_MS)
        }
      }
      _setBackendOnline(ok)
      noteGatewayLiveness(ok)
      if (ok) kickAppServerPrewarm('liveness')
      return ok
    } catch {
      clearGatewayBaseUrlCache()
      try {
        const probed = await probeGatewayBaseUrl({ ports: [8070, 8012, 8071, 8022, 8032], timeoutMs: 500 })
        if (probed) {
          setGatewayBaseUrlOverride(probed)
          const ok = await _tauriHealthProbe('liveness', LIVENESS_TIMEOUT_MS)
          _setBackendOnline(ok)
          noteGatewayLiveness(ok)
          if (ok) kickAppServerPrewarm('liveness-probe')
          return ok
        }
      } catch {
        /* fall through */
      }
      _setBackendOnline(false)
      noteGatewayLiveness(false)
      return false
    }
  }
  try {
    // 远程访问(WebUI)模式下页面由 FastAPI Gateway 提供，仅有 GET /health/liveness；
    // Vite dev / serve.js 模式下该路径回退到 index.html(200)，同样表示 Web 服务可用。
    // 不再用 POST /__api/health（仅 dev-api.js / serve.js 有该路由，Gateway 上会 405）。
    const resp = await fetch('/health/liveness', { signal: AbortSignal.timeout(5000) })
    const ok = resp.ok
    _setBackendOnline(ok)
    return ok
  } catch {
    _setBackendOnline(false)
    return false
  }
}

/** Verify Gateway serves /api (not just liveness). Agent-trace / observability need this. */
export async function checkGatewayHealth(options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 5000)
  try {
    if (isTauri) {
      const base = await getGatewayBaseUrl()
      const live = await fetch(`${base}/health/liveness`, { signal: AbortSignal.timeout(timeoutMs) })
      if (!live.ok) {
        _setBackendOnline(false)
        return false
      }
    }
    await gatewayProxy('GET', '/observability/status', null, null, { silent: true, timeoutMs })
    _setBackendOnline(true)
    noteGatewayLiveness(true)
    return true
  } catch {
    _setBackendOnline(false)
    return false
  }
}

// 配置保存后防抖重载 Gateway（3 秒内多次写入只触发一次重载）
let _reloadTimer = null
function _debouncedReloadGateway() {
  clearTimeout(_reloadTimer)
  _reloadTimer = setTimeout(() => {
    resetGatewayWarmLatch('debounced_reload')
    import('./gateway-guardian-busy.js')
      .then(({ markGatewayReloadInProgress }) => markGatewayReloadInProgress())
      .catch(() => {})
    invoke('reload_gateway').catch(() => {})
  }, 3000)
}

// 导出 API
async function reloadSkillCatalogAfterMutation(result) {
  try {
    const mod = await import('./skill-catalog.js')
    await mod.reloadSkillCatalog()
  } catch {
    /* catalog refresh is best-effort */
  }
  return result
}

function normalizeKnowledgeId(id) {
  const value = String(id ?? '').trim().replace(/^\/+|\/+$/g, '')
  if (!value) throw new Error('无效的知识库 ID')
  return value
}

/** Build /knowledge/{id} or /knowledge/{id}/suffix with encoded id. */
function kbApiPath(id, suffix = '') {
  const kbId = encodeURIComponent(normalizeKnowledgeId(id))
  return `/knowledge/${kbId}${suffix}`
}

export const api = {
  // 配置（读缓存，写清缓存）
  // 状态检查（统一语义）
  systemVersion: () => cachedInvoke('get_version_info', {}, 30000),
  systemStatusSummary: () => cachedInvoke('get_status_summary', {}, 60000),
  readEvoflowConfig: () => (isTauri ? cachedInvoke('read_evoflow_config') : Promise.resolve({})),
  writeEvoflowConfig: (config) => { invalidate('read_evoflow_config'); return invoke('write_evoflow_config', { config }).then(r => { _debouncedReloadGateway(); return r }) },
  readMcpConfig: () => cachedInvoke('read_mcp_config'),
  writeMcpConfig: (config) => { invalidate('read_mcp_config'); return invoke('write_mcp_config', { config }) },
  reloadGateway: () => {
    resetGatewayWarmLatch('api_reload_gateway')
    import('./gateway-guardian-busy.js')
      .then(({ markGatewayReloadInProgress }) => markGatewayReloadInProgress())
      .catch(() => {})
    return invoke('reload_gateway')
  },
  // 测试模型连接（轻量 /models/test，不走 /models/invoke，不强制应用配置）
  testModel: async (baseUrl, apiKey, modelId, apiType = null, configName = null) => {
    const body = {
      base_url: baseUrl || '',
      api_key: apiKey || '',
      model_id: modelId || '',
      api_type: apiType || 'openai-completions',
    }
    if (configName) body.config_name = String(configName)
    const result = await gatewayProxy('POST', '/models/test', body)
    if (!result.success) {
      throw new Error(result.message)
    }
    return result.message
  },
  /** tiktoken BPE 就绪状态（会顺带触发后台预热） */
  tokenizerStatus: async () =>
    gatewayProxy('GET', '/models/tokenizer-status', null, null, { silent: true, skipRetry: true }),
  /** 与 OpenAI 同源鉴权、GET {base}/models 的接口类型（任意厂商只要填了对应 Base 即可） */
  listRemoteOpenAIModels: async (payload) =>
    gatewayProxy('POST', '/models/list-remote', {
      base_url: payload.base_url,
      api_key: payload.api_key ?? '',
      api_type: payload.api_type ?? 'openai-completions',
    }),
  // 模型配置管理接口（Gateway API → SQLite evoflow_models）
  listModels: async () => gatewayProxy('GET', '/models'),
  listModelConnections: async () => gatewayProxy('GET', '/model-connections'),
  syncModelConnections: async (payload) => gatewayProxy('POST', '/model-connections/sync', payload),
  deleteModelConnection: async (key) =>
    gatewayProxy('DELETE', `/model-connections/${encodeURIComponent(String(key || ''))}`),
  listLanggraphRuns: async () => gatewayProxy('GET', '/langgraph/runs/'),

  // ---- Knowledge Base (RAG) ----
  listKnowledgeBases: async () => gatewayProxy('GET', '/knowledge'),
  createKnowledgeBase: async (data) => gatewayProxy('POST', '/knowledge', data),
  getKnowledgeBase: async (id) => gatewayProxy('GET', kbApiPath(id)),
  updateKnowledgeBase: async (id, data) => gatewayProxy('PUT', kbApiPath(id), data),
  deleteKnowledgeBase: async (id) => gatewayProxy('DELETE', kbApiPath(id)),
  uploadKnowledgeFile: async (id, file, opts = {}) => {
    const kbId = normalizeKnowledgeId(id)
    const formData = new FormData()
    formData.append('file', file)
    if (opts.folderId) formData.append('folder_id', String(opts.folderId))
    if (opts.relativePath) formData.append('relative_path', String(opts.relativePath))
    const { getAuthToken } = await import('./webui-remote.js')
    const token = getAuthToken()
    const headers = {}
    if (token) headers['Authorization'] = `Bearer ${token}`
    const baseUrl = await getGatewayBaseUrl()
    const url = `${baseUrl}/api/knowledge/${encodeURIComponent(kbId)}/upload`
    const resp = await fetch(url, { method: 'POST', headers, body: formData })
    if (!resp.ok) {
      let detail = `Upload failed: ${resp.status}`
      try {
        const body = await resp.json()
        detail = body?.detail || body?.message || detail
      } catch { /* ignore */ }
      throw new Error(detail)
    }
    return resp.json()
  },
  listKnowledgeFolders: async (id) => gatewayProxy('GET', kbApiPath(id, '/folders')),
  createKnowledgeFolder: async (id, data) => {
    const body = data || {}
    const primary = kbApiPath(id, '/folders')
    try {
      return await gatewayProxy('POST', primary, body)
    } catch (e) {
      const msg = String(e?.message || e)
      if (!/method not allowed/i.test(msg)) throw e
      return gatewayProxy('POST', kbApiPath(id, '/folder'), body)
    }
  },
  renameKnowledgeFolder: async (id, folderId, data) =>
    gatewayProxy('PUT', kbApiPath(id, `/folders/${encodeURIComponent(folderId)}`), data),
  deleteKnowledgeFolder: async (id, folderId) =>
    gatewayProxy('DELETE', kbApiPath(id, `/folders/${encodeURIComponent(folderId)}`)),
  listKnowledgeFiles: async (id, folderId = null) => {
    const q = folderId ? `?folder_id=${encodeURIComponent(folderId)}` : ''
    return gatewayProxy('GET', kbApiPath(id, `/files${q}`))
  },
  deleteKnowledgeFile: async (id, fileId) =>
    gatewayProxy('DELETE', kbApiPath(id, `/files/${encodeURIComponent(fileId)}`)),
  listKnowledgeChunks: async (id, page = 1, pageSize = 50) =>
    gatewayProxy('GET', kbApiPath(id, '/chunks'), null, { page, page_size: pageSize }),
  searchKnowledge: async (id, query, topK = 5) =>
    gatewayProxy('POST', kbApiPath(id, '/search'), { query, top_k: topK }),
  getKnowledgeStatus: async (id) => gatewayProxy('GET', kbApiPath(id, '/status')),
  syncKnowledgeLocal: async (id, force = false) =>
    gatewayProxy('POST', kbApiPath(id, '/sync-local'), { force: !!force }),

  // ---- Owned knowledge base (local-first, replaces Obsidian as primary) ----
  // 列表读走 preferGatewayHttp，避开聊天/流式占用时的 app-server stdio 排队
  listOwnedKnowledgeBases: async () =>
    gatewayProxy('GET', '/knowledge/owned/bases', null, null, { preferGatewayHttp: true }),
  createOwnedKnowledgeBase: async (data) => gatewayProxy('POST', '/knowledge/owned/bases', data),
  getOwnedKnowledgeBase: async (id) =>
    gatewayProxy('GET', `/knowledge/owned/bases/${encodeURIComponent(String(id || ''))}`),
  updateOwnedKnowledgeBase: async (id, data) =>
    gatewayProxy('PATCH', `/knowledge/owned/bases/${encodeURIComponent(String(id || ''))}`, data),
  reindexOwnedKnowledgeBase: async (id, data = null) =>
    gatewayProxy('POST', `/knowledge/owned/bases/${encodeURIComponent(String(id || ''))}/reindex`, data || {}),
  deleteOwnedKnowledgeBase: async (id) =>
    gatewayProxy('DELETE', `/knowledge/owned/bases/${encodeURIComponent(String(id || ''))}`),
  listOwnedKnowledgeDocuments: async (id) =>
    gatewayProxy(
      'GET',
      `/knowledge/owned/bases/${encodeURIComponent(String(id || ''))}/documents`,
      null,
      null,
      { preferGatewayHttp: true },
    ),
  listOwnedKnowledgeFolders: async (id) =>
    gatewayProxy('GET', `/knowledge/owned/bases/${encodeURIComponent(String(id || ''))}/folders`),
  createOwnedKnowledgeFolder: async (id, data) =>
    gatewayProxy('POST', `/knowledge/owned/bases/${encodeURIComponent(String(id || ''))}/folders`, data),
  renameOwnedKnowledgeFolder: async (id, data) =>
    gatewayProxy('PATCH', `/knowledge/owned/bases/${encodeURIComponent(String(id || ''))}/folders`, data),
  moveOwnedKnowledgeFolder: async (id, fromPath, parentPath = '') =>
    gatewayProxy('PATCH', `/knowledge/owned/bases/${encodeURIComponent(String(id || ''))}/folders`, {
      fromPath,
      parentPath: parentPath == null ? '' : String(parentPath),
    }),
  deleteOwnedKnowledgeFolder: async (id, path, mode = 'move_up') =>
    gatewayProxy(
      'DELETE',
      `/knowledge/owned/bases/${encodeURIComponent(String(id || ''))}/folders`,
      null,
      { path, mode },
    ),
  moveOwnedKnowledgeDocument: async (docId, folderPath, extras = {}) =>
    gatewayProxy(
      'PATCH',
      `/knowledge/owned/documents/${encodeURIComponent(String(docId || ''))}/folder`,
      {
        folderPath: folderPath == null ? undefined : String(folderPath),
        beforeDocId: extras.beforeDocId || undefined,
        sortOrder: extras.sortOrder != null ? extras.sortOrder : undefined,
      },
    ),
  createOwnedKnowledgeManual: async (id, data) =>
    gatewayProxy('POST', `/knowledge/owned/bases/${encodeURIComponent(String(id || ''))}/documents/manual`, data),
  importOwnedKnowledgeFolder: async (id, path, opts = {}) =>
    gatewayProxy('POST', `/knowledge/owned/bases/${encodeURIComponent(String(id || ''))}/import-folder`, {
      path,
      upsert: opts.upsert !== false,
      pruneMissing: Boolean(opts.pruneMissing),
      folderPrefix: opts.folderPrefix || '',
    }),
  importOwnedKnowledgeVault: async (id, vaultId, opts = {}) =>
    gatewayProxy('POST', `/knowledge/owned/bases/${encodeURIComponent(String(id || ''))}/import-vault`, {
      vaultId,
      upsert: opts.upsert !== false,
      pruneMissing: Boolean(opts.pruneMissing),
      folderPrefix: opts.folderPrefix == null ? undefined : opts.folderPrefix,
    }),
  resyncOwnedKnowledgeBase: async (id, opts = {}) =>
    gatewayProxy('POST', `/knowledge/owned/bases/${encodeURIComponent(String(id || ''))}/resync`, {
      pruneMissing: Boolean(opts.pruneMissing),
    }),
  listOwnedKnowledgeJobs: async (id, opts = {}) => {
    const q = new URLSearchParams()
    if (opts.limit != null) q.set('limit', String(opts.limit))
    if (opts.activeOnly) q.set('activeOnly', 'true')
    const qs = q.toString()
    return gatewayProxy(
      'GET',
      `/knowledge/owned/bases/${encodeURIComponent(String(id || ''))}/jobs${qs ? `?${qs}` : ''}`,
      null,
      null,
      { preferGatewayHttp: true },
    )
  },
  listOwnedKnowledgeActivities: async (opts = {}) => {
    const q = new URLSearchParams()
    if (opts.limit != null) q.set('limit', String(opts.limit))
    if (opts.before) q.set('before', String(opts.before))
    if (opts.kbId) {
      if (opts.docId) q.set('docId', String(opts.docId))
      const qs = q.toString()
      return gatewayProxy(
        'GET',
        `/knowledge/owned/bases/${encodeURIComponent(String(opts.kbId))}/activities${qs ? `?${qs}` : ''}`,
        null,
        null,
        { preferGatewayHttp: true },
      )
    }
    const qs = q.toString()
    return gatewayProxy(
      'GET',
      `/knowledge/owned/activities${qs ? `?${qs}` : ''}`,
      null,
      null,
      { preferGatewayHttp: true },
    )
  },
  getOwnedKnowledgeSettings: async () => gatewayProxy('GET', '/knowledge/owned/settings'),
  setOwnedKnowledgeSettings: async (data) => gatewayProxy('PUT', '/knowledge/owned/settings', data),
  getOwnedKnowledgeDocumentLinks: async (docId) =>
    gatewayProxy('GET', `/knowledge/owned/documents/${encodeURIComponent(String(docId || ''))}/links`),
  listOwnedKnowledgeTags: async (id) =>
    gatewayProxy(
      'GET',
      `/knowledge/owned/bases/${encodeURIComponent(String(id || ''))}/tags`,
      null,
      null,
      { preferGatewayHttp: true },
    ),
  getOwnedKnowledgeDocGraph: async (id, opts = {}) => {
    const q = new URLSearchParams()
    if (opts.center) q.set('center', String(opts.center))
    if (opts.depth != null) q.set('depth', String(opts.depth))
    const qs = q.toString()
    return gatewayProxy(
      'GET',
      `/knowledge/owned/bases/${encodeURIComponent(String(id || ''))}/doc-graph${qs ? `?${qs}` : ''}`,
    )
  },
  updateOwnedKnowledgeDocumentContent: async (docId, data) =>
    gatewayProxy(
      'PUT',
      `/knowledge/owned/documents/${encodeURIComponent(String(docId || ''))}/content`,
      data,
    ),
  uploadOwnedKnowledgeDocument: async (id, file, folderPath = '') => {
    const formData = new FormData()
    formData.append('file', file)
    if (folderPath) formData.append('folderPath', String(folderPath))
    const { getAuthToken } = await import('./webui-remote.js')
    const token = getAuthToken()
    const headers = {}
    if (token) headers.Authorization = `Bearer ${token}`
    const baseUrl = await getGatewayBaseUrl()
    const url = `${baseUrl}/api/knowledge/owned/bases/${encodeURIComponent(String(id || ''))}/documents`
    const resp = await fetch(url, { method: 'POST', headers, body: formData })
    if (!resp.ok) {
      let detail = `Upload failed: ${resp.status}`
      try {
        const body = await resp.json()
        detail = body?.detail || body?.message || detail
      } catch { /* ignore */ }
      throw new Error(detail)
    }
    return resp.json()
  },
  getOwnedKnowledgeDocument: async (docId) =>
    gatewayProxy('GET', `/knowledge/owned/documents/${encodeURIComponent(String(docId || ''))}`),
  getOwnedKnowledgeDocumentContent: async (docId) =>
    gatewayProxy('GET', `/knowledge/owned/documents/${encodeURIComponent(String(docId || ''))}/content`),
  fetchOwnedKnowledgeDocumentFileObjectUrl: async (docId) => {
    const { getAuthToken } = await import('./webui-remote.js')
    const token = getAuthToken()
    const headers = {}
    if (token) headers.Authorization = `Bearer ${token}`
    const baseUrl = await getGatewayBaseUrl()
    const url = `${baseUrl}/api/knowledge/owned/documents/${encodeURIComponent(String(docId || ''))}/file`
    const resp = await fetch(url, { headers })
    if (!resp.ok) throw new Error(`Document file fetch failed: ${resp.status}`)
    const blob = await resp.blob()
    return URL.createObjectURL(blob)
  },
  enqueueOwnedKnowledgeDocumentSummary: async (docId, { force } = {}) =>
    gatewayProxy(
      'POST',
      `/knowledge/owned/documents/${encodeURIComponent(String(docId || ''))}/summary`,
      { force: !!force },
    ),
  askOwnedKnowledge: async (id, body) =>
    gatewayProxy('POST', `/knowledge/owned/bases/${encodeURIComponent(String(id || ''))}/ask`, body),
  deleteOwnedKnowledgeDocument: async (docId) =>
    gatewayProxy('DELETE', `/knowledge/owned/documents/${encodeURIComponent(String(docId || ''))}`),
  listOwnedKnowledgeChunks: async (docId) =>
    gatewayProxy('GET', `/knowledge/owned/documents/${encodeURIComponent(String(docId || ''))}/chunks`),
  searchOwnedKnowledge: async (id, body) =>
    gatewayProxy('POST', `/knowledge/owned/bases/${encodeURIComponent(String(id || ''))}/search`, body),
  getOwnedKnowledgeJob: async (jobId) =>
    gatewayProxy('GET', `/knowledge/owned/jobs/${encodeURIComponent(String(jobId || ''))}`),
  fetchOwnedKnowledgeAssetObjectUrl: async (assetId) => {
    const { getAuthToken } = await import('./webui-remote.js')
    const token = getAuthToken()
    const headers = {}
    if (token) headers.Authorization = `Bearer ${token}`
    const baseUrl = await getGatewayBaseUrl()
    const url = `${baseUrl}/api/knowledge/owned/assets/${encodeURIComponent(String(assetId || ''))}`
    const resp = await fetch(url, { headers })
    if (!resp.ok) throw new Error(`Asset fetch failed: ${resp.status}`)
    const blob = await resp.blob()
    return URL.createObjectURL(blob)
  },
  listOwnedWikiPages: async (id, pageType) =>
    gatewayProxy(
      'GET',
      `/knowledge/owned/bases/${encodeURIComponent(String(id || ''))}/wiki/pages`,
      null,
      pageType ? { pageType } : null,
    ),
  getOwnedWikiPage: async (id, slug) =>
    gatewayProxy(
      'GET',
      `/knowledge/owned/bases/${encodeURIComponent(String(id || ''))}/wiki/pages/${String(slug || '').split('/').map(encodeURIComponent).join('/')}`,
    ),
  updateOwnedWikiPage: async (id, slug, data) =>
    gatewayProxy(
      'PUT',
      `/knowledge/owned/bases/${encodeURIComponent(String(id || ''))}/wiki/pages/${String(slug || '').split('/').map(encodeURIComponent).join('/')}`,
      data,
    ),
  getOwnedWikiGraph: async (id, { center, depth } = {}) =>
    gatewayProxy(
      'GET',
      `/knowledge/owned/bases/${encodeURIComponent(String(id || ''))}/wiki/graph`,
      null,
      { center: center || undefined, depth: depth || 2 },
    ),
  rebuildOwnedWiki: async (id) =>
    gatewayProxy('POST', `/knowledge/owned/bases/${encodeURIComponent(String(id || ''))}/wiki/rebuild`),
  getOwnedKgGraph: async (id, { center } = {}) =>
    gatewayProxy(
      'GET',
      `/knowledge/owned/bases/${encodeURIComponent(String(id || ''))}/kg/graph`,
      null,
      { center: center || undefined },
    ),
  getOwnedKgStats: async (id) =>
    gatewayProxy('GET', `/knowledge/owned/bases/${encodeURIComponent(String(id || ''))}/kg/stats`),
  rebuildOwnedKg: async (id, heuristicOnly = true) =>
    gatewayProxy(
      'POST',
      `/knowledge/owned/bases/${encodeURIComponent(String(id || ''))}/kg/rebuild`,
      null,
      { heuristicOnly: heuristicOnly ? 'true' : 'false' },
    ),

  // ---- Knowledge Vault (Obsidian) — external connector ----
  listKnowledgeVaults: async () =>
    gatewayProxy('GET', '/knowledge/vaults', null, null, { preferGatewayHttp: true }),
  createKnowledgeVault: async (data) => gatewayProxy('POST', '/knowledge/vaults', data),
  getKnowledgeVault: async (id) =>
    gatewayProxy('GET', `/knowledge/vaults/${encodeURIComponent(String(id || ''))}`),
  updateKnowledgeVault: async (id, data) =>
    gatewayProxy('PUT', `/knowledge/vaults/${encodeURIComponent(String(id || ''))}`, data),
  deleteKnowledgeVault: async (id) =>
    gatewayProxy('DELETE', `/knowledge/vaults/${encodeURIComponent(String(id || ''))}`),
  testKnowledgeVault: async (id) =>
    gatewayProxy('POST', `/knowledge/vaults/${encodeURIComponent(String(id || ''))}/test`),
  getKnowledgeVaultStatus: async (id) =>
    gatewayProxy(
      'GET',
      `/knowledge/vaults/${encodeURIComponent(String(id || ''))}/status`,
      null,
      null,
      { preferGatewayHttp: true },
    ),
  listKnowledgeVaultNotes: async (id, query = {}) => {
    const q = {}
    if (query.limit != null) q.limit = query.limit
    if (query.prefix) q.prefix = query.prefix
    return gatewayProxy(
      'GET',
      `/knowledge/vaults/${encodeURIComponent(String(id || ''))}/notes`,
      null,
      Object.keys(q).length ? q : null,
    )
  },
  installKnowledgeVault: async (id) =>
    gatewayProxy('POST', `/knowledge/vaults/${encodeURIComponent(String(id || ''))}/install`),
  reindexKnowledgeVault: async (id, path = null, options = null) =>
    gatewayProxy('POST', `/knowledge/vaults/${encodeURIComponent(String(id || ''))}/reindex`, {
      path,
      force: options?.force !== false,
      wait: !!options?.wait,
    }),
  getKnowledgeVaultReindexJob: async (id) =>
    gatewayProxy('GET', `/knowledge/vaults/${encodeURIComponent(String(id || ''))}/reindex/job`),
  searchKnowledgeVault: async (id, body) =>
    gatewayProxy('POST', `/knowledge/vaults/${encodeURIComponent(String(id || ''))}/search`, body),
  readKnowledgeVault: async (id, body) =>
    gatewayProxy('POST', `/knowledge/vaults/${encodeURIComponent(String(id || ''))}/read`, body),
  saveKnowledgeVaultNote: async (id, body) =>
    gatewayProxy('POST', `/knowledge/vaults/${encodeURIComponent(String(id || ''))}/save`, body),
  graphKnowledgeVault: async (id, body) =>
    gatewayProxy('POST', `/knowledge/vaults/${encodeURIComponent(String(id || ''))}/graph`, body),
  fullGraphKnowledgeVault: async (id, params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return gatewayProxy('GET', `/knowledge/vaults/${encodeURIComponent(String(id || ''))}/graph${qs ? `?${qs}` : ''}`);
  },
  ingestKnowledgeVault: async (id, body) =>
    gatewayProxy('POST', `/knowledge/vaults/${encodeURIComponent(String(id || ''))}/ingest`, body),
  openKnowledgeVaultNote: async (id, path) =>
    gatewayProxy('POST', `/knowledge/vaults/${encodeURIComponent(String(id || ''))}/open`, { path }),

  getModel: async (name) => gatewayProxy('GET', `/models/${encodeURIComponent(String(name || ''))}`),
  createModel: async (modelData) => gatewayProxy('POST', '/models', modelData),
  updateModel: async (name, modelData) =>
    gatewayProxy('PUT', `/models/${encodeURIComponent(String(name || ''))}`, modelData),
  deleteModel: async (name) =>
    gatewayProxy('DELETE', `/models/${encodeURIComponent(String(name || ''))}`),
  /** 清理历史遗留的重复模型行与过期连接链接 */
  cleanupStaleModels: async () => gatewayProxy('POST', '/models/cleanup-stale'),
  /** 获取当前主模型 */
  getPrimaryModel: async () => gatewayProxy('GET', '/models/primary'),
  /** 设置主模型 */
  setPrimaryModel: async (modelName) => gatewayProxy('POST', '/models/primary', { model_name: modelName }),
  clearModelUnavailable: async (name) =>
    gatewayProxy('POST', `/models/${encodeURIComponent(String(name || ''))}/clear-unavailable`),
  probeEmbeddingModel: async (modelName) =>
    gatewayProxy('POST', '/models/embedding-probe', { model_name: modelName }),
  /** 使用 Gateway DB 中的模型做一次对话补全（与主会话同源，密钥不经过浏览器直连厂商） */
  invokeConfiguredModel: async (request) => gatewayProxy('POST', '/models/invoke', request),

  // Agent 扩展能力（非 Gateway 标准协议）
  backupAgent: (id) => invoke('backup_agent', { id }),
  // 工作空间（本机路径校验/规范化）
  resolveWorkspacePath: async (path) => {
    return gatewayProxy('POST', '/workspaces/resolve', { path })
  },
  listWorkspaces: async () => gatewayProxy('GET', '/workspaces'),
  listUserWorkspaceHistory: async () => gatewayProxy('GET', '/workspaces/user-history'),
  browseWorkspace: async (root, path = '.', threadId = undefined, scopeOpts = undefined) => {
    const { workspaceApiArgs } = await import('./workspace-api-scope.js')
    const { root: r, threadId: t } = workspaceApiArgs(root, threadId, scopeOpts)
    const q = new URLSearchParams({ path: String(path || '.') })
    if (r) q.set('root', r)
    if (t) q.set('thread_id', t)
    return gatewayProxy('GET', `/workspaces/browse?${q.toString()}`)
  },
  readWorkspaceFile: async (root, path, threadId = undefined, scopeOpts = undefined) => {
    const { workspaceApiArgs, normalizeWorkspaceReadPath } = await import('./workspace-api-scope.js')
    const { root: r, threadId: t } = workspaceApiArgs(root, threadId, scopeOpts)
    const body = { path: normalizeWorkspaceReadPath(path, r) }
    if (r) body.root = r
    if (t) body.thread_id = t
    return gatewayProxy('POST', '/workspaces/read-file', body)
  },
  deleteWorkspaceFile: async (root, path, threadId = undefined, scopeOpts = undefined) => {
    const { workspaceApiArgs, normalizeWorkspaceRelPath } = await import('./workspace-api-scope.js')
    const { root: r, threadId: t } = workspaceApiArgs(root, threadId, scopeOpts)
    const body = { path: normalizeWorkspaceRelPath(path, r) }
    if (r) body.root = r
    if (t) body.thread_id = t
    return gatewayProxy('POST', '/workspaces/delete-file', body)
  },
  writeWorkspaceFile: async (root, path, content, threadId = undefined, scopeOpts = undefined) => {
    const { workspaceApiArgs, normalizeWorkspaceRelPath } = await import('./workspace-api-scope.js')
    const { root: r, threadId: t } = workspaceApiArgs(root, threadId, scopeOpts)
    const body = { path: normalizeWorkspaceRelPath(path, r), content: String(content || '') }
    if (r) body.root = r
    if (t) body.thread_id = t
    return gatewayProxy('POST', '/workspaces/write-file', body)
  },
  createWorkspaceDir: async (root, path, threadId = undefined, scopeOpts = undefined) => {
    const { workspaceApiArgs, normalizeWorkspaceRelPath } = await import('./workspace-api-scope.js')
    const { root: r, threadId: t } = workspaceApiArgs(root, threadId, scopeOpts)
    const body = { path: normalizeWorkspaceRelPath(path, r) }
    if (r) body.root = r
    if (t) body.thread_id = t
    return gatewayProxy('POST', '/workspaces/mkdir', body)
  },
  resolveWorkspaceTarget: async (root, path, threadId = undefined, scopeOpts = undefined) => {
    const { workspaceApiArgs, normalizeWorkspaceReadPath } = await import('./workspace-api-scope.js')
    const { root: r, threadId: t } = workspaceApiArgs(root, threadId, scopeOpts)
    const q = new URLSearchParams({ path: normalizeWorkspaceReadPath(path, r) })
    if (r) q.set('root', r)
    if (t) q.set('thread_id', t)
    return gatewayProxy('GET', `/workspaces/resolve-target?${q.toString()}`)
  },
  revealPathInFileManager: (absolutePath) => {
    // 桌面端走 Tauri；Web/Vite 开发态走 dev-api（本机 Node 开资源管理器）
    return invoke('reveal_path_in_file_manager', { path: String(absolutePath || '').trim() })
  },
  buildCodeIndex: async (root, force = false, threadId = undefined) => {
    const body = { force: !!force }
    const r = String(root || '').trim()
    const t = String(threadId || '').trim()
    if (r) body.root = r
    if (t) body.thread_id = t
    return gatewayProxy('POST', '/workspaces/index-build', body)
  },
  /** Background warm-up: shared index per workspace root; returns immediately. */
  warmCodeIndex: async (root, force = false, threadId = undefined) => {
    const r = String(root || '').trim()
    const t = String(threadId || '').trim()
    const key = t ? `thread:${t}` : `root:${r}`
    if (!force && _codeIndexWarmKeys.has(key)) {
      return { ok: true, skipped: true, reason: 'client_dedup' }
    }
    if (!force) _codeIndexWarmKeys.add(key)
    const body = { force: !!force }
    if (r) body.root = r
    if (t) body.thread_id = t
    try {
      const res = await gatewayProxy('POST', '/workspaces/index-warm', body)
      if (res?.skipped || res?.status === 'ready') {
        _codeIndexWarmKeys.add(key)
      }
      return res
    } catch (e) {
      if (!force) _codeIndexWarmKeys.delete(key)
      throw e
    }
  },
  indexWorkspaceFile: async (root, path, deleted = false, threadId = undefined) => {
    const body = { path: String(path || '').trim(), deleted: !!deleted }
    const r = String(root || '').trim()
    const t = String(threadId || '').trim()
    if (r) body.root = r
    if (t) body.thread_id = t
    return gatewayProxy('POST', '/workspaces/index-file', body)
  },
  startCodeIndexWatch: async (root, threadId = undefined) => {
    const body = {}
    const r = String(root || '').trim()
    const t = String(threadId || '').trim()
    if (r) body.root = r
    if (t) body.thread_id = t
    return gatewayProxy('POST', '/workspaces/index-watch', body)
  },
  stopCodeIndexWatch: async (root, threadId = undefined) => {
    const body = {}
    const r = String(root || '').trim()
    const t = String(threadId || '').trim()
    if (r) body.root = r
    if (t) body.thread_id = t
    return gatewayProxy('POST', '/workspaces/index-watch/stop', body)
  },
  codeIndexStatus: async (root, threadId = undefined) => {
    const q = new URLSearchParams()
    const r = String(root || '').trim()
    const t = String(threadId || '').trim()
    if (r) q.set('root', r)
    if (t) q.set('thread_id', t)
    return gatewayProxy('GET', `/workspaces/index-status?${q.toString()}`)
  },
  searchCodeIndex: async (root, query, limit = 20, threadId = undefined) => {
    const { workspaceApiArgs } = await import('./workspace-api-scope.js')
    const { root: r, threadId: t } = workspaceApiArgs(root, threadId)
    const q = new URLSearchParams({
      q: String(query || '').trim(),
      limit: String(limit || 20),
    })
    if (r) q.set('root', r)
    if (t) q.set('thread_id', t)
    return gatewayProxy('GET', `/workspaces/search?${q.toString()}`)
  },
  /** Filename/path search for @-mention and workspace file tree (no code index). */
  searchWorkspaceFiles: async (root, query, limit = 40, threadId = undefined) => {
    const { workspaceApiArgs } = await import('./workspace-api-scope.js')
    const { root: r, threadId: t } = workspaceApiArgs(root, threadId)
    const q = new URLSearchParams({
      q: String(query || '').trim(),
      limit: String(limit || 40),
    })
    if (r) q.set('root', r)
    if (t) q.set('thread_id', t)
    return gatewayProxy('GET', `/workspaces/find-files?${q.toString()}`)
  },
  // Agent 管理（Web 版语义）
  listAgents: async (query = null) => {
    const data = await gatewayProxy('GET', '/agents', null, query, { preferGatewayHttp: true })
    return data.agents || []
  },
  listAgentsDetailed: async (query = null) =>
    gatewayProxy('GET', '/agents', null, query, { preferGatewayHttp: true }),
  getAgent: async (name) => {
    return gatewayProxy('GET', `/agents/${name}`);
  },
  listAvatarPresets: async () => {
    const data = await gatewayProxy('GET', '/agents/avatar-presets')
    return Array.isArray(data?.presets) ? data.presets : []
  },
  createAgent: async (request) => {
    return gatewayProxy('POST', '/agents', request);
  },
  /** Install SkillHub expert package (skillset URL/slug) → agent + skills + avatar */
  installAgentFromSkillHub: async ({ url, agent_code = null, force_skills = false } = {}) => {
    return gatewayProxy('POST', '/agents/install-from-skillhub', {
      url,
      ...(agent_code ? { agent_code } : {}),
      force_skills: !!force_skills,
    })
  },
  updateAgent: async (name, request) => {
    return gatewayProxy('PUT', `/agents/${name}`, request);
  },
  uploadAgentAvatar: async (name, blob, filename = 'avatar.webp') => {
    const base = await getGatewayBaseUrl()
    const form = new FormData()
    form.append('file', blob, filename)
    const res = await fetch(`${base}/api/agents/${encodeURIComponent(name)}/avatar`, {
      method: 'POST',
      body: form,
    })
    const text = await res.text()
    let result
    try { result = JSON.parse(text) } catch { result = text }
    if (!res.ok) throw new Error(result?.detail || `Upload failed: ${res.status}`)
    return result
  },
  deleteAgent: async (name) => {
    return gatewayProxy('DELETE', `/agents/${name}`);
  },
  checkAgentName: async (name) => {
    return gatewayProxy('GET', '/agents/check', null, { name });
  },
  // 传统 Agent 接口（保持兼容）
  agentsList: async () => {
    const data = await invoke('agents_list')
    const agents = Array.isArray(data?.agents) ? data.agents : (Array.isArray(data) ? data : [])
    return { agents: agents.map(normalizeAgentToWebShape) }
  },
  agentsGet: async (name) => {
    const data = await api.agentsList()
    const found = (data.agents || []).find(a => a.name === name)
    if (!found) throw new Error(`Agent '${name}' not found`)
    return found
  },
  agentsCreate: async ({ name, description = '', model = null, tool_groups = null, soul = '' }) => {
    const res = await invoke('agents_create', { name, description, model, tool_groups, soul })
    invalidate('agents_list')
    return normalizeAgentToWebShape(res)
  },
  agentsUpdate: async (name, { description = null, model = null, tool_groups = null, soul = null }) => {
    const res = await invoke('agents_update', { name, description, model, tool_groups, soul })
    invalidate('agents_list')
    return normalizeAgentToWebShape(res)
  },
  agentsDelete: async (name) => {
    await invoke('agents_delete', { name })
    invalidate('agents_list')
    return { success: true }
  },

  // 聊天会话（统一接口入口，底层走 EvoFlow HTTP/SSE 客户端）
  /** 侧栏工作目录汇总（各目录会话总数） */
  chatSessionsWorkspaceGroups: async () => {
    const { wsClient } = await import('./ws-client.js')
    return wsClient.sessionsWorkspaceGroups()
  },
  /** 侧栏会话列表/刷新：仅读 ``GET /api/chat/sessions``（SQLite ``evoflow_chat_sessions``） */
  chatSessionsList: async (limit = 20, offset = 0, workspaceKey = null) => {
    const { wsClient } = await import('./ws-client.js')
    return wsClient.sessionsList(limit, offset, workspaceKey)
  },

  /** 单会话详情（含 modelName）：``GET /api/chat/sessions/{key}`` */
  chatSessionsGet: async (sessionKey) => {
    const { wsClient } = await import('./ws-client.js')
    return wsClient.getChatSession(sessionKey)
  },

  /** 创建只读分享快照：``POST /api/share`` */
  shareCreate: async (payload) => gatewayProxy('POST', '/share', payload || {}),
  /** 公开读取分享快照：``GET /api/share/{token}`` */
  shareGet: async (token) =>
    gatewayProxy('GET', `/share/${encodeURIComponent(String(token || ''))}`, null, null, {
      silent: true,
    }),
  /** 撤销分享：``DELETE /api/share/{token}`` */
  shareRevoke: async (token) =>
    gatewayProxy('DELETE', `/share/${encodeURIComponent(String(token || ''))}`),
  /** 会话最近一次分享元信息 */
  shareLatestForSession: async (sessionKey) =>
    gatewayProxy('GET', '/share/by-session/latest', null, {
      session_key: String(sessionKey || '').trim(),
    }),

  /** 搜索会话（标题+消息内容，覆盖全部会话，不受分页限制）：``GET /api/chat/sessions?search=`` */
  chatSessionsSearch: async (query, limit = 50) => {
    const { wsClient } = await import('./ws-client.js')
    return wsClient.sessionsSearch(query, limit)
  },
  chatSessionsCreate: async (agentId = 'main', options = {}) => {
    const { wsClient } = await import('./ws-client.js')
    return wsClient.createChatSession(agentId, options)
  },
  /** 获取当前正在执行中的会话列表（可选传入候选 session_keys 以减少服务端扫描） */
  getActiveSessions: async (options = {}) => {
    const rawKeys = Array.isArray(options?.sessionKeys) ? options.sessionKeys : []
    const keys = rawKeys
      .map((s) => String(s || '').trim())
      .filter(Boolean)
      .slice(0, 12)
    const query = keys.length > 0 ? { session_keys: keys.join(',') } : null
    return gatewayProxy('GET', '/langgraph/active-sessions', null, query, { silent: true })
  },
  chatSessionsDelete: async (sessionKey, options = {}) => {
    const { wsClient } = await import('./ws-client.js')
    return wsClient.sessionsDelete(sessionKey, options)
  },
  chatSessionsReset: async (sessionKey) => {
    const { wsClient } = await import('./ws-client.js')
    return wsClient.sessionsReset(sessionKey)
  },
  /** Fork (branch) a chat session into a new session with copied transcript. */
  chatSessionsFork: async (sessionKey, options = {}) => {
    const key = String(sessionKey || '').trim()
    if (!key) throw new Error('session_key required')
    const body = {}
    if (options?.throughSeq != null) body.throughSeq = Number(options.throughSeq)
    if (options?.throughMessageId) body.throughMessageId = String(options.throughMessageId)
    if (options?.beforeMessageId) body.beforeMessageId = String(options.beforeMessageId)
    if (options?.title) body.title = String(options.title)
    return gatewayProxy('POST', `/chat/sessions/${encodeURIComponent(key)}/fork`, body)
  },
  /** In-place rewind: delete fromMessageId and everything after (same session). */
  chatSessionsTruncate: async (sessionKey, options = {}) => {
    const key = String(sessionKey || '').trim()
    const fromMessageId = String(options?.fromMessageId || '').trim()
    if (!key) throw new Error('session_key required')
    if (!fromMessageId) throw new Error('fromMessageId required')
    return gatewayProxy('POST', `/chat/sessions/${encodeURIComponent(key)}/truncate`, {
      fromMessageId,
    })
  },
  chatSessionSetPinned: async (sessionKey, pinned) =>
    gatewayProxy('PATCH', `/chat/sessions/${encodeURIComponent(sessionKey)}/pin`, { pinned: !!pinned }),
  chatSessionSetHidden: async (sessionKey, hidden) =>
    gatewayProxy('PATCH', `/chat/sessions/${encodeURIComponent(sessionKey)}/hidden`, { hidden: !!hidden }),
  chatSessionRename: async (sessionKey, title) =>
    gatewayProxy('PATCH', `/chat/sessions/${encodeURIComponent(sessionKey)}/title`, { title: String(title || '').trim() }),
  chatSessionsReorderPinned: async (sessionKeys) =>
    gatewayProxy('PUT', '/chat/sessions/pinned-order', {
      sessionKeys: (sessionKeys || []).map((k) => String(k || '').trim()).filter(Boolean),
    }),
  chatHistory: async (sessionKey, limit = 40, opts) => {
    const { wsClient } = await import('./ws-client.js')
    return wsClient.chatHistory(sessionKey, limit, opts)
  },
  chatMessagesByThread: async (threadId, limit = 500) => {
    const tid = String(threadId || '').trim()
    if (!tid) return { messages: [], messageCount: 0 }
    return gatewayProxy(
      'GET',
      `/chat/sessions/by-thread/${encodeURIComponent(tid)}/messages`,
      null,
      { limit: String(Math.max(1, limit)) },
    )
  },
  chatSend: async (
    sessionKey,
    message,
    attachments = undefined,
    contextFiles = undefined,
    opts = undefined,
  ) => {
    const { wsClient } = await import('./ws-client.js')
    return wsClient.chatSend(sessionKey, message, attachments, contextFiles, opts)
  },
  /** Upload files into a thread's uploads/ (markitdown for PDF/Office). */
  uploadThreadFiles: async (threadId, files) => {
    const tid = String(threadId || '').trim()
    if (!tid) throw new Error('thread_id required')
    const list = Array.isArray(files) ? files.filter(Boolean) : []
    if (!list.length) return { success: true, files: [], message: 'No files' }
    const formData = new FormData()
    for (const f of list) {
      const name = String(f?.name || 'file').trim() || 'file'
      formData.append('files', f, name)
    }
    const { getAuthToken } = await import('./webui-remote.js')
    const token = getAuthToken()
    const headers = {}
    if (token) headers['Authorization'] = `Bearer ${token}`
    const baseUrl = await getGatewayBaseUrl()
    const url = `${baseUrl}/api/threads/${encodeURIComponent(tid)}/uploads`
    const resp = await fetch(url, { method: 'POST', headers, body: formData })
    if (!resp.ok) {
      let detail = `Upload failed: ${resp.status}`
      try {
        const body = await resp.json()
        detail = body?.detail || body?.message || detail
      } catch {
        /* ignore */
      }
      throw new Error(detail)
    }
    return resp.json()
  },
  chatGetRunStatus: async (sessionKey) => {
    const { wsClient } = await import('./ws-client.js')
    return wsClient.getSessionRunStatus(sessionKey)
  },
  chatCancelActiveRuns: async (sessionKey) => {
    const { wsClient } = await import('./ws-client.js')
    return wsClient.cancelSessionActiveRuns(sessionKey)
  },
  /** 统一停止：LangGraph cancel + DB idle + partial 封存 + collab 清理 */
  stopSessionExecution: async (sessionKey, opts = {}) => {
    const sk = String(sessionKey || '').trim()
    if (!sk) return { ok: false }
    const qs = opts?.userInitiated === false ? '?userInitiated=false' : ''
    return gatewayProxy(
      'POST',
      `/chat/sessions/${encodeURIComponent(sk)}/execution/stop${qs}`,
      null,
      null,
      { silent: opts?.silent === true },
    )
  },
  /** 取消 LangGraph 进程内所有 pending/running（释放全局 worker 池，避免新会话被旧任务堵死） */
  chatCancelAllGlobalRuns: async () => {
    const { wsClient } = await import('./ws-client.js')
    return wsClient.cancelAllGlobalRunsBestEffort()
  },
  chatAbort: async (sessionKey, runId = undefined, options = undefined) => {
    const { wsClient } = await import('./ws-client.js')
    return wsClient.chatAbort(sessionKey, runId, options)
  },
  chatUpdateContext: async (sessionKey, context) => {
    const { wsClient } = await import('./ws-client.js')
    await wsClient.updateSessionContext(sessionKey, context)
    return { ok: true }
  },
  chatGetContext: async (sessionKey) => {
    const { wsClient } = await import('./ws-client.js')
    return { context: wsClient.getSessionContext(sessionKey) }
  },
  getSessionModes: async () => {
    const { apiUrlAsync } = await import('./api-client.js')
    const url = await apiUrlAsync('/chat/sessions/session-modes')
    const res = await fetch(url)
    if (!res.ok) throw new Error(`getSessionModes failed: ${res.status}`)
    return res.json()
  },
  setSessionScenario: async (sessionKey, scenario) => {
    const { apiUrlAsync } = await import('./api-client.js')
    const url = await apiUrlAsync(`/chat/sessions/${encodeURIComponent(sessionKey)}/scenario`)
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: scenario || null }),
    })
    if (!res.ok) throw new Error(`setSessionScenario failed: ${res.status}`)
    return res.json()
  },
  chatSuggestions: async (sessionKey, n = 3, modelName = undefined, recentMessages = undefined) => {
    const { wsClient } = await import('./ws-client.js')
    return wsClient.chatSuggestions(sessionKey, n, modelName, recentMessages)
  },

  // 日志（短缓存）
  readLogTail: (logName, lines = 100) => cachedInvoke('read_log_tail', { logName, lines }, 5000),
  searchLog: (logName, query, maxResults = 50) => invoke('search_log', { logName, query, maxResults }),

  /** 系统日志诊断（Gateway /api/diagnostics；与 platform diagnostics.* 同源） */
  diagnosticsSources: (hours = 72, options = null) =>
    gatewayProxy('GET', '/diagnostics/sources', null, { hours }, options),
  diagnosticsScan: (query = {}, options = null) => {
    const out = {}
    if (query.hours != null) out.hours = query.hours
    if (query.sources) out.sources = Array.isArray(query.sources) ? query.sources.join(',') : query.sources
    if (query.limit != null) out.limit = query.limit
    if (query.max_events != null) out.limit = query.max_events
    return gatewayProxy('GET', '/diagnostics/scan', null, out, options)
  },
  diagnosticsTimeline: (query = {}, options = null) => {
    const out = {}
    if (query.hours != null) out.hours = query.hours
    if (query.sources) out.sources = Array.isArray(query.sources) ? query.sources.join(',') : query.sources
    if (query.limit != null) out.limit = query.limit
    if (query.format) out.format = query.format
    return gatewayProxy('GET', '/diagnostics/timeline', null, out, options)
  },

  // 资产中心 API（~/.evoflow/assets/）
  assetsInit: async () => gatewayProxy('POST', '/assets/init'),
  assetsListEntities: async () => gatewayProxy('GET', '/assets/entities'),
  assetsSearch: async ({
    entityType,
    entityId,
    q,
    path = '',
    kinds = '',
    matchMode = 'any',
    maxResults = 20,
    contextLines = 1,
    includeInbox = false,
  } = {}) =>
    gatewayProxy('GET', '/assets/search', null, {
      entityType,
      entityId,
      q,
      ...(path ? { path } : {}),
      ...(kinds ? { kinds } : {}),
      matchMode,
      maxResults,
      contextLines,
      includeInbox: !!includeInbox,
    }),
  assetsListTree: async ({ entityType, entityId, path = '' } = {}) =>
    gatewayProxy('GET', '/assets/tree', null, {
      entityType,
      entityId,
      ...(path ? { path } : {}),
    }),
  assetsReadFile: async ({ entityType, entityId, path } = {}) =>
    gatewayProxy('GET', '/assets/file', null, { entityType, entityId, path }),
  assetsPutFile: async ({ entityType, entityId, path, content } = {}) =>
    gatewayProxy('PUT', '/assets/file', { entityType, entityId, path, content }),
  assetsDeleteFile: async ({ entityType, entityId, path } = {}) =>
    gatewayProxy('DELETE', '/assets/file', null, { entityType, entityId, path }),
  /** 直接写 memory/facts/*.md（短事实；title + summary） */
  assetsRecord: async ({
    entityType = 'user',
    entityId = 'user',
    content,
    title = '',
    summary = '',
  } = {}) =>
    gatewayProxy('POST', '/assets/record', { entityType, entityId, content, title, summary }),
  /** 记录当前对话过程 → memory/episodic/*.md（给人回顾） */
  assetsEpisode: async ({
    entityType = 'user',
    entityId = 'user',
    content,
    title = '',
    summary = '',
  } = {}) =>
    gatewayProxy('POST', '/assets/episode', { entityType, entityId, content, title, summary }),
  /** 写/追加 memory/journal/{date}.md（带 catalog summary） */
  assetsJournal: async ({
    entityType = 'user',
    entityId = 'user',
    content,
    date = '',
    append = true,
    summary = '',
  } = {}) =>
    gatewayProxy('POST', '/assets/journal', {
      entityType,
      entityId,
      content,
      date,
      append,
      summary,
    }),
  /** 直接写 craft/{slug}/SKILL.md */
  assetsCraftSave: async ({
    entityType = 'user',
    entityId = 'user',
    title,
    content = '',
    description = '',
  } = {}) =>
    gatewayProxy('POST', '/assets/craft/save', {
      entityType,
      entityId,
      title,
      content,
      description,
    }),
  assetsGetProfile: async ({ entityType, entityId } = {}) =>
    gatewayProxy('GET', '/assets/profile', null, { entityType, entityId }),
  assetsPutProfile: async ({ entityType, entityId, field, content } = {}) =>
    gatewayProxy('PUT', '/assets/profile', { field, content }, { entityType, entityId }),
  assetsMigrate: async ({ scope = 'all', dryRun = false } = {}) =>
    gatewayProxy('POST', '/assets/migrate', null, { scope, dryRun: !!dryRun }),
  assetsPackExport: async ({ entityType = 'user', entityId = 'user' } = {}) =>
    gatewayProxy('POST', '/assets/pack/export', { entityType, entityId }),
  assetsPackImport: async ({ entityType, entityId, packPath, conflict = 'skip' } = {}) =>
    gatewayProxy('POST', '/assets/pack/import', { entityType, entityId, packPath, conflict }),
  assetsListCraft: async ({ entityType, entityId } = {}) =>
    gatewayProxy('GET', '/assets/craft', null, { entityType, entityId }),

  // 资源包 / Organization Pack（设置 → 我的资源 / 资源市场）
  orgList: async (status = 'active') =>
    gatewayProxy('GET', '/organizations', null, status === '' || status == null ? { status: '' } : { status }),
  orgGet: async (orgInstanceId) =>
    gatewayProxy('GET', `/organizations/${encodeURIComponent(String(orgInstanceId || ''))}`),
  orgPreflight: async (payload) => gatewayProxy('POST', '/organizations/preflight', payload || {}),
  orgInstall: async (payload) => gatewayProxy('POST', '/organizations/install', payload || {}),
  orgUninstall: async (payload) => gatewayProxy('POST', '/organizations/uninstall', payload || {}),
  orgExport: async (payload) => gatewayProxy('POST', '/organizations/export', payload || {}),
  orgMarketCatalog: async () => gatewayProxy('GET', '/organizations/market/catalog'),
  assetsUsageStats: async ({ entityType, entityId, topN = 12 } = {}) =>
    gatewayProxy('GET', '/assets/stats', null, { entityType, entityId, topN }),
  assetsPhase2Scan: async ({ maxEntities = 24 } = {}) =>
    gatewayProxy('POST', `/assets/phase2/scan?maxEntities=${encodeURIComponent(maxEntities)}`),
  assetsPhase2Consolidate: async ({ entityType, entityId } = {}) =>
    gatewayProxy('POST', '/assets/phase2/consolidate', null, { entityType, entityId }),
  assetsPromoteCraft: async ({ entityType, entityId, craftName, overwrite = false } = {}) =>
    gatewayProxy('POST', '/assets/craft/promote', {
      entityType,
      entityId,
      craftName,
      overwrite: !!overwrite,
    }),
  assetsApply: async ({
    sourceType,
    sourceId,
    targetType = 'employee',
    targetId,
    scopes = ['profile', 'craft'],
    conflict = 'skip',
  } = {}) =>
    gatewayProxy('POST', '/assets/apply', {
      sourceType,
      sourceId,
      targetType,
      targetId,
      scopes,
      conflict,
    }),

  // 记忆 API（global：不传 agentId；per-agent：`agents/{id}/memory.json`）
  /** @deprecated 智能体列表请用 listAgents()，与角色管理/聊天统一 */
  getMemoryAgents: async () => gatewayProxy('GET', '/memory/agents'),
  getMemory: async (agentId) => {
    const q = agentId != null && String(agentId).trim() !== '' ? { agent: String(agentId).trim() } : null;
    return gatewayProxy('GET', '/memory', null, q);
  },
  reloadMemory: async (agentId) => {
    const q = agentId != null && String(agentId).trim() !== '' ? { agent: String(agentId).trim() } : null;
    return gatewayProxy('POST', '/memory/reload', null, q);
  },
  clearMemory: async (agentId) => {
    const q = agentId != null && String(agentId).trim() !== '' ? { agent: String(agentId).trim() } : null;
    return gatewayProxy('DELETE', '/memory', null, q);
  },
  deleteMemoryFact: async (factId, agentId) => {
    const q = agentId != null && String(agentId).trim() !== '' ? { agent: String(agentId).trim() } : null;
    return gatewayProxy('DELETE', `/memory/facts/${encodeURIComponent(factId)}`, null, q);
  },
  getMemoryConfig: async () => gatewayProxy('GET', '/memory/config'),
  getMemoryStatus: async (agentId) => {
    const q = agentId != null && String(agentId).trim() !== '' ? { agent: String(agentId).trim() } : null;
    return gatewayProxy('GET', '/memory/status', null, q);
  },
  listMemoryAtoms: async (agentId, opts = {}) => {
    const q = {};
    if (opts.namespace) q.namespace = String(opts.namespace);
    else if (agentId != null && String(agentId).trim() !== '') q.agent = String(agentId).trim();
    if (opts.layer) q.layer = opts.layer;
    if (opts.pinned_only) q.pinned_only = true;
    if (opts.limit != null) q.limit = opts.limit;
    return gatewayProxy('GET', '/memory/atoms', null, q);
  },
  createMemoryAtom: async (body, agentId) => {
    const q = agentId != null && String(agentId).trim() !== '' ? { agent: String(agentId).trim() } : null;
    return gatewayProxy('POST', '/memory/atoms', body, q);
  },
  patchMemoryAtom: async (atomId, body) =>
    gatewayProxy('PATCH', `/memory/atoms/${encodeURIComponent(atomId)}`, body),
  deleteMemoryAtom: async (atomId) =>
    gatewayProxy('DELETE', `/memory/atoms/${encodeURIComponent(atomId)}`),
  recallMemory: async (body, agentId, opts = {}) => {
    const q = {};
    if (opts?.namespace) q.namespace = String(opts.namespace);
    else if (agentId != null && String(agentId).trim() !== '') q.agent = String(agentId).trim();
    return gatewayProxy('POST', '/memory/recall', body, Object.keys(q).length ? q : null);
  },
  getMemoryNamespaces: async () => gatewayProxy('GET', '/memory/namespaces'),
  clearMemoryNamespace: async (namespace) =>
    gatewayProxy('POST', '/memory/namespace/clear', { namespace: String(namespace || '') }),
  getMemoryGraph: async (agentId, opts = {}) => {
    const q = {};
    if (agentId != null && String(agentId).trim() !== '') q.agent = String(agentId).trim();
    if (opts.namespace) q.namespace = opts.namespace;
    if (opts.center) q.center = opts.center;
    if (opts.limit != null) q.limit = opts.limit;
    return gatewayProxy('GET', '/memory/graph', null, q);
  },
  getMemoryGraphNodeAtoms: async (nodeId, opts = {}) => {
    const q = {};
    if (opts.limit != null) q.limit = opts.limit;
    return gatewayProxy('GET', `/memory/graph/nodes/${encodeURIComponent(nodeId)}/atoms`, null, q);
  },
  rebuildMemoryGraph: async (agentId, opts = {}) => {
    const q = {};
    if (agentId != null && String(agentId).trim() !== '') q.agent = String(agentId).trim();
    if (opts.namespace) q.namespace = opts.namespace;
    if (opts.clear === false) q.clear = false;
    return gatewayProxy('POST', '/memory/graph/rebuild', null, q);
  },
  syncAssetsToGraph: async (entityType, entityId, dryRun = false) => {
    const q = { entity_type: entityType, entity_id: entityId, dry_run: dryRun };
    return gatewayProxy('POST', '/memory/assets-sync', null, q);
  },
  consolidateMemory: async (body) => gatewayProxy('POST', '/memory/consolidate', body || {}),
  getMemoryRecallSnapshot: async (threadId) => {
    const q = { thread_id: String(threadId || '').trim() };
    return gatewayProxy('GET', '/memory/recall-snapshot', null, q);
  },
  getWorkspaceProjectMemory: async (path, opts = {}) => {
    const q = { path: String(path || '') };
    if (opts.limit != null) q.limit = opts.limit;
    return gatewayProxy('GET', '/memory/workspace', null, q);
  },
  createWorkspaceProjectMemoryAtom: async (body) =>
    gatewayProxy('POST', '/memory/workspace/atoms', body || {}),

  // 记忆文件
  listMemoryFiles: (category, agentId) => cachedInvoke('list_memory_files', { category, agentId: agentId || null }),
  readMemoryFile: (path, agentId) => cachedInvoke('read_memory_file', { path, agentId: agentId || null }, 5000),
  writeMemoryFile: (path, content, category, agentId) => { invalidate('list_memory_files', 'read_memory_file'); return invoke('write_memory_file', { path, content, category: category || 'memory', agentId: agentId || null }) },
  deleteMemoryFile: (path, agentId) => { invalidate('list_memory_files'); return invoke('delete_memory_file', { path, agentId: agentId || null }) },
  exportMemoryZip: (category, agentId) => invoke('export_memory_zip', { category, agentId: agentId || null }),

  // 消息渠道管理
  readPlatformConfig: (platform) => invoke('read_platform_config', { platform }),
  saveMessagingPlatform: (platform, form, accountId) => { invalidate('list_configured_platforms', 'read_platform_config'); return invoke('save_messaging_platform', { platform, form, accountId: accountId || null }) },
  removeMessagingPlatform: (platform) => { invalidate('list_configured_platforms', 'read_platform_config'); return invoke('remove_messaging_platform', { platform }) },
  toggleMessagingPlatform: (platform, enabled) => { invalidate('list_configured_platforms', 'read_evoflow_config', 'read_platform_config'); return invoke('toggle_messaging_platform', { platform, enabled }) },
  verifyBotToken: (platform, form) => invoke('verify_bot_token', { platform, form }),
  listConfiguredPlatforms: () => cachedInvoke('list_configured_platforms', {}, 5000),
  getChannelPluginStatus: (pluginId) => invoke('get_channel_plugin_status', { pluginId }),
  installQqbotPlugin: () => invoke('install_qqbot_plugin'),
  installChannelPlugin: (packageName, pluginId) => invoke('install_channel_plugin', { packageName, pluginId }),

  // 面板配置 (evopanel.json)
  getPanelSettings: async () => gatewayProxy('GET', '/settings/panel'),
  patchPanelSettings: async (settings) => gatewayProxy('PATCH', '/settings/panel', { settings: settings || {} }),

  /** 主库费用账本（设置 → 使用统计） */
  usageSummary: (query = {}) => {
    const out = {}
    if (query.from) out.from = query.from
    if (query.to) out.to = query.to
    if (query.category) out.category = query.category
    return gatewayProxy('GET', '/usage/summary', null, out)
  },
  usageDaily: (query = {}) => {
    const out = {}
    if (query.from) out.from = query.from
    if (query.to) out.to = query.to
    if (query.category) out.category = query.category
    return gatewayProxy('GET', '/usage/daily', null, out)
  },
  usageDailyBySku: (query = {}) => {
    const out = {}
    if (query.from) out.from = query.from
    if (query.to) out.to = query.to
    if (query.category) out.category = query.category
    if (query.top_n != null) out.top_n = String(query.top_n)
    return gatewayProxy('GET', '/usage/daily-by-sku', null, out)
  },
  usageByCategory: (query = {}) => {
    const out = {}
    if (query.from) out.from = query.from
    if (query.to) out.to = query.to
    return gatewayProxy('GET', '/usage/by-category', null, out)
  },
  usageBySku: (query = {}) => {
    const out = {}
    if (query.from) out.from = query.from
    if (query.to) out.to = query.to
    if (query.category) out.category = query.category
    return gatewayProxy('GET', '/usage/by-sku', null, out)
  },
  /** Admin-only: usage / cost broken down by principal (user). */
  usageByPrincipal: (query = {}) => {
    const out = {}
    if (query.from) out.from = query.from
    if (query.to) out.to = query.to
    if (query.category) out.category = query.category
    if (query.limit != null) out.limit = String(query.limit)
    return gatewayProxy('GET', '/usage/by-principal', null, out)
  },

  readPanelConfig: () => (isTauri ? invoke('read_panel_config') : Promise.resolve({})),
  writePanelConfig: (config) => invoke('write_panel_config', { config }),
  /** 开发者 UI：托盘 DevTools、侧栏会话调试；Web 开发模式默认全开 */
  getDeveloperUiFlags: () =>
    isTauri
      ? invoke('get_developer_ui_flags')
      : Promise.resolve({
          enableDevtools: !!import.meta.env.DEV,
          showSessionDebug: !!import.meta.env.DEV,
        }),
  applyWorkspaceSettings: (migrateFrom) =>
    invoke('apply_workspace_settings', {
      migrateFrom: migrateFrom != null && String(migrateFrom).trim() ? String(migrateFrom).trim() : null,
    }),
  workspaceRuntimeInfo: () => invoke('workspace_runtime_info'),
  testProxy: (url) => invoke('test_proxy', { url: url || null }),

  // 安装/部署（保留前端热更新与基础文件能力）
  checkPanelUpdate: () => invoke('check_panel_update'),
  writeEnvFile: (path, config) => invoke('write_env_file', { path, config }),

  // 备份管理
  listBackups: () => cachedInvoke('list_backups'),
  createBackup: () => { invalidate('list_backups'); return invoke('create_backup') },
  restoreBackup: (name) => invoke('restore_backup', { name }),
  deleteBackup: (name) => { invalidate('list_backups'); return invoke('delete_backup', { name }) },

  // 设备密钥 + Gateway 握手
  createConnectFrame: (nonce, gatewayToken) => {
    if (!isTauri) {
      return Promise.resolve({
        type: 'req',
        id: `connect-${Date.now()}`,
        method: 'connect',
        params: { nonce: nonce || '', token: gatewayToken || '' },
      })
    }
    return invoke('create_connect_frame', { nonce, gatewayToken })
  },

  // 设备配对
  autoPairDevice: () => invoke('auto_pair_device'),
  checkPairingStatus: () => invoke('check_pairing_status'),
  pairingListChannel: (channel) => invoke('pairing_list_channel', { channel }),
  pairingApproveChannel: (channel, code, notify = false) => invoke('pairing_approve_channel', { channel, code, notify }),

  // AI 助手工具
  assistantExec: (command, cwd) => invoke('assistant_exec', { command, cwd: cwd || null }),
  assistantReadFile: (path) => invoke('assistant_read_file', { path }),
  assistantWriteFile: (path, content) => invoke('assistant_write_file', { path, content }),
  assistantListDir: (path) => invoke('assistant_list_dir', { path }),
  assistantSystemInfo: () => invoke('assistant_system_info'),
  assistantListProcesses: (filter) => invoke('assistant_list_processes', { filter: filter || null }),
  assistantCheckPort: (port) => invoke('assistant_check_port', { port }),
  assistantWebSearch: (query, maxResults) => invoke('assistant_web_search', { query, max_results: maxResults || 5 }),
  assistantFetchUrl: (url) => invoke('assistant_fetch_url', { url }),

  // 技能接口（Web 版语义）— 统一走 skill-catalog 全局缓存
  loadSkills: async (opts) => {
    const mod = await import('./skill-catalog.js')
    const rows = await mod.loadSkillCatalog({ force: opts?.force === true })
    return mod.skillCatalogToApiRows(rows)
  },
  enableSkill: async (skillName, enabled) => {
    const result = await gatewayProxy('PUT', `/skills/${skillName}`, { enabled })
    const mod = await import('./skill-catalog.js')
    await mod.reloadSkillCatalog()
    return result
  },
  /** Upload a .zip file directly and install it (no thread_id needed). */
  uploadSkillFile: async (file) => {
    const base = await getGatewayBaseUrl()
    const formData = new FormData()
    formData.append('file', file)
    const res = await fetch(`${base}/api/skills/install-local`, {
      method: 'POST',
      body: formData,
    })
    const text = await res.text()
    let result
    try { result = JSON.parse(text) } catch { result = text }
    if (!res.ok) {
      const msg = result?.detail || result?.error || `Upload failed: ${res.status}`
      throw new Error(msg)
    }
    return reloadSkillCatalogAfterMutation(result)
  },
  /** Install a skill from a local directory path (Tauri folder selection). */
  installSkillFromPath: async (dirPath) =>
    reloadSkillCatalogAfterMutation(
      gatewayProxy('POST', '/skills/install-from-path', { path: dirPath }),
    ),

  // MCP 工具 API
  getMCPConfig: async () => gatewayProxy('GET', '/mcp/config'),
  updateMCPConfig: async (mcpServers) => gatewayProxy('PUT', '/mcp/config', { mcp_servers: mcpServers }),

  // 工具元数据（内置工具列表 + MCP服务器 + Skills，用于 Agent 配置 UI）
  getToolsMetadata: () => cachedGateway('GET', '/tools/metadata'),

  // EvoFlow 多渠道 API
  getChannelsStatus: async () => gatewayProxy('GET', '/channels/'),
  restartChannel: async (name) => gatewayProxy('POST', `/channels/${name}/restart`),
  enableChannel: async (name, enabled) => gatewayProxy('POST', `/channels/${name}/enable`, { enabled }),
  getChannelConfig: async (name) => gatewayProxy('GET', `/channels/${name}/config`),
  updateChannelConfig: async (name, config) => gatewayProxy('PUT', `/channels/${name}/config`, config),

  // Proactive AI（智能体员工）API
  proactiveStatus: async () => gatewayProxy('GET', '/proactive/status'),
  proactiveEnable: async () => gatewayProxy('POST', '/proactive/enable'),
  proactiveDisable: async () => gatewayProxy('POST', '/proactive/disable'),
  // Product license
  licenseStatus: async () => gatewayProxy('GET', '/license/status'),
  licenseActivate: async (code) => gatewayProxy('POST', '/license/activate', { code }),
  licenseDeactivate: async () => gatewayProxy('POST', '/license/deactivate'),
  licenseCodesMeta: async () => gatewayProxy('GET', '/license/codes/meta'),
  licenseCodesList: async (params) =>
    gatewayProxy('GET', '/license/codes', null, params || null),
  licenseCodesIssue: async (payload) => gatewayProxy('POST', '/license/codes', payload),
  licenseCodesRevoke: async (id) =>
    gatewayProxy('POST', `/license/codes/${encodeURIComponent(String(id || ''))}/revoke`),
  proactiveListRoles: async (status) =>
    gatewayProxy('GET', '/proactive/roles', null, status ? { status } : null, {
      preferGatewayHttp: true,
    }),
  proactiveOrgTree: async (status = null) =>
    gatewayProxy('GET', '/proactive/org-tree', null, status ? { status } : null),
  proactiveGetRole: async (code) => gatewayProxy('GET', `/proactive/roles/${code}`),
  proactiveCreateRole: async (payload) => gatewayProxy('POST', '/proactive/roles', payload),
  proactiveUpdateRole: async (code, payload) => gatewayProxy('PUT', `/proactive/roles/${encodeURIComponent(String(code || ''))}`, payload),
  proactiveDeleteRole: async (code) => gatewayProxy('DELETE', `/proactive/roles/${encodeURIComponent(String(code || ''))}`),
  proactivePauseRole: async (code) =>
    gatewayProxy('PUT', `/proactive/roles/${encodeURIComponent(String(code || ''))}/pause`),
  /** 仅停止在途上班，不暂停岗位自动巡检 */
  proactiveStopRole: async (code) =>
    gatewayProxy('POST', `/proactive/roles/${encodeURIComponent(String(code || ''))}/stop`),
  proactiveResumeRole: async (code) =>
    gatewayProxy('PUT', `/proactive/roles/${encodeURIComponent(String(code || ''))}/resume`),
  proactiveHeartbeat: async (code, payload = null) =>
    gatewayProxy(
      'POST',
      `/proactive/roles/${encodeURIComponent(String(code || ''))}/heartbeat`,
      payload && typeof payload === 'object' ? payload : {},
      null,
      { timeoutMs: 600_000 },
    ),
  proactiveDispatchTask: async (code, payload) =>
    gatewayProxy('POST', `/proactive/roles/${encodeURIComponent(String(code || ''))}/dispatch`, payload, null, { timeoutMs: 30_000 }),
  proactiveRoleBusy: async (code) => {
    const agentCode = String(code || '').trim()
    if (!agentCode || agentCode === 'main') {
      return { busy: false, is_busy: false, current_session_key: '', current_round_id: '', missing: true }
    }
    try {
      return await gatewayProxy(
        'GET',
        `/proactive/roles/${encodeURIComponent(agentCode)}/busy`,
        null,
        null,
        { silent: true },
      )
    } catch (err) {
      const status = Number(err?.status)
      const msg = String(err?.message || err || '')
      // Best-effort busy probe: treat missing / invalid role codes as idle (404/422).
      if (status === 404 || status === 422 || /not found|unprocessable/i.test(msg)) {
        return { busy: false, is_busy: false, current_session_key: '', current_round_id: '', missing: true }
      }
      throw err
    }
  },
  /** 员工工作空间下的多会话列表（duty/task/chat） */
  proactiveListConversations: async (code, params) =>
    gatewayProxy(
      'GET',
      `/proactive/sessions/${encodeURIComponent(String(code || ''))}/conversations`,
      null,
      params || null,
    ),
  proactiveListInitiatives: async (params) => gatewayProxy('GET', '/proactive/initiatives', null, params || null),
  /** 员工页：工作汇报轮次 + 岗位工作项 Tasks 聚合（角色暂不可见时返回空板，不抛 404） */
  proactiveRoleWorkBoard: async (code, limit = 100) => {
    const agentCode = String(code || '').trim()
    const emptyBoard = {
      agent_code: agentCode,
      role_name: '',
      tasks: [],
      rounds: [],
      pending_approvals: [],
      counts: { pending_approvals: 0 },
      missing: true,
    }
    if (!agentCode || agentCode === 'main') return emptyBoard
    try {
      return await gatewayProxy(
        'GET',
        `/proactive/roles/${encodeURIComponent(agentCode)}/work-board`,
        null,
        { limit },
        { silent: true },
      )
    } catch (err) {
      const status = Number(err?.status)
      const msg = String(err?.message || err || '')
      if (status === 404 || /not found/i.test(msg)) {
        return emptyBoard
      }
      throw err
    }
  },
  proactiveMigrateWorkItems: async (params) =>
    gatewayProxy('POST', '/proactive/migrate-work-items', null, params || null),
  proactiveGetInitiative: async (id) =>
    gatewayProxy('GET', `/proactive/initiatives/${encodeURIComponent(String(id || ''))}`),
  proactiveListApprovals: async (status) =>
    gatewayProxy('GET', '/proactive/approvals', null, status ? { status } : null, {
      preferGatewayHttp: true,
    }),
  proactiveApprove: async (initId, decision, decidedBy, comment, rejectionReason) =>
    gatewayProxy('POST', `/proactive/approval/${encodeURIComponent(String(initId || ''))}`, {
      decision,
      decided_by: decidedBy || 'user',
      comment: comment || '',
      rejection_reason: rejectionReason || (decision === 'rejected' ? comment || '' : ''),
    }),
  proactiveDashboard: async () => gatewayProxy('GET', '/proactive/dashboard'),
  /** O3.1 event bus: git_push | ci_failed | pr_created | pr_updated */
  proactiveEmitEvent: async (payload) =>
    gatewayProxy('POST', '/proactive/events', payload || {}),
  proactiveCheckOverlap: async (payload) =>
    gatewayProxy('POST', '/proactive/roles/check-overlap', payload || {}),
  proactiveArchiveRole: async (code) =>
    gatewayProxy('PUT', `/proactive/roles/${encodeURIComponent(String(code || ''))}/archive`),
  /** O5.2: archive demo seed roles (frontend_architect / backend_engineer / devops_lead) */
  proactiveArchiveLegacy: async () => gatewayProxy('POST', '/proactive/roles/archive-legacy'),
  proactiveRolePerformance: async (code, days = 7, runProbes = false) =>
    gatewayProxy('GET', `/proactive/roles/${encodeURIComponent(String(code || ''))}/performance`, null, {
      days,
      ...(runProbes ? { run_probes: true } : {}),
    }),
  /** Person Kernel: identity + lessons + soul changelog + craft */
  proactiveRoleGrowth: async (code, limit = 30) =>
    gatewayProxy('GET', `/proactive/roles/${encodeURIComponent(String(code || ''))}/growth`, null, {
      limit,
    }),
  proactiveRoleProposalApprove: async (code, proposalId) =>
    gatewayProxy(
      'POST',
      `/proactive/roles/${encodeURIComponent(String(code || ''))}/proposals/${encodeURIComponent(String(proposalId || ''))}/approve`,
    ),
  proactiveRoleProposalReject: async (code, proposalId) =>
    gatewayProxy(
      'POST',
      `/proactive/roles/${encodeURIComponent(String(code || ''))}/proposals/${encodeURIComponent(String(proposalId || ''))}/reject`,
    ),
  proactiveRoleCost: async (code, days = 7) =>
    gatewayProxy('GET', `/proactive/roles/${encodeURIComponent(String(code || ''))}/cost`, null, { days }),
  proactiveGetMemory: async (code) =>
    gatewayProxy('GET', `/proactive/memory/${encodeURIComponent(String(code || ''))}`),
  proactiveGetMessages: async (agentCode, params) => {
    const code = encodeURIComponent(String(agentCode || ''))
    const q = params && typeof params === 'object' ? { ...params } : null
    if (q && q.round_id != null && !String(q.round_id).trim()) delete q.round_id
    return gatewayProxy('GET', `/proactive/sessions/${code}/messages`, null, q)
  },

  // 飞书扫码注册（免填 App ID / App Secret）
  beginFeishuRegistration: async () => gatewayProxy('POST', '/channels/feishu/registration/begin'),
  pollFeishuRegistration: async (sessionId) => gatewayProxy('GET', `/channels/feishu/registration/${sessionId}/poll`),
  applyFeishuRegistration: async (sessionId, enabled = true) => gatewayProxy('POST', `/channels/feishu/registration/${sessionId}/apply`, { enabled }),

  // 智能体员工 · 飞书 PersonalAgent 绑定（复用 begin/poll，apply 写入岗位）
  applyRoleFeishuRegistration: async (agentCode, sessionId) =>
    gatewayProxy(
      'POST',
      `/proactive/roles/${encodeURIComponent(String(agentCode || ''))}/feishu/registration/${encodeURIComponent(String(sessionId || ''))}/apply`,
    ),
  unbindRoleFeishu: async (agentCode) =>
    gatewayProxy('DELETE', `/proactive/roles/${encodeURIComponent(String(agentCode || ''))}/feishu/binding`),
  getRoleFeishuBinding: async (agentCode) =>
    gatewayProxy('GET', `/proactive/roles/${encodeURIComponent(String(agentCode || ''))}/feishu/binding`),

  // 微信 iLink 扫码绑定（与飞书注册流程一致：begin → poll → apply）
  beginWeixinRegistration: async () => gatewayProxy('POST', '/channels/weixin/registration/begin'),
  pollWeixinRegistration: async (sessionId) => gatewayProxy('GET', `/channels/weixin/registration/${sessionId}/poll`),
  applyWeixinRegistration: async (sessionId, enabled = true) => gatewayProxy('POST', `/channels/weixin/registration/${sessionId}/apply`, { enabled }),

  // 传统技能接口（保持兼容）
  skillsCatalog: () => invoke('skills_list'),
  skillsDetail: (name) => invoke('skills_info', { name }),
  skillsHealth: () => invoke('skills_check'),
  skillsInstallDep: (kind, spec) => invoke('skills_install_dep', { kind, spec }),
  skillsSkillHubCheck: () => invoke('skills_skillhub_check'),
  skillsSkillHubSetup: (cliOnly = true) => invoke('skills_skillhub_setup', { cliOnly }),
  skillsSkillHubSearch: (query, cursor = null) =>
    isTauri
      ? skillsSkillHubSearchDesktop(query, cursor)
      : invoke('skills_skillhub_search', { query, ...(cursor ? { cursor } : {}) }),
  skillsSkillHubInstall: (slug, ownerHandle = null) =>
    isTauri
      ? downloadAndInstallSkillZip(slug, ownerHandle)
      : reloadSkillCatalogAfterMutation(
          invoke('skills_skillhub_install', { slug, ...(ownerHandle ? { ownerHandle } : {}) }),
        ),
  skillsSkillHubSearch: (query, cursor = null) =>
    isTauri
      ? skillsSkillHubSearchDesktop(query, cursor)
      : invoke('skills_skillhub_search', { query, ...(cursor ? { cursor } : {}) }),
  skillsSkillHubInstall: (slug, ownerHandle = null) =>
    isTauri
      ? downloadAndInstallSkillZip(slug, ownerHandle)
      : reloadSkillCatalogAfterMutation(
          invoke('skills_skillhub_install', { slug }),
        ),
  // 与 loadSkills/enableSkill 一致：走 Gateway（删除 skills/custom 下目录）；勿再用 __api/skills_uninstall 扫 ~/.evopanel/skills
  skillsUninstall: (nameOrOpts) => {
    const name =
      typeof nameOrOpts === 'string'
        ? nameOrOpts
        : String(nameOrOpts?.name ?? '').trim()
    const trimmed = String(name).trim()
    if (!trimmed) return Promise.reject(new Error('技能名称不能为空'))
    return reloadSkillCatalogAfterMutation(
      gatewayProxy('DELETE', `/skills/${encodeURIComponent(trimmed)}`),
    )
  },

  // MCP 市场（Glama + 官方 Registry，经 Gateway）
  mcpMarketSearch: (query, cursor = null) => {
    const params = new URLSearchParams()
    if (query) params.set('query', String(query))
    if (cursor) params.set('cursor', String(cursor))
    const qs = params.toString()
    return gatewayProxy('GET', qs ? `/mcp/market/search?${qs}` : '/mcp/market/search')
  },
  mcpMarketInstall: (opts = {}) => {
    const params = new URLSearchParams()
    const map = {
      registry_name: opts.registry_name || opts.registryName,
      glama_namespace: opts.glama_namespace || opts.glamaNamespace,
      glama_slug: opts.glama_slug || opts.glamaSlug,
      slug: opts.slug,
      repository_url: opts.repository_url || opts.repositoryUrl,
    }
    for (const [k, v] of Object.entries(map)) {
      if (v != null && String(v).trim() !== '') params.set(k, String(v).trim())
    }
    const qs = params.toString()
    return gatewayProxy('GET', qs ? `/mcp/market/install?${qs}` : '/mcp/market/install')
  },

  // 实例管理
  instanceList: () => (isTauri
    ? cachedInvoke('instance_list', {}, 10000)
    : Promise.resolve({ activeId: 'local', instances: [{ id: 'local', name: '本机', type: 'local' }] })),
  instanceAdd: (instance) => { if (!isTauri) return Promise.reject(new Error('Web 模式不支持实例管理')); invalidate('instance_list'); return invoke('instance_add', instance) },
  instanceRemove: (id) => { if (!isTauri) return Promise.reject(new Error('Web 模式不支持实例管理')); invalidate('instance_list'); return invoke('instance_remove', { id }) },
  instanceSetActive: (id) => { if (!isTauri) return Promise.resolve({ success: true, id: id || 'local' }); invalidate('instance_list'); _cache.clear(); return invoke('instance_set_active', { id }) },
  instanceHealthCheck: (id) => (isTauri ? invoke('instance_health_check', { id }) : Promise.resolve({ id, online: true })),
  instanceHealthAll: () => (isTauri ? invoke('instance_health_all') : Promise.resolve([{ id: 'local', online: true }])),


  // 前端热更新
  checkFrontendUpdate: () => (isTauri ? invoke('check_frontend_update') : Promise.resolve({ hasUpdate: false })),
  downloadFrontendUpdate: (url, expectedHash) => invoke('download_frontend_update', { url, expectedHash: expectedHash || '' }),
  rollbackFrontendUpdate: () => invoke('rollback_frontend_update'),
  getUpdateStatus: () => invoke('get_update_status'),

  // 数据目录 & 图片存储
  ensureDataDir: () => invoke('assistant_ensure_data_dir'),
  saveImage: (id, data) => invoke('assistant_save_image', { id, data }),
  loadImage: (id) => invoke('assistant_load_image', { id }),
  deleteImage: (id) => invoke('assistant_delete_image', { id }),
  /** 读取系统剪贴板纯文本（桌面端走 Rust arboard，避免 WebView 剪贴板读取提示） */
  readClipboardText: () => invoke('read_clipboard_text'),
  /** 复制图片到系统剪贴板（桌面端走 Rust arboard，最可靠） */
  copyImageToClipboard: (data) => invoke('copy_image_to_clipboard', { data }),
  /** 读取系统剪贴板图片 → data URI（Tauri paste 事件不暴露图片 File，需原生读取） */
  readClipboardImage: () => invoke('read_clipboard_image'),

  // ========== 多智能体协作任务 ==========
  // 任务管理（任务为中心）
  listAllTasks: async (query = null) =>
    gatewayProxy('GET', '/tasks', null, query, { preferGatewayHttp: true }),
  getTask: async (taskId) => gatewayProxy('GET', `/tasks/${taskId}`),
  createTask: async (name, description = '', runMode = 'manual', extras = null) => {
    const body = { name, description, run_mode: runMode }
    if (extras && typeof extras === 'object') {
      if (extras.lifecycle != null) body.lifecycle = extras.lifecycle
      if (extras.status != null) body.status = extras.status
      if (extras.assigned_role != null) body.assigned_role = extras.assigned_role
      if (extras.assigned_to != null) body.assigned_to = extras.assigned_to
      if (extras.raised_by != null) body.raised_by = extras.raised_by
      if (extras.source != null) body.source = extras.source
      if (extras.thread_id != null) body.thread_id = extras.thread_id
      if (extras.model_name != null) body.model_name = extras.model_name
      if (extras.priority != null) body.priority = extras.priority
      if (extras.due_at != null) body.due_at = extras.due_at
      if (extras.workspace_root != null) body.workspace_root = extras.workspace_root
    }
    return gatewayProxy('POST', '/tasks', body)
  },
  /** @deprecated 个人事项请用 createUserItem；保留兼容旧 inbox 路径 */
  createInboxTodo: async (name, description = '', extras = null) => {
    const body = {
      title: name,
      notes: description || '',
      source: 'user',
    }
    if (extras && typeof extras === 'object') {
      if (extras.assigned_to != null) body.assignee_intent = extras.assigned_to
      if (extras.assigned_role != null) body.assignee_label = extras.assigned_role
      if (extras.priority != null) {
        const p = String(extras.priority).toUpperCase()
        body.priority = p === 'P0' ? 'urgent' : p === 'P1' ? 'high' : p === 'P3' ? 'low' : 'normal'
      }
      if (extras.due_at != null) body.due_at = extras.due_at
      if (extras.tags != null) body.tags = extras.tags
    }
    return gatewayProxy('POST', '/items', body)
  },
  // ========== 用户事项（个人进度账本，≠ 可执行 Task）==========
  listUserItems: async (query = null) => gatewayProxy('GET', '/items', null, query),
  getUserItem: async (itemId) => gatewayProxy('GET', `/items/${encodeURIComponent(String(itemId || ''))}`),
  createUserItem: async (payload) => gatewayProxy('POST', '/items', payload || {}),
  updateUserItem: async (itemId, patch) =>
    gatewayProxy('PATCH', `/items/${encodeURIComponent(String(itemId || ''))}`, patch || {}),
  deleteUserItem: async (itemId) =>
    gatewayProxy('DELETE', `/items/${encodeURIComponent(String(itemId || ''))}`),
  dispatchUserItem: async (itemId, payload) =>
    gatewayProxy('POST', `/items/${encodeURIComponent(String(itemId || ''))}/dispatch`, payload || {}),
  migrateInboxToItems: async (dryRun = false) =>
    gatewayProxy('POST', '/items/migrate-inbox', null, { dry_run: dryRun ? 'true' : 'false' }),
  updateTask: async (taskId, data) => gatewayProxy('PUT', `/tasks/${taskId}`, data),
  /** 校验态状态机切换（reviewed→completed/executing/failed 等） */
  setTaskState: async (taskId, status, comment = '', summary = '', extras = {}) =>
    gatewayProxy('POST', `/tasks/${encodeURIComponent(taskId)}/state`, {
      status,
      ...(comment ? { comment } : {}),
      ...(summary ? { summary } : {}),
      ...(Array.isArray(extras.outputs) ? { outputs: extras.outputs } : {}),
      ...(Array.isArray(extras.handlers) ? { handlers: extras.handlers } : {}),
    }),
  deleteTask: async (taskId) => gatewayProxy('DELETE', `/tasks/${taskId}`),

  // 任务执行控制
  startTaskPlanning: async (taskId) => gatewayProxy('POST', `/tasks/${taskId}/start`),
  stopTaskExecution: async (taskId) => gatewayProxy('POST', `/tasks/${taskId}/stop`),
  batchStopTasks: async ({ taskIds = null, scope = null } = {}) =>
    gatewayProxy('POST', '/tasks/batch/stop', {
      ...(Array.isArray(taskIds) && taskIds.length ? { task_ids: taskIds } : {}),
      ...(scope ? { scope } : {}),
    }),
  getTaskQueueStatus: async () => gatewayProxy('GET', '/tasks/queue/status'),
  cancelTask: async (taskId) => gatewayProxy('POST', `/tasks/${taskId}/cancel`),
  pauseTask: async (taskId) => gatewayProxy('POST', `/tasks/${taskId}/stop`),
  resumeTask: async (taskId) => gatewayProxy('POST', `/tasks/${taskId}/resume`),
  restartTask: async (taskId) => gatewayProxy('POST', `/tasks/${taskId}/restart`),

  // 任务执行历史
  getExecutionHistory: async (taskId) => gatewayProxy('GET', `/tasks/${taskId}/execution-history`),
  getExecutionOutput: async (taskId, executionId, options = {}) => {
    const params = new URLSearchParams()
    if (options.limit) params.append('limit', options.limit)
    const query = params.toString()
    return gatewayProxy('GET', `/tasks/${taskId}/execution-history/${executionId}/output${query ? '?' + query : ''}`)
  },

  // 子任务管理
  addSubtask: async (taskId, name, description = '', dependencies = []) =>
    gatewayProxy('POST', `/tasks/${taskId}/subtasks`, { name, description, dependencies }),
  listSubtasks: async (taskId) => gatewayProxy('GET', `/tasks/${taskId}/subtasks`),
  getSubtask: async (taskId, subtaskId) => gatewayProxy('GET', `/tasks/${taskId}/subtasks/${subtaskId}`),
  /** 后端 `_build_subtask_enriched_prompt` 的真实输出（任务中心子任务详情展示） */
  getSubtaskEnrichedPrompt: async (taskId, subtaskId) =>
    gatewayProxy(
      'GET',
      `/tasks/${encodeURIComponent(String(taskId || ''))}/subtasks/${encodeURIComponent(String(subtaskId || ''))}/enriched-prompt`,
    ),
  updateSubtask: async (taskId, subtaskId, data) => gatewayProxy('PUT', `/tasks/${taskId}/subtasks/${subtaskId}`, data),
  deleteSubtask: async (taskId, subtaskId) => gatewayProxy('DELETE', `/tasks/${taskId}/subtasks/${subtaskId}`),
  assignSubtask: async (taskId, subtaskId, agentId) => gatewayProxy('POST', `/tasks/${taskId}/subtasks/${subtaskId}/assign`, { agent_id: agentId }),

  // 任务详情
  getTaskFacts: async (taskId) => gatewayProxy('GET', `/task-detail/tasks/${taskId}`),
  getTaskMemory: async (taskId) => gatewayProxy('GET', `/task-detail/tasks/${taskId}`),
  getSubtaskMemory: async (taskId, subtaskId) => gatewayProxy('GET', `/task-detail/subtasks/${subtaskId}`),
  searchTaskFacts: async (taskId, keyword) => gatewayProxy('GET', `/task-detail/tasks/${taskId}/search`, null, { keyword }),
  getTaskRuntime: async (taskId) => gatewayProxy('GET', `/tasks/${taskId}/runtime`),
  getTaskObservability: async (taskId, query = {}) => {
    const qs = new URLSearchParams()
    if (query.since_hours != null) qs.set('since_hours', String(query.since_hours))
    if (query.sinceHours != null) qs.set('since_hours', String(query.sinceHours))
    const q = qs.toString()
    return gatewayProxy('GET', `/tasks/${encodeURIComponent(String(taskId || ''))}/observability${q ? `?${q}` : ''}`)
  },
  getSubtaskConversationHistory: async (taskId, subtaskId, limit = 600, opts = {}) => {
    const { fetchSubtaskConversationHistory } = await import('./subtask-conversation-history.js')
    const options = opts && typeof opts === 'object' ? opts : {}
    return fetchSubtaskConversationHistory({
      mainTaskId: taskId,
      subtaskId,
      leadThreadId: options.leadThreadId,
      storedSubtaskThreadId: options.storedSubtaskThreadId,
      subtaskSnapshot: options.subtaskSnapshot,
      limit,
    })
  },
  continueSubtaskSession: async (taskId, subtaskId, message, opts = {}) =>
    gatewayProxy(
      'POST',
      `/tasks/${encodeURIComponent(String(taskId || ''))}/subtasks/${encodeURIComponent(String(subtaskId || ''))}/continue-session`,
      {
        message: String(message || '').trim(),
        keep_session_open: opts.keepSessionOpen !== false,
        wait_for_completion: opts.waitForCompletion !== false,
      },
    ),

  // ========== 自动化 / Automation（Web dev-api 读写 TOML；桌面端走 Gateway REST，与 Rust invoke 对齐）==========
  automationList: () =>
    gatewayProxy('GET', '/automation/tasks', null, null, { preferGatewayHttp: true }),
  automationFeishuPushDefault: () =>
    gatewayProxy('GET', '/automation/feishu-push-default', null, null, { preferGatewayHttp: true }),
  automationGet: (id) => gatewayProxy('GET', `/automation/tasks/${encodeURIComponent(String(id || ''))}`),
  /** 与 Gateway 调度器同一套 cron 解析：摘要 + 最近运行时间 */
  automationSchedulePreview: (params) => gatewayProxy('POST', '/automation/schedule/preview', params || {}),
  automationCreate: (params) => {
    invalidate('automation_list')
    return gatewayProxy('POST', '/automation/tasks', params)
  },
  automationUpdate: (params) => {
    invalidate('automation_list')
    const id = params?.id
    return gatewayProxy('PUT', `/automation/tasks/${encodeURIComponent(String(id || ''))}`, params)
  },
  automationDelete: (id) => {
    invalidate('automation_list')
    return gatewayProxy('DELETE', `/automation/tasks/${encodeURIComponent(String(id || ''))}`)
  },
  automationRun: (id, opts = {}) => {
    const asyncRun = !!(opts && (opts.run_async || opts.async))
    const query = asyncRun ? { run_async: 'true' } : null
    return gatewayProxy('POST', `/automation/tasks/${encodeURIComponent(String(id || ''))}/run`, null, query)
  },
  automationHistory: (id, limit = 50) =>
    gatewayProxy(
      'GET',
      `/automation/tasks/${encodeURIComponent(String(id || ''))}/history`,
      null,
      { limit: String(limit) },
      { preferGatewayHttp: true },
    ),
  /** Cross-task recent runs (one SQL) — prefer over N× automationHistory for runs tab */
  automationRecentRuns: (limit = 200) =>
    gatewayProxy('GET', '/automation/runs', null, { limit: String(limit) }, { preferGatewayHttp: true }),
  automationStart: () => gatewayProxy('POST', '/automation/scheduler/start'),
  automationStop: () => gatewayProxy('POST', '/automation/scheduler/stop'),
  automationSchedulerStatus: () =>
    gatewayProxy('GET', '/automation/scheduler/status', null, null, { preferGatewayHttp: true }),
  automationPause: (id) => {
    invalidate('automation_list')
    return gatewayProxy('POST', `/automation/tasks/${encodeURIComponent(String(id || ''))}/pause`)
  },
  automationResume: (id) => {
    invalidate('automation_list')
    return gatewayProxy('POST', `/automation/tasks/${encodeURIComponent(String(id || ''))}/resume`)
  },

  // ========== 应用中心 / Apps ==========
  listApps: async (query = null) => {
    const data = await gatewayProxy('GET', '/apps', null, query, { preferGatewayHttp: true })
    return Array.isArray(data) ? data : (data?.items || [])
  },
  getApp: async (appId) => gatewayProxy('GET', `/apps/${encodeURIComponent(String(appId || ''))}`),
  createApp: async (payload) => gatewayProxy('POST', '/apps', payload),
  updateApp: async (appId, payload) =>
    gatewayProxy('PUT', `/apps/${encodeURIComponent(String(appId || ''))}`, payload),
  deleteApp: async (appId) => gatewayProxy('DELETE', `/apps/${encodeURIComponent(String(appId || ''))}`),
  publishApp: async (appId) => gatewayProxy('POST', `/apps/${encodeURIComponent(String(appId || ''))}/publish`),
  listAppKeys: async (appId) => {
    const data = await gatewayProxy('GET', `/apps/${encodeURIComponent(String(appId || ''))}/keys`)
    return {
      keys: Array.isArray(data?.keys) ? data.keys : [],
      count: Number(data?.count) || 0,
    }
  },
  createAppKey: async (appId, payload = {}) =>
    gatewayProxy('POST', `/apps/${encodeURIComponent(String(appId || ''))}/keys`, {
      name: payload.name || 'default',
    }),
  revokeAppKey: async (appId, tokenHash) =>
    gatewayProxy(
      'DELETE',
      `/apps/${encodeURIComponent(String(appId || ''))}/keys/${encodeURIComponent(String(tokenHash || ''))}`,
    ),
  runApp: async (appId, payload) =>
    gatewayProxy('POST', `/apps/${encodeURIComponent(String(appId || ''))}/run`, payload),
  listAppRuns: async (appId, limit = 20, opts = {}) => {
    const page = Math.max(1, Number(opts.page) || 1)
    const pageSize = Math.max(1, Math.min(100, Number(opts.pageSize ?? limit) || 20))
    const data = await gatewayProxy(
      'GET',
      `/apps/${encodeURIComponent(String(appId || ''))}/runs`,
      null,
      { page: String(page), page_size: String(pageSize), limit: String(pageSize) },
    )
    if (Array.isArray(data)) {
      return {
        items: data,
        total: data.length,
        page,
        page_size: pageSize,
        has_more: false,
      }
    }
    return {
      items: Array.isArray(data?.items) ? data.items : [],
      total: Number(data?.total) || 0,
      page: Number(data?.page) || page,
      page_size: Number(data?.page_size) || pageSize,
      has_more: !!data?.has_more,
    }
  },
  listAppRevisions: async (appId, limit = 50) =>
    gatewayProxy('GET', `/apps/${encodeURIComponent(String(appId || ''))}/revisions`, null, {
      limit: String(limit),
    }),
  getAppRevision: async (appId, version) =>
    gatewayProxy(
      'GET',
      `/apps/${encodeURIComponent(String(appId || ''))}/revisions/${encodeURIComponent(String(version ?? ''))}`,
    ),
  restoreAppRevision: async (appId, version) =>
    gatewayProxy(
      'POST',
      `/apps/${encodeURIComponent(String(appId || ''))}/revisions/${encodeURIComponent(String(version ?? ''))}/restore`,
    ),
  getAppRunStatus: async (runId) =>
    gatewayProxy('GET', `/apps/runs/${encodeURIComponent(String(runId || ''))}`),
  cancelAppRun: async (runId, reason = 'User cancelled') =>
    gatewayProxy('POST', `/apps/runs/${encodeURIComponent(String(runId || ''))}/cancel`, null, { reason }),
  pauseAppRun: async (runId, reason = 'User paused') =>
    gatewayProxy('POST', `/apps/runs/${encodeURIComponent(String(runId || ''))}/pause`, null, { reason }),
  resumeAppRun: async (runId) =>
    gatewayProxy('POST', `/apps/runs/${encodeURIComponent(String(runId || ''))}/resume`),
  saveTaskAsApp: async (taskId, payload = {}) =>
    gatewayProxy('POST', `/tasks/${encodeURIComponent(String(taskId || ''))}/save-as-app`, payload),
  generateApp: async (payload) => gatewayProxy('POST', '/apps/generate', payload),

  /** 会话调试 Agent trace（默认开启；EVOFLOW_DEBUG_TRACE_UI=0 可关闭） */
  agentTraceRecentThreads: (limit = 80, options = null) =>
    gatewayProxy('GET', '/debug/agent-trace/recent-threads', null, { limit: String(limit) }, options),
  agentTraceData: (threadId, options = null) =>
    gatewayProxy(
      'GET',
      '/debug/agent-trace/data',
      null,
      { thread_id: String(threadId || '').trim() },
      { timeoutMs: 120000, ...(options || {}) },
    ),

  /** SQLite 观测（Gateway /api/observability） */
  observabilityStatus: (options = null) => gatewayProxy('GET', '/observability/status', null, null, options),
  observabilityOverview: (query = {}) => {
    const out = {}
    for (const [k, v] of Object.entries(query)) {
      if (v != null && String(v).trim() !== '') out[k] = String(v)
    }
    return gatewayProxy('GET', '/observability/overview', null, out)
  },
  observabilityDashboard: (query = {}, options = null) => {
    const q = { since_hours: '168', agent_filter: 'all', ...query }
    const out = {}
    for (const [k, v] of Object.entries(q)) {
      if (v != null && String(v).trim() !== '') out[k] = String(v)
    }
    return gatewayProxy('GET', '/observability/dashboard', null, out, {
      timeoutMs: 30000,
      ...(options || {}),
    })
  },
  observabilityGatewayRequestSummary: (query = {}) => {
    const q = { since_hours: '24', ...query }
    const out = {}
    for (const [k, v] of Object.entries(q)) {
      if (v != null && String(v).trim() !== '') out[k] = String(v)
    }
    return gatewayProxy('GET', '/observability/gateway-requests/summary', null, out)
  },
  observabilityGatewayRequests: (query = {}) => {
    const q = { page: '1', page_size: '20', ...query }
    const out = {}
    for (const [k, v] of Object.entries(q)) {
      if (v != null && String(v).trim() !== '') out[k] = String(v)
    }
    return gatewayProxy('GET', '/observability/gateway-requests', null, out)
  },
  observabilityGatewayHotspots: (query = {}) => {
    const q = { since_hours: '1', top_n: '15', ...query }
    const out = {}
    for (const [k, v] of Object.entries(q)) {
      if (v != null && String(v).trim() !== '') out[k] = String(v)
    }
    return gatewayProxy('GET', '/observability/gateway-requests/hotspots', null, out)
  },
  observabilityTools: (query = {}) => {
    const q = { page: '1', page_size: '20', ...query }
    const out = {}
    for (const [k, v] of Object.entries(q)) {
      if (v != null && String(v).trim() !== '') out[k] = String(v)
    }
    return gatewayProxy('GET', '/observability/tools', null, out)
  },
  observabilityModels: (query = {}) => {
    const q = { page: '1', page_size: '20', ...query }
    const out = {}
    for (const [k, v] of Object.entries(q)) {
      if (v != null && String(v).trim() !== '') out[k] = String(v)
    }
    return gatewayProxy('GET', '/observability/models', null, out)
  },
  observabilityModelDetail: (rowId, options = null) =>
    gatewayProxy('GET', `/observability/models/${encodeURIComponent(String(rowId))}`, null, null, options),
  observabilityThreads: (query = {}, options = null) =>
    gatewayProxy('GET', '/observability/threads', null, query, options),
  observabilityThreadTimeline: (threadId, limit = 200) =>
    gatewayProxy('GET', `/observability/threads/${encodeURIComponent(String(threadId || '').trim())}/timeline`, null, {
      limit: String(limit),
    }),
  observabilityInsights: (query = {}) => {
    const q = { limit: '10', ...query }
    const out = {}
    for (const [k, v] of Object.entries(q)) {
      if (v != null && String(v).trim() !== '') out[k] = String(v)
    }
    return gatewayProxy('GET', '/observability/insights', null, out)
  },
  observabilityErrorsSummary: (query = {}) => {
    const q = { since_hours: '168', ...query }
    return gatewayProxy('GET', '/observability/errors/summary', null, q)
  },
  observabilityTrends: (query = {}) => {
    const q = { days: '7', ...query }
    return gatewayProxy('GET', '/observability/trends', null, q)
  },
  observabilityReport: (query = {}) => {
    const q = { since_hours: '168', limit: '10', ...query }
    return gatewayProxy('GET', '/observability/report', null, q)
  },
  observabilityEvalSnapshot: (query = {}) => {
    const q = { since_hours: '168', limit: '10', sample_k: '5', ...query }
    return gatewayProxy('GET', '/observability/eval-snapshot', null, q)
  },
  observabilityWaterfall: (threadId) =>
    gatewayProxy('GET', `/observability/waterfall/${encodeURIComponent(String(threadId || '').trim())}`),
  observabilityWaterfallSummary: (query = {}) => {
    const q = { since_hours: '168', sample_limit: '20', ...query }
    return gatewayProxy('GET', '/observability/waterfall-summary', null, q)
  },
  observabilityAgentsSummary: (query = {}) => gatewayProxy('GET', '/observability/agents/summary', null, query),
  observabilityModelsSummary: (query = {}, options = null) =>
    gatewayProxy('GET', '/observability/models/summary', null, query, options),
  observabilityProvidersSummary: (query = {}) => gatewayProxy('GET', '/observability/providers/summary', null, query),
  observabilityToolsSummary: (query = {}) => gatewayProxy('GET', '/observability/tools/summary', null, query),
  observabilityGatewayRoutesSummary: (query = {}) =>
    gatewayProxy('GET', '/observability/gateway-requests/by-route', null, query),
  observabilityThreadsSummary: (query = {}) => gatewayProxy('GET', '/observability/threads/summary', null, query),
  observabilityAnalyticsSummary: (query = {}) => gatewayProxy('GET', '/observability/analytics/summary', null, query),
  observabilityRuntimeStatus: (options = null) =>
    gatewayProxy('GET', '/observability/runtime-status', null, null, {
      timeoutMs: 15000,
      ...(options || {}),
    }),
  observabilityMcpStatus: () => gatewayProxy('GET', '/observability/mcp-status'),

  /** Eval Center (/api/eval) */
  evalGet: (path, query = null) =>
    gatewayProxy('GET', `/eval${path.startsWith('/') ? path : `/${path}`}`, null, query),
  evalPost: (path, body = null) =>
    gatewayProxy('POST', `/eval${path.startsWith('/') ? path : `/${path}`}`, body),
  evalDashboardSummary: (days = 7) => gatewayProxy('GET', '/eval/dashboard/summary', null, { days }),
  evalStartRun: (body) => gatewayProxy('POST', '/eval/run', body || { name: '一键评测', mode: 'smoke' }),
  evalRunProgress: (runId) =>
    gatewayProxy('GET', `/eval/run/${encodeURIComponent(String(runId || ''))}/progress`),
  evalCases: (query = {}) => gatewayProxy('GET', '/eval/cases', null, query),
  evalRuns: (query = {}) => gatewayProxy('GET', '/eval/runs', null, query),

  getMediaCredentials: () => gatewayProxy('GET', '/settings/media'),
  patchMediaCredentials: (credentials) =>
    gatewayProxy('PATCH', '/settings/media', { credentials: credentials || {} }),

  /** Plan Bundle（厂商 Agent/Token Plan 全家桶） */
  listPlanCatalog: () => gatewayProxy('GET', '/plans/catalog'),
  listPlanBindings: (includeDisabled = true) =>
    gatewayProxy('GET', '/plans/bindings', null, { include_disabled: includeDisabled }),
  createPlanBinding: (body) => gatewayProxy('POST', '/plans/bindings', body || {}),
  patchPlanBinding: (id, body) =>
    gatewayProxy('PATCH', `/plans/bindings/${encodeURIComponent(String(id || ''))}`, body || {}),
  deletePlanBinding: (id) =>
    gatewayProxy('DELETE', `/plans/bindings/${encodeURIComponent(String(id || ''))}`),
  resolvePlanCapability: (capability, query = {}) =>
    gatewayProxy('GET', '/plans/resolve', null, { capability, ...query }),
  /** 一键 / 分项验证 Agent Plan 能力是否可用 */
  verifyPlanBinding: (id, body = {}) =>
    gatewayProxy(
      'POST',
      `/plans/bindings/${encodeURIComponent(String(id || ''))}/verify`,
      body || {},
    ),
}
