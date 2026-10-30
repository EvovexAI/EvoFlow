/**
 * 全局应用状态
 * 管理 Gateway 运行状态与轻量守护（桌面端 sidecar 自动恢复）
 */
import { api, checkBackendHealth, checkBackendReady } from './tauri-api.js'
import { UNHEALTHY_THRESHOLD } from './gateway-guardian-policy.js'

const isTauri = !!window.__TAURI_INTERNALS__

let _evoflowReady = true
let _gatewayRunning = true
let _platform = ''

function _initRuntimePlatform() {
  if (_platform) return _platform
  if (typeof navigator === 'undefined') {
    _platform = 'unknown'
    return _platform
  }
  const raw = String(
    navigator.userAgentData?.platform || navigator.platform || '',
  ).toLowerCase()
  if (raw.includes('win')) _platform = 'win32'
  else if (raw.includes('mac')) _platform = 'macos'
  else if (raw.includes('linux')) _platform = 'linux'
  else _platform = raw || 'unknown'
  return _platform
}
let _deployMode = 'local'
let _inDocker = false
let _dockerAvailable = false
let _listeners = []
let _gwListeners = []
let _isUpgrading = false
let _guardianRestartListeners = []

let _userStopped = false
let _autoRestartCount = 0
let _lastRestartTime = 0
let _runningSince = null
let _consecutiveFailures = 0
let _pollTimer = null
let _restartInFlight = false
let _execHoldFailureSince = null
let _deferToastShown = false
let _externalDownToastShown = false
let _externalGatewayCached = null
let _lgRestartInFlight = false
let _lgConsecutiveDown = 0
let _lastLgRestartTime = 0

const GATEWAY_POLL_MS = 15000
const LG_DOWN_RESTART_THRESHOLD = 2
const LG_RESTART_COOLDOWN_MS = 60_000

/** Operator-owned Gateway (EVOFLOW_GATEWAY_URL) — reload_gateway is a no-op. */
async function _isExternalGateway() {
  if (_externalGatewayCached != null) return _externalGatewayCached
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const info = await invoke('get_profile_info')
    if (info && typeof info.externalGateway === 'boolean') {
      _externalGatewayCached = !!info.externalGateway
      return _externalGatewayCached
    }
    // Soft detect (pre-rebuild): resolved port ≠ profile hash port → external.
    const resolved = String(info?.resolvedBaseUrl || '')
    const expected = Number(info?.expectedPort)
    try {
      const u = new URL(resolved)
      const rp = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
      if (rp > 0 && Number.isFinite(expected) && expected > 0 && rp !== expected) {
        _externalGatewayCached = true
        return true
      }
    } catch {
      /* ignore */
    }
    _externalGatewayCached = false
  } catch {
    _externalGatewayCached = false
  }
  return _externalGatewayCached
}

/** evoflow 是否就绪（CLI 已安装 + 配置文件存在） */
export function isEvoflowReady() {
  return true
}

/** 标记升级中（阻止 setup 跳转） */
export function setUpgrading(v) { _isUpgrading = !!v }
export function isUpgrading() { return _isUpgrading }

/** 标记用户主动停止 Gateway（不触发自动重启） */
export function setUserStopped(v) {
  _userStopped = !!v
  if (_userStopped) stopGatewayPoll()
}

/** 重置自动重启计数（用户手动启动后重置） */
export function resetAutoRestart() {
  _autoRestartCount = 0
  _lastRestartTime = 0
  _consecutiveFailures = 0
  if (_gatewayRunning) {
    _runningSince = Date.now()
  }
}

/** 监听 guardian 自动重启 Gateway（可 toast 提示用户） */
export function onGuardianRestart(fn) {
  _guardianRestartListeners.push(fn)
  return () => { _guardianRestartListeners = _guardianRestartListeners.filter(cb => cb !== fn) }
}

async function _showGuardianToast(message, type = 'warning', duration = 6000) {
  try {
    const { toast } = await import('../components/toast.js')
    toast(message, type, { duration })
  } catch {
    /* ignore */
  }
}

/** Gateway 是否正在运行 */
export function isGatewayRunning() {
  return _gatewayRunning
}

/** 获取后端平台 ('macos' | 'win32' | 'linux') */
export function getPlatform() {
  return _initRuntimePlatform()
}
export function isMacPlatform() {
  return getPlatform() === 'macos'
}
export function isLinuxPlatform() {
  return getPlatform() === 'linux'
}

/** 部署模式 */
export function getDeployMode() { return _deployMode }
export function isInDocker() { return _inDocker }
export function isDockerAvailable() { return _dockerAvailable }

