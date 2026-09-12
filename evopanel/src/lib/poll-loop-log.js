/** Throttled console logging for frontend poll loops (CPU troubleshooting).
 *
 * Default: OFF. Enable:
 *   localStorage.setItem('EVOFLOW_DEBUG_POLL', '1')
 */

const _lastTick = new Map()

function isPollDebugEnabled() {
  try {
    if (typeof localStorage === 'undefined') return false
    return localStorage.getItem('EVOFLOW_DEBUG_POLL') === '1'
  } catch {
    return false
  }
}

function ctxSuffix(ctx) {
  if (!ctx || typeof ctx !== 'object') return ''
  const parts = Object.entries(ctx)
    .filter(([, v]) => v != null && String(v).trim() !== '')
    .map(([k, v]) => `${k}=${v}`)
  return parts.length ? ` ${parts.join(' ')}` : ''
}

export function logPollLoopStart(name, ctx) {
  if (!isPollDebugEnabled()) return
  console.info(`[poll] ${name} 开始处理 loop${ctxSuffix(ctx)}`)
}

export function logPollLoopEnd(name, ctx) {
  if (!isPollDebugEnabled()) return
  console.info(`[poll] ${name} 结束处理 loop${ctxSuffix(ctx)}`)
}

export function logPollTick(name, key, intervalMs, ctx) {
  if (!isPollDebugEnabled()) return
  const cacheKey = `${name}:${key || '-'}`
  const now = Date.now()
  const last = _lastTick.get(cacheKey) || 0
  if (now - last < Math.max(1000, intervalMs || 30000)) return
  _lastTick.set(cacheKey, now)
  console.info(`[poll] ${name} 开始处理 tick${ctxSuffix({ key, ...ctx })}`)
}
