/**
 * 计划确认条唯一展示真源：GET /tasks?thread_id=… 同步结果。
 * 控制台过滤：`[plan-dock]`
 *
 * 开启：localStorage.setItem('EVOFLOW_PLAN_TRACE', '1')
 */

const PREFIX = '[plan-dock]'

function traceEnabled() {
  try {
    if (typeof localStorage === 'undefined') return false
    return localStorage.getItem('EVOFLOW_PLAN_TRACE') === '1'
  } catch {
    return false
  }
}

/**
 * @param {string} stage
 * @param {Record<string, unknown>} [detail]
 */
export function tracePlanDockApi(stage, detail) {
  if (!traceEnabled()) return
   
  console.log(PREFIX, stage, detail ?? '')
}

/**
 * @param {string} source
 * @param {string} reason
 * @param {Record<string, unknown>} [extra]
 */
export function planDockApiHide(source, reason, extra = {}) {
  return {
    show: false,
    source: String(source || '').trim() || 'unknown',
    reason: String(reason || '').trim() || 'hidden',
    ...extra,
  }
}

/**
 * @param {string} source
 * @param {Record<string, unknown>} fields
 */
export function planDockApiShow(source, fields) {
  return {
    show: true,
    source: String(source || '').trim() || 'unknown',
    ...fields,
  }
}