/** 实例管理 */
let _activeInstance = { id: 'local', name: '本机', type: 'local' }
let _instanceListeners = []

export function getActiveInstance() { return _activeInstance }
export function isLocalInstance() { return _activeInstance.type === 'local' }

export function onInstanceChange(fn) {
  _instanceListeners.push(fn)
  return () => { _instanceListeners = _instanceListeners.filter(cb => cb !== fn) }
}

export async function switchInstance(id) {
  await api.instanceSetActive(id)
  const data = await api.instanceList()
  _activeInstance = data.instances.find(i => i.id === id) || data.instances[0]
  _instanceListeners.forEach(fn => { try { fn(_activeInstance) } catch {} })
}

export async function loadActiveInstance() {
  try {
    const data = await api.instanceList()
    _activeInstance = data.instances.find(i => i.id === data.activeId) || data.instances[0]
  } catch {
    _activeInstance = { id: 'local', name: '本机', type: 'local' }
  }
}

/** 监听 Gateway 状态变化 */
export function onGatewayChange(fn) {
  _gwListeners.push(fn)
  return () => { _gwListeners = _gwListeners.filter(cb => cb !== fn) }
}

/** 检测 evoflow 安装状态 */
export async function detectEvoflowStatus() {
  _evoflowReady = true
  if (isTauri) {
    await refreshGatewayStatus()
  } else {
    _gatewayRunning = true
  }
  _listeners.forEach(fn => { try { fn(_evoflowReady) } catch {} })
  return _evoflowReady
}

function _setGatewayRunning(val) {
  const wasRunning = _gatewayRunning
  const changed = wasRunning !== val
  _gatewayRunning = val
  if (changed) {
    _gwListeners.forEach(fn => { try { fn(val) } catch {} })
  }
}

/** Sidecar child still owned by this panel (process-level, not HTTP). */
async function _isSidecarProcessAlive() {
  if (!isTauri) return null
  // External uvicorn (EVOFLOW_GATEWAY_URL) is operator-owned — Tauri has no
  // child slot, so backendRunning is always false. Returning false here used
  // to mark every transient HTTP stall as "process dead" after a UI refresh.
  if (await _isExternalGateway()) return null
  try {
    const info = await _workspaceRuntimeInfo()
    if (info && typeof info.backendRunning === 'boolean') {
      return !!info.backendRunning
    }
  } catch {
    /* older builds */
  }
  return null
}

async function _workspaceRuntimeInfo() {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke('workspace_runtime_info')
}

/**
 * Split process model: Control Plane up + Agent Runtime down → restart LG only.
 * Keeps settings / session list available while chat engine recovers.
 */
async function _maybeHealLanggraphRuntime() {
  if (!isTauri || _userStopped || _lgRestartInFlight || _restartInFlight) return
  let info
  try {
    info = await _workspaceRuntimeInfo()
  } catch {
    return
  }
  if (String(info?.processModel || '') !== 'split') {
    _lgConsecutiveDown = 0
    return
  }
  if (!info?.backendRunning) return
  if (info.langgraphRunning) {
    _lgConsecutiveDown = 0
    return
  }
  // No LG port recorded → never spawned (inprocess fallback); skip.
  if (!info.langgraphPort) return

  _lgConsecutiveDown += 1
  if (_lgConsecutiveDown < LG_DOWN_RESTART_THRESHOLD) return
  const now = Date.now()
  if (now - _lastLgRestartTime < LG_RESTART_COOLDOWN_MS) return

  _lgRestartInFlight = true
  _lastLgRestartTime = now
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    void import('./gateway-watch.js')
      .then((m) =>
        m.noteGatewayWatch?.(
          'guardian_reload_langgraph',
          { port: info.langgraphPort, attempt: _lgConsecutiveDown },
          { level: 'warn', forceFile: true },
        ),
      )
      .catch(() => {})
    console.warn(
      '[gateway-guardian] Agent Runtime (LangGraph) down — reload_langgraph_runtime (CP kept)',
    )
    await invoke('reload_langgraph_runtime')
    _lgConsecutiveDown = 0
  } catch (e) {
    console.warn('[gateway-guardian] reload_langgraph_runtime failed:', e)
  } finally {
    _lgRestartInFlight = false
  }
}

/** OpenClaw-style drain: wait for streaming run holds before killing sidecar. */
async function _drainBeforeRestart(maxWaitMs = 30_000) {
  const { isGatewayRunHoldActive } = await import('./gateway-guardian-busy.js')
  const deadline = Date.now() + Math.max(0, Number(maxWaitMs) || 0)
  while (isGatewayRunHoldActive() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))
  }
}

