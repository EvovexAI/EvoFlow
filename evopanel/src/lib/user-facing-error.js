/** Map backend / dev errors to customer-safe copy for toast and banners. */

const DEFAULT_FALLBACK = '操作失败，请稍后重试'

const DEV_JARGON =
  /thread_id|langgraph|gateway|config\.yaml|supports_vision|plan_goal|plan_steps|protect_first_n|middleware|traceback|evoflow_gateway|\/api\/|typeerror|exception:/i

function hasCjk(text) {
  return /[\u4e00-\u9fff]/.test(text)
}

function looksLikeStackTrace(text) {
  return text.includes('\n') || text.includes('File "') || text.includes(' at ')
}

function looksUserFriendly(text) {
  if (!text || looksLikeStackTrace(text)) return false
  if (DEV_JARGON.test(text)) return false
  if (/^[A-Z][a-zA-Z0-9_]*Error:/.test(text)) return false
  if (text.length > 160) return false
  return hasCjk(text)
}

/**
 * Frontend error codes distinguishing the root cause of network/service failures.
 *
 * - ERR_CLIENT_NETWORK   : 浏览器侧网络异常（Failed to fetch / NetworkError / 断网）。
 *                          根因是用户网络，可重试但需退避。
 * - ERR_SERVICE_UNREACHABLE : 服务端不可达（HTTP 502 / 503 / 504 / Service Unavailable）。
 *                          根因是服务未启动或网关异常，应提示检查服务状态而非无限重试。
 * - ERR_SERVICE_INTERNAL : 服务端内部错误（HTTP 500 / database locked / busy）。
 *                          保持现有重试逻辑。
 */
export const NetworkErrorCode = {
  /** 客户端网络错误：Failed to fetch / NetworkError / ERR_INTERNET_DISCONNECTED */
  CLIENT_NETWORK: 'ERR_CLIENT_NETWORK',
  /** 服务端不可达：HTTP 502 / 503 / 504 */
  SERVICE_UNREACHABLE: 'ERR_SERVICE_UNREACHABLE',
  /** 服务端内部错误：HTTP 500 / database locked / busy */
  SERVICE_INTERNAL: 'ERR_SERVICE_INTERNAL',
}

/** 客户端网络错误特征（浏览器 fetch 抛出，无 HTTP 状态码） */
const CLIENT_NETWORK_PATTERNS =
  /failed to fetch|networkerror|network.*error|err_internet_disconnected|err_network_changed|err_name_not_resolved|err_connection_refused|econnrefused|fetch failed|load failed/i

/** 服务端不可达特征（HTTP 502/503/504 或网关返回的 Service Unavailable） */
const SERVICE_UNREACHABLE_PATTERNS =
  /http 502|http 503|http 504|status.*50[234]|service unavailable|bad gateway|gateway timeout|bodystreamredirect/i

/** 服务端内部错误特征（HTTP 500 / database locked / busy） */
const SERVICE_INTERNAL_PATTERNS =
  /http 500|status.*500|database.*locked|database.*busy|internal server error|sqlite3.*locked/i

/**
 * Classify a raw error into a {@link NetworkErrorCode}.
 *
 * 优先级：客户端网络错误 > 服务端不可达 > 服务端内部错误。
 * 浏览器 ``Failed to fetch`` 没有状态码，必须优先识别，避免被误判为 502。
 *
 * @param {unknown} raw
 * @param {{ status?: number }} [meta]
 * @returns {NetworkErrorCode|null} 命中返回错误码，否则 null（交由 toUserFacingError 兜底）
 */
