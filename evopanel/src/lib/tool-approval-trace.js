/**
 * 工具授权专用追踪：控制台 + Gateway ``/api/trace/tool-approval-client`` → ``logs/tool-approval-trace.log``
 *
 * 关闭：localStorage.setItem('evopanel:tool-approval-trace', '0')
 */

const PREFIX = '[工具授权追踪]'

function traceEnabled() {
  try {
    return localStorage.getItem('evopanel:tool-approval-trace') !== '0'
  } catch {
    return true
  }
}

function clipText(text, maxLen = 480) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!raw) return '（空）'
  return raw.length <= maxLen ? raw : `${raw.slice(0, maxLen)}…`
}

/**
 * @param {string} event 中文事件名
 * @param {Record<string, unknown>} [fields]
 */
export function logToolApprovalTrace(event, fields = {}) {
  if (!traceEnabled()) return
  const ev = String(event || '前端事件').trim()
  const payload = { event: ev, side: '前端', ...fields }
  const parts = [PREFIX, ev]
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || v === '') continue
    parts.push(`${k}=${clipText(typeof v === 'object' ? JSON.stringify(v) : v, 160)}`)
  }
  console.info(parts.join(' | '))
  void (async () => {
    try {
      const { gatewayJson } = await import('./gateway-json.js')
      await gatewayJson('POST', '/api/trace/tool-approval-client', payload)
    } catch {
      /* 离线或 Gateway 未就绪时仅保留控制台 */
    }
  })()
}

export function logToolApprovalPendingDetected(fields = {}) {
  logToolApprovalTrace('检测到待授权工具', fields)
}

export function logToolApprovalStreamFinal(fields = {}) {
  logToolApprovalTrace('流式 final：进入等待授权分支', fields)
}

export function logToolApprovalUserAction(action, fields = {}) {
  logToolApprovalTrace(`用户操作：${String(action || '').trim()}`, fields)
}