async function _tryAutoRestart(options = {}) {
  if (!isTauri || _userStopped || _restartInFlight) return

  const { evaluateAutoRestartAttempt } = await import('./gateway-guardian-policy.js')
  const { markGatewayReloadInProgress, markGatewayWedgedHold } = await import('./gateway-guardian-busy.js')
  const now = Date.now()

  // Process alive + HTTP dead ⇒ wedged loop, not a crash. Never kill.
  const processAlive = await _isSidecarProcessAlive()
  if (processAlive === true && !options.forceProcessDead) {
    markGatewayWedgedHold()
    void import('./gateway-watch.js')
      .then((m) =>
        m.noteGatewayWatch?.(
          'guardian_wedged_skip_reload',
          { processAlive: true },
          { level: 'warn', forceFile: true },
        ),
      )
      .catch(() => {})
    console.warn(
      '[gateway-guardian] sidecar process alive but HTTP unhealthy — skip reload (wedged/busy)',
    )
    return
  }

  const decision = evaluateAutoRestartAttempt({
    now,
    lastRestartTime: _lastRestartTime,
    autoRestartCount: _autoRestartCount,
  })

  if (decision.action === 'cooldown') return

  if (decision.action === 'give_up') {
    // Stop trying to auto-restart; let the guardian poll continue silently.
    return
  }

  _restartInFlight = true
  _autoRestartCount = decision.autoRestartCount
  _lastRestartTime = decision.lastRestartTime

  const forceAfterHold = !!options.forceAfterHold
  _guardianRestartListeners.forEach(fn => {
    try { fn({ attempt: _autoRestartCount, forceAfterHold }) } catch {}
  })

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    // External uvicorn: reload_gateway intentionally skips stop/spawn. Calling
    // markGatewayReloadInProgress() here used to reset the warm latch and make
    // the UI look "unstable" while 8070 was simply down or still warming.
    if (await _isExternalGateway()) {
      const { markGatewayColdStartHold } = await import('./gateway-guardian-busy.js')
      markGatewayColdStartHold(90_000)
      void import('./gateway-watch.js')
        .then((m) =>
          m.noteGatewayWatch?.(
            'guardian_external_wait',
            { attempt: _autoRestartCount, forceAfterHold },
            { level: 'warn', forceFile: true },
          ),
        )
        .catch(() => {})
      console.warn(
        '[gateway-guardian] external Gateway unreachable — skip reload (operator-owned). Waiting for /health/ready…',
        forceAfterHold ? '(after hold)' : '',
      )
      if (!_externalDownToastShown) {
        _externalDownToastShown = true
        try {
          window.dispatchEvent(
            new CustomEvent('evoflow:gateway-external-down', {
              detail: { attempt: _autoRestartCount },
            }),
          )
        } catch {
          /* ignore */
        }
      }
      for (let i = 0; i < 45; i++) {
        await new Promise((r) => setTimeout(r, 2000))
        if (await checkBackendReady()) {
          _consecutiveFailures = 0
          _execHoldFailureSince = null
          _deferToastShown = false
          _externalDownToastShown = false
          _setGatewayRunning(true)
          _runningSince = Date.now()
          console.info('[gateway-guardian] external Gateway recovered (/health/ready)')
          return
        }
      }
      console.warn('[gateway-guardian] external Gateway still down after wait — check uvicorn on 8070')
      return
    }

    console.warn(
      '[gateway-guardian] Gateway process dead/unhealthy, restarting sidecar silently (attempt',
      _autoRestartCount,
      forceAfterHold ? ', after hold expired' : '',
      ')',
    )
    void import('./gateway-watch.js')
      .then((m) =>
        m.noteGatewayWatch?.(
          'guardian_reload',
          { attempt: _autoRestartCount, forceAfterHold, processAlive },
          { level: 'warn', forceFile: true },
        ),
      )
      .catch(() => {})
    await _drainBeforeRestart(30_000)
    markGatewayReloadInProgress()
    await invoke('reload_gateway')
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      // Codex-style: recovery means control plane can serve API, not just listen.
      if (await checkBackendReady()) {
        _consecutiveFailures = 0
        _execHoldFailureSince = null
        _deferToastShown = false
        _setGatewayRunning(true)
        _runningSince = Date.now()
        console.info('[gateway-guardian] Gateway recovered after reload (/health/ready)')
        return
      }
    }
    console.warn('[gateway-guardian] reload_gateway finished but /health/ready still failing')
    // Removed: manual-recovery toast after repeated auto-restart failures.
    // If Gateway is still unhealthy, let the regular guardian poll handle it.
  } catch (e) {
    console.warn('[gateway-guardian] reload_gateway failed:', e)
  } finally {
    _restartInFlight = false
  }
}

