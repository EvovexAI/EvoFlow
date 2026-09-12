/**
 * Gateway guardian 忙碌/重载 hold：流式对话、配置 reload 期间勿误判「无响应」并重启 sidecar。
 */

/** @type {Set<string>} */
const _runHolds = new Set()

let _reloadHoldUntil = 0

/** 配置保存 / guardian 自身触发的 reload，sidecar 冷启动可能数十秒 */
const RELOAD_HOLD_MS = 45_000

/**
 * 桌面冷启动：LG lifespan / DB preflight 可能冻结事件循环十余秒，
 * liveness 短暂超时会被 guardian 当成挂死并 reload，反而把「引擎加载中」拖到数分钟。
 */
const COLD_START_HOLD_MS = 120_000

export function registerGatewayRunHold(runId) {
  const id = String(runId || '').trim()
  if (id) _runHolds.add(id)
}

export function unregisterGatewayRunHold(runId) {
  const id = String(runId || '').trim()
  if (id) _runHolds.delete(id)
}

export function clearGatewayRunHolds() {
  _runHolds.clear()
}

export function markGatewayReloadInProgress(durationMs = RELOAD_HOLD_MS) {
  const ms = Math.max(5_000, Number(durationMs) || RELOAD_HOLD_MS)
  _reloadHoldUntil = Math.max(_reloadHoldUntil, Date.now() + ms)
  // Reload drops the listening process — re-hold API traffic until liveness returns.
  import('./tauri-api.js')
    .then((m) => {
      if (typeof m.resetGatewayWarmLatch === 'function') m.resetGatewayWarmLatch('guardian_reload_hold')
    })
    .catch(() => {})
}

/** 首次拉起 / UI-first 启动：在 /ready 之前禁止 guardian 误杀 sidecar */
export function markGatewayColdStartHold(durationMs = COLD_START_HOLD_MS) {
  const ms = Math.max(30_000, Number(durationMs) || COLD_START_HOLD_MS)
  _reloadHoldUntil = Math.max(_reloadHoldUntil, Date.now() + ms)
}

export function isGatewayReloadHoldActive() {
  return Date.now() < _reloadHoldUntil
}

export function isGatewayRunHoldActive() {
  return _runHolds.size > 0
}

/** 流式 run 或 sidecar reload 进行中 */
export function isGatewayGuardianHoldActive() {
  return isGatewayRunHoldActive() || isGatewayReloadHoldActive()
}

export function getGatewayGuardianHoldSnapshot() {
  return {
    runHoldCount: _runHolds.size,
    reloadHoldUntil: _reloadHoldUntil > Date.now() ? _reloadHoldUntil : null,
  }
}
