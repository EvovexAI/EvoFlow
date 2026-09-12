/**
 * Subtask stream / 走马灯 diagnostics (browser console).
 *
 * Default: OFF. Enable:
 *   localStorage.setItem('EVOFLOW_DEBUG_SUBTASK_STREAM', '1')
 *
 * Backend dedicated file (no gateway.log spam):
 *   ~/.evoflow/logs/subtask-stream.trace.log
 *   or EVOFLOW_SUBTASK_STREAM_LOG
 */

const _OFF = new Set(['0', 'false', 'no', 'off'])

function _readFlag(key) {
  try {
    if (typeof localStorage === 'undefined') return null
    const v = localStorage.getItem(key)
    return v == null ? null : String(v).trim().toLowerCase()
  } catch {
    return null
  }
}

export function isSubtaskStreamDebugEnabled() {
  const stream = _readFlag('EVOFLOW_DEBUG_SUBTASK_STREAM')
  if (stream != null) return !_OFF.has(stream)
  const flow = _readFlag('EVOFLOW_DEBUG_SUBTASK_FLOW')
  if (flow != null) return !_OFF.has(flow)
  return false
}

/** @param {...unknown} args */
export function subtaskStreamDebug(...args) {
  if (!isSubtaskStreamDebugEnabled()) return
   
  console.info('[subtask-stream]', ...args)
}

let _bannerShown = false

export function subtaskStreamDebugBannerOnce() {
  if (!isSubtaskStreamDebugEnabled()) return
  if (typeof window === 'undefined') return
  if (_bannerShown) return
  _bannerShown = true
   
  console.info(
    '[subtask-stream] 前端调试已开启。关闭: localStorage.setItem("EVOFLOW_DEBUG_SUBTASK_STREAM","0")。后端日志: ~/.evoflow/logs/subtask-stream.trace.log',
  )
}