async function _pollGatewayOnce() {
  if (!isTauri || _userStopped || _restartInFlight) return

  const { shouldResetAutoRestartCount, evaluateHealthFailure } = await import('./gateway-guardian-policy.js')
  const { isPlanExecutionHoldActive } = await import('./gateway-exec-hold.js')
  const { isGatewayGuardianHoldActive } = await import('./gateway-guardian-busy.js')

  if (isGatewayGuardianHoldActive()) {
    _consecutiveFailures = 0
    return
  }

  const ok = await checkBackendHealth()
  const hasHold = isPlanExecutionHoldActive()
  const hasBusyHold = isGatewayGuardianHoldActive()
  let processAlive = null
  if (!ok) {
    processAlive = await _isSidecarProcessAlive()
    if (processAlive === true) {
      const { markGatewayWedgedHold } = await import('./gateway-guardian-busy.js')
      markGatewayWedgedHold()
    }
  }

  try {
    const { noteGatewayProbeResult } = await import('./gateway-watch.js')
    noteGatewayProbeResult(!!ok, {
      source: 'guardian-poll',
      hold: !!(hasHold || hasBusyHold),
      processAlive,
    })
  } catch {
    /* ignore */
  }

  if (ok) {
    _consecutiveFailures = 0
    _execHoldFailureSince = null
    _deferToastShown = false
    if (!_gatewayRunning) _setGatewayRunning(true)
    if (!_runningSince) _runningSince = Date.now()
    if (shouldResetAutoRestartCount({
      autoRestartCount: _autoRestartCount,
      runningSince: _runningSince,
      now: Date.now(),
    })) {
      resetAutoRestart()
      _runningSince = Date.now()
    }
    // CP healthy: heal Agent Runtime alone when split model reports LG dead.
    await _maybeHealLanggraphRuntime()
    return
  }

  _consecutiveFailures += 1
  if ((hasHold || processAlive === true) && !_execHoldFailureSince) {
    _execHoldFailureSince = Date.now()
  }

  const failureDecision = evaluateHealthFailure({
    consecutiveFailures: _consecutiveFailures,
    hasActivePlanExecution: hasHold,
    hasBusyHold,
    holdFailureSince: _execHoldFailureSince,
    now: Date.now(),
    sidecarProcessAlive: processAlive,
  })

  if (failureDecision.defer) {
    if (!_deferToastShown) {
      _deferToastShown = true
      console.info(
        '[gateway-guardian] defer auto-restart:',
        failureDecision.reason || 'busy',
      )
    }
    return
  }

  if (!failureDecision.shouldRestart) return

  _runningSince = null
  _setGatewayRunning(false)
  await _tryAutoRestart({
    forceAfterHold: failureDecision.forceAfterHold,
    forceProcessDead: processAlive === false,
  })
}

/** 刷新 Gateway 运行状态（轻量，仅查服务状态）
 *  防抖：running→stopped 需要连续 2 次检测才切换，避免瞬态误判 */
export async function refreshGatewayStatus() {
  if (!isTauri) {
    _gatewayRunning = true
    return _gatewayRunning
  }
  const ok = await checkBackendHealth()
  if (ok) {
    _consecutiveFailures = 0
    _setGatewayRunning(true)
    if (!_runningSince) _runningSince = Date.now()
  } else {
    _consecutiveFailures += 1
    if (_consecutiveFailures >= UNHEALTHY_THRESHOLD) {
      _setGatewayRunning(false)
      _runningSince = null
    }
  }
  return _gatewayRunning
}

/** 启动 Gateway 状态轮询（每 15 秒） */
export function startGatewayPoll() {
  if (!isTauri || _pollTimer) return
  void _pollGatewayOnce()
  _pollTimer = setInterval(() => { void _pollGatewayOnce() }, GATEWAY_POLL_MS)
}

export function stopGatewayPoll() {
  if (_pollTimer) {
    clearInterval(_pollTimer)
    _pollTimer = null
  }
}

/** 监听状态变化 */
export function onReadyChange(fn) {
  _listeners.push(fn)
  return () => { _listeners = _listeners.filter(cb => cb !== fn) }
}
