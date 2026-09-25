/**
 * 服务健康状态机 + 30s 轮询 + 点击重试
 *
 * 目的：客户端常驻一个"服务可用状态"指示器。
 *
 * 后端已提供 /health/ready（Codex-style handshake: core routers mounted）、
 * /health/liveness（进程存活）、/health（综合健康度）。
 *
 * 三档状态映射：
 *   - HEALTHY     → /health/ready 200 且 /health.status != 'unhealthy'/'degraded'
 *   - DEGRADED    → /health 报告 'degraded'（事件循环过载等，仍能服务但有抖动）
 *   - UNAVAILABLE → /health/ready 503 / 网络错误 / 探针失败连续 ≥2 次（避免瞬态误判）
 *
 * 与现有 app-state.js (desktop sidecar guardian) 协同：
 *   - 桌面端：Tauri sidecar 守护由 app-state 负责；本模块只负责 UI 呈现，不做重启
 *   - Web 端：本模块是唯一的服务可用性来源
 *
 * 关键 API：
 *   startServiceHealthPoll() — 启动 30s 轮询 + 立即探针
 *   stopServiceHealthPoll()  — 停止轮询（卸载或 keep-alive）
 *   onServiceHealthChange(fn) — 订阅状态变化
 *   triggerServiceHealthCheck({ manual: true }) — 用户点击徽章时手动重试
 *   getServiceHealthState() — 当前状态快照（供初始化时使用）
 */

export const ServiceHealthState = Object.freeze({
  /** 未知：探针尚未执行或被禁用 */
  UNKNOWN: 'unknown',
  /** 健康：核心 API 可用，未报告降级/不健康 */
  HEALTHY: 'healthy',
  /** 降级：进程存活但报告 degraded（如事件循环过载） */
  DEGRADED: 'degraded',
  /** 不可用：/health/ready 503 或网络错误，且连续 ≥2 次失败 */
  UNAVAILABLE: 'unavailable',
})

const POLL_INTERVAL_MS = 30_000
const FAIL_STREAK_THRESHOLD = 1  // 单次失败即标记 UNAVAILABLE（用户诉求：早知道）
const RECOVERY_STREAK_THRESHOLD = 1
const PROBE_TIMEOUT_MS = 4_000

/**
 * 可注入的探针集合（测试用）。
 * 默认通过 tauri-api.js 调用 /health/ready、/health；测试可整体替换为 mock。
 * @typedef {{
 *   checkReady: () => Promise<boolean>,
 *   fetchHealth: () => Promise<{ ok: boolean, status: string, reason?: string }>,
 * }} HealthProbe
 */

/** @type {HealthProbe} */
let _probe = null

async function _defaultCheckReady() {
  const mod = await import('./tauri-api.js')
  return mod.checkBackendReady()
}

/**
 * 直接 GET /health/ready 并解析 body，识别 phase=initializing / extended_routers=false
 * 这类"HTTP 200 但还没真正准备好"的伪 ready 状态。
 *
 * 服务健康判定只信这个函数，不信 tauri-api 的 sticky 缓存（sticky 是为了避免抖动，
 * 但对初次判定应当严格）。
 *
 * @returns {Promise<{httpOk: boolean, phase: string|null, extended: boolean|null, fullyReady: boolean}>}
 */