export function classifyNetworkError(raw, meta = {}) {
  const msg = String(raw ?? '').trim()
  if (!msg && meta.status == null) return null
  const lower = msg.toLowerCase()

  // HTTP 状态码优先：502/503/504 → 服务端不可达；500 → 服务端内部错误
  const status = Number(meta.status)
  if (Number.isFinite(status)) {
    if (status === 502 || status === 503 || status === 504) return NetworkErrorCode.SERVICE_UNREACHABLE
    if (status === 500) return NetworkErrorCode.SERVICE_INTERNAL
  }

  // 文本特征匹配：客户端网络错误优先（Failed to fetch 是浏览器抛出，无状态码）
  if (CLIENT_NETWORK_PATTERNS.test(lower)) return NetworkErrorCode.CLIENT_NETWORK
  if (SERVICE_UNREACHABLE_PATTERNS.test(lower)) return NetworkErrorCode.SERVICE_UNREACHABLE
  if (SERVICE_INTERNAL_PATTERNS.test(lower)) return NetworkErrorCode.SERVICE_INTERNAL
  return null
}

/** 客户端网络错误用户提示 */
const CLIENT_NETWORK_MESSAGE = '网络连接异常，请检查网络后重试'
/** 服务端不可达用户提示 */
const SERVICE_UNREACHABLE_MESSAGE = '服务未启动或暂时不可用，请检查服务状态'
/** 服务端内部错误用户提示 */
const SERVICE_INTERNAL_MESSAGE = '服务暂时不可用，请稍后重试'

/**
 * Get the user-facing message for a {@link NetworkErrorCode}.
 * @param {string} code
 * @returns {string|null}
 */
export function messageForNetworkErrorCode(code) {
  switch (code) {
    case NetworkErrorCode.CLIENT_NETWORK:
      return CLIENT_NETWORK_MESSAGE
    case NetworkErrorCode.SERVICE_UNREACHABLE:
      return SERVICE_UNREACHABLE_MESSAGE
    case NetworkErrorCode.SERVICE_INTERNAL:
      return SERVICE_INTERNAL_MESSAGE
    default:
      return null
  }
}

/**
 * @param {unknown} raw
 * @param {string} [fallback]
 * @returns {string}
 */
export function toUserFacingError(raw, fallback = DEFAULT_FALLBACK) {
  const msg = String(raw ?? '').trim()
  if (!msg) return fallback
  if (looksUserFriendly(msg)) return msg

  const lower = msg.toLowerCase()

  // 优先用网络错误分类，确保 502 与客户端网络错误文案区分
  const netCode = classifyNetworkError(raw)
  if (netCode) {
    const netMsg = messageForNetworkErrorCode(netCode)
    if (netMsg) return netMsg
  }

  if (/thread_id|thread id/.test(lower)) return '会话尚未就绪，请稍后重试'
  if (/supports_vision|config\.yaml/.test(lower)) {
    return '当前模型不支持图片，请切换支持图片的模型后再试'
  }
  if (/gateway|evoflow gateway/.test(lower)) return '服务连接异常，请确认服务已启动后重试'
  if (/plan_goal|plan_steps|落库|boundplan/.test(lower)) return '计划暂不可用，请稍后重试'
  if (/protect_first_n|should_compress|contextcompaction/.test(lower)) {
    return '对话整理失败，请稍后重试'
  }
  if (/not found|404/.test(lower) && /优化|enhance|prompt/.test(lower)) {
    return '提示词优化功能暂不可用，请稍后重试'
  }
  if (/超时|timeout/.test(lower)) return '请求超时，请稍后重试'
  if (/get live-run failed|live-run/.test(lower)) return '暂时无法加载对话，请刷新后重试'
  if (/origin not allowed|not_paired|pairing_required|auth/.test(lower)) {
    return '连接未授权，请检查配对或登录状态'
  }
  if (/userinterrupt|user interrupt/.test(lower)) return ''

  if (/^[A-Z][a-zA-Z0-9_]*(?:Error|Exception):/.test(msg)) return fallback
  if (DEV_JARGON.test(msg)) return fallback
  if (!hasCjk(msg) && msg.length > 60) return fallback

  return msg
}

export { DEFAULT_FALLBACK as USER_FACING_ERROR_FALLBACK }
