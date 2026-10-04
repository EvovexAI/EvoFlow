/**
 * Gateway / stream transport console logging — **off by default**.
 *
 * 传输选择与 Gateway 往返耗时日志（`[gw-audit#…]`、`[evoflow-transport] …`）每来一个请求 /
 * 每开一条 SSE 就会打一行，桌面端还会被 `console-file-log.js` 镜像进
 * `~/.evoflow/logs/frontend-YYYY-MM-DD.log`，把控制台和日志文件一起刷爆。
 * 这里统一开关，让它们在需要排查时再打开。
 *
 * 打开（任选其一，刷新生效）：
 *   localStorage.setItem('EVOFLOW_DEBUG_TRANSPORT', '1')
 *   或 http://…/?gwdebug=1
 *
 * 关闭：
 *   localStorage.setItem('EVOFLOW_DEBUG_TRANSPORT', '0')
 *
 * 注意：这只影响 console 输出。结构化日志（`window.__evoflow_gw_logs` /
 * `getGatewayAuditLogs()`）依旧完整保留，排查时从那里读。
 */

import { isDebugOn } from './debug-flag.js'

const _FLAG = 'EVOFLOW_DEBUG_TRANSPORT'
const _URL_PARAM = 'gwdebug'
const _TRANSPORT_PREFIX = '[evoflow-transport]'
const _RAW_PREFIX = '[panel-stream-raw]'

/**
 * 传输类日志是否放行到 console。默认 false。
 * URL param `?gwdebug=1` 优先于 flag，方便一次性的排查链接。
 */
export function isTransportLogEnabled() {
  if (typeof window === 'undefined') return false
  try {
    const urlFlag = new URL(window.location.href).searchParams.get(_URL_PARAM)
    if (urlFlag !== null) {
      const v = String(urlFlag).trim().toLowerCase()
      return v !== '' && v !== '0' && v !== 'false' && v !== 'off' && v !== 'no'
    }
  } catch {
    /* ignore */
  }
  return isDebugOn(_FLAG)
}

/**
 * 传输选择日志（走哪条 pipe / 落到哪个 transport）。
 * @param {string} tag 例如 `sse transport=dev-fetch /api/events/...`
 */
export function transportLog(tag, ...args) {
  if (!isTransportLogEnabled()) return
  console.info(`${_TRANSPORT_PREFIX} ${tag}`, ...args)
}

/** 原始 SSE 帧转储（每个 TOOL_CALL 事件一行，噪音最大的一类）。 */
export function transportRawLog(...args) {
  if (!isTransportLogEnabled()) return
  console.info(_RAW_PREFIX, ...args)
}
