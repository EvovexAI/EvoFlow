/**
 * 全局应用状态
 * 管理 Gateway 运行状态与轻量守护（桌面端 sidecar 自动恢复）
 */
import { api, checkBackendHealth } from './tauri-api.js'
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

const GATEWAY_POLL_MS = 15000

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

async function _tryAutoRestart(options = {}) {
  if (!isTauri || _userStopped || _restartInFlight) return

  const { evaluateAutoRestartAttempt } = await import('./gateway-guardian-policy.js')
  const { markGatewayReloadInProgress } = await import('./gateway-guardian-busy.js')
  const now = Date.now()
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
    console.warn(
      '[gateway-guardian] Gateway unhealthy, restarting sidecar silently (attempt',
      _autoRestartCount,
      forceAfterHold ? ', after hold expired' : '',
      ')',
    )
    markGatewayReloadInProgress()
    await invoke('reload_gateway')
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      if (await checkBackendHealth()) {
        _consecutiveFailures = 0
        _execHoldFailureSince = null
        _deferToastShown = false
        _setGatewayRunning(true)
        _runningSince = Date.now()
        console.info('[gateway-guardian] Gateway recovered after reload')
        return
      }
    }
    console.warn('[gateway-guardian] reload_gateway finished but health still failing')
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
    return
  }

  _consecutiveFailures += 1
  if (hasHold && !_execHoldFailureSince) {
    _execHoldFailureSince = Date.now()
  }

  const failureDecision = evaluateHealthFailure({
    consecutiveFailures: _consecutiveFailures,
    hasActivePlanExecution: hasHold,
    hasBusyHold,
    holdFailureSince: _execHoldFailureSince,
    now: Date.now(),
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
  await _tryAutoRestart({ forceAfterHold: failureDecision.forceAfterHold })
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