async function _probeReadyDetail() {
  try {
    // Relative URLs break in Tauri desktop builds (page origin is tauri://localhost,
    // not the gateway) — always probe against the resolved gateway base.
    const { getGatewayBaseUrl } = await import('./api-client.js')
    const base = await getGatewayBaseUrl()
    const resp = await fetch(`${base}/health/ready`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (!resp.ok) return { httpOk: false, phase: null, extended: null, fullyReady: false }
    const body = await resp.json().catch(() => null)
    if (!body || typeof body !== 'object') return { httpOk: true, phase: null, extended: null, fullyReady: false }
    const status = String(body.status || '').toLowerCase()
    const phase = body.phase == null ? null : String(body.phase)
    const extended = body.extended_routers == null ? null : !!body.extended_routers
    const phaseReady = !phase || phase === 'ready' || phase === 'completed' || phase === 'complete'
    // status === 'ready' 且 phase 已就绪 且 extended_routers 已被注册（false 视为未就绪）
    const fullyReady = status === 'ready' && phaseReady && extended !== false
    return { httpOk: true, phase, extended, fullyReady }
  } catch {
    return { httpOk: false, phase: null, extended: null, fullyReady: false }
  }
}

async function _defaultFetchHealth() {
  try {
    const { getGatewayBaseUrl } = await import('./api-client.js')
    const base = await getGatewayBaseUrl()
    const resp = await fetch(`${base}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    const body = await resp.json().catch(() => ({}))
    return { ok: resp.ok, status: String(body?.status || ''), reason: body?.reason }
  } catch {
    return { ok: false, status: '' }
  }
}

function _ensureDefaultProbe() {
  if (_probe) return _probe
  _probe = {
    checkReady: _defaultCheckReady,
    fetchHealth: _defaultFetchHealth,
  }
  return _probe
}

/**
 * 注入自定义探针（测试 / 跨环境）。
 * @param {HealthProbe|null} probe
 */
export function __setHealthProbe(probe) {
  _probe = probe
}

/**
 * 注入 /health/ready 解析结果（仅供测试）。
 * _probeOnce 优先调用此函数；为空则回退到内置 _probeReadyDetail。
 * @param {(() => Promise<{httpOk: boolean, phase: string|null, extended: boolean|null, fullyReady: boolean}>)|null} fn
 */
export function __setReadyDetailProbe(fn) {
  _readyDetailProbe = fn
}

let _readyDetailProbe = null

let _state = ServiceHealthState.UNKNOWN
let _lastCheckedAt = 0
let _failStreak = 0
let _okStreak = 0
let _lastError = null
let _pollTimer = null
let _probeInFlight = false
let _listeners = new Set()
let _started = false

function _emit() {
  const snapshot = getServiceHealthState()
  _listeners.forEach((fn) => {
    try { fn(snapshot) } catch (e) {
      try { console.error('[service-health] listener error:', e) } catch {}
    }
  })
}

function _setState(next, { error = null } = {}) {
  const prev = _state
  if (prev === next && _lastError === error) return
  _state = next
  _lastError = error
  if (next === ServiceHealthState.HEALTHY || next === ServiceHealthState.DEGRADED) {
    _failStreak = 0
  }
  if (next === ServiceHealthState.UNAVAILABLE) {
    _okStreak = 0
  }
  if (prev !== next) _emit()
  else if (error) _emit()
}

/**
 * 综合判断健康度。
 * - 通过 /health/ready: HEALTHY
 * - /health/ready 失败时尝试 GET /health：返回 'degraded' → DEGRADED；'unhealthy' → UNAVAILABLE
 * @returns {Promise<{state: string, error: string|null}>}
 */
async function _probeOnce() {
  // 1) 主探针：直接 GET /health/ready 并解析 body（识别 phase=initializing / extended=false 伪 ready）
  const ready = _readyDetailProbe
    ? await _readyDetailProbe()
    : await _probeReadyDetail()

  // 网络层不可达 → UNAVAILABLE（让 streak 决定首次主动显示）
  if (!ready.httpOk) {
    return { state: ServiceHealthState.UNKNOWN, error: 'http request failed' }
  }

  // HTTP 200 + 完全 ready → HEALTHY
  if (ready.fullyReady) {
    return { state: ServiceHealthState.HEALTHY, error: null }
  }

  // HTTP 200 但 phase 还在 initializing 或 extended=false：
  // 这就是用户场景："服务在跑但还没真正可用"，应明确为 DEGRADED + 友好文案，banner 立刻亮。
  // 不走 streak 阈值（用户已经点击重试或刚发消息失败）— 立即告知。
  if (ready.phase === 'initializing' || ready.extended === false) {
    return {
      state: ServiceHealthState.DEGRADED,
      error: `phase=${ready.phase || 'unknown'} extended=${ready.extended === null ? '?' : ready.extended}`,
    }
  }

  // HTTP 200，phase/extended 都为 null（理论上的边界情况）→ 模糊信号交给 streak
  return { state: ServiceHealthState.UNKNOWN, error: 'gateway not ready' }
}

/**
 * 主动标记当前服务不可用（由 ws-client 在捕获到 SERVICE_UNREACHABLE 错误时调用）。
 *
 * 作用：跳过 fail streak 阈值，立即进入 UNAVAILABLE 状态，让 banner 立刻亮起来。
 * 当用户点重试时仍走 triggerServiceHealthCheck({ manual: true }) 走正常验证路径。
 */
export function markServiceUnreachable(error = null) {
  _failStreak = 0
  _okStreak = 0
  _setState(ServiceHealthState.UNAVAILABLE, { error: error ? String(error) : 'service_unreachable_event' })
}

/**
 * @param {{ manual?: boolean }} [opts]
 * @returns {Promise<void>}
 */
export async function triggerServiceHealthCheck(opts = {}) {
  if (_probeInFlight) return
  _probeInFlight = true
  try {
    const { state, error } = await _probeOnce()
    _lastCheckedAt = Date.now()
    try {
      console.info('[service-health] probe →', { state, error, manual: !!opts.manual })
    } catch { /* ignore */ }
    if (state === ServiceHealthState.HEALTHY) {
      _okStreak += 1
      _failStreak = 0
      if (_okStreak >= RECOVERY_STREAK_THRESHOLD) {
        _setState(ServiceHealthState.HEALTHY, { error: null })
      } else {
        _setState(_state, { error: null })
      }
    } else if (state === ServiceHealthState.DEGRADED) {
      _okStreak += 1
      _failStreak = 0
      _setState(ServiceHealthState.DEGRADED, { error })
    } else if (state === ServiceHealthState.UNAVAILABLE) {
      // 来自后端的明确 unhealthy 报告 → 立即切换，不再等 streak
      _failStreak += 1
      _okStreak = 0
      _setState(ServiceHealthState.UNAVAILABLE, { error })
    } else {
      // UNKNOWN（模糊信号：/health/ready 失败 + /health 未明确报告 degraded/unhealthy）
      // 累计 fail streak 避免瞬态误判；手动重试时立即生效
      _failStreak += 1
      _okStreak = 0
      if (_failStreak >= FAIL_STREAK_THRESHOLD || opts.manual) {
        _setState(ServiceHealthState.UNAVAILABLE, { error })
      }
    }
  } catch (e) {
    _failStreak += 1
    _okStreak = 0
    if (_failStreak >= FAIL_STREAK_THRESHOLD) {
      _setState(ServiceHealthState.UNAVAILABLE, { error: String(e?.message || e) })
    }
  } finally {
    _probeInFlight = false
  }
}

/** 启动轮询。多次调用幂等。 */
export function startServiceHealthPoll() {
  if (_started) return
  _started = true
  void triggerServiceHealthCheck()
  _pollTimer = setInterval(() => {
    void triggerServiceHealthCheck()
  }, POLL_INTERVAL_MS)
}

/** 停止轮询（保留最近一次状态，监听器仍可读取）。 */
export function stopServiceHealthPoll() {
  if (_pollTimer) {
    clearInterval(_pollTimer)
    _pollTimer = null
  }
  _started = false
}

/**
 * 订阅状态变化。
 * @param {(snap: ServiceHealthSnapshot) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onServiceHealthChange(fn) {
  if (typeof fn !== 'function') return () => {}
  _listeners.add(fn)
  // 立即推一次当前快照，避免 UI 订阅时显示空白
  try { fn(getServiceHealthState()) } catch {}
  return () => { _listeners.delete(fn) }
}

/**
 * @typedef {{
 *   state: string,
 *   lastCheckedAt: number,
 *   failStreak: number,
 *   lastError: string|null,
 *   isPolling: boolean,
 * }} ServiceHealthSnapshot
 */

/** @returns {ServiceHealthSnapshot} */
export function getServiceHealthState() {
  return {
    state: _state,
    lastCheckedAt: _lastCheckedAt,
    failStreak: _failStreak,
    lastError: _lastError,
    isPolling: _started,
  }
}

/** 仅供测试：重置内部状态（生产代码不要调用）。 */
export function __resetServiceHealthForTest() {
  stopServiceHealthPoll()
  _state = ServiceHealthState.UNKNOWN
  _lastCheckedAt = 0
  _failStreak = 0
  _okStreak = 0
  _lastError = null
  _probeInFlight = false
  _listeners = new Set()
  _started = false
  __setHealthProbe(null)
  _readyDetailProbe = null
}

export const SERVICE_HEALTH_POLL_INTERVAL_MS = POLL_INTERVAL_MS
export const SERVICE_HEALTH_FAIL_STREAK_THRESHOLD = FAIL_STREAK_THRESHOLD