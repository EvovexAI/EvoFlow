/**
 * 错误分类（E-4 前端迁移）——与后端 evoflow.collab.error_kinds 对齐。
 *
 * 后端已在子任务/run 步骤上落 `error_kind` 字段；旧数据与主任务 error 字段
 * 仍可能只有文本，此处以前缀分类兜底（auto_blocked: / reconcile: / …）。
 * 展示层用 displayErrorText()：非用户可见类别（依赖等待、系统对账痕迹）
 * 返回空串，不再把内部标记暴露给用户。
 */

/** @type {Record<string, string>} */
export const ERROR_KIND_LABELS = {
  business: '业务失败',
  dispatch: '调度失败',
  dependency_blocked: '依赖等待',
  reconcile: '系统恢复',
  cancelled: '已取消',
  timeout: '超时',
  unknown: '',
}

/** 不应出现在用户可见错误面板中的类别 */
const NON_USER_FACING = new Set(['dependency_blocked', 'reconcile'])

/**
 * @param {string} raw
 * @returns {string}
 */
export function classifyErrorText(raw) {
  const s = String(raw || '').trim().toLowerCase()
  if (!s) return 'unknown'
  if (s.startsWith('auto_blocked:')) return 'dependency_blocked'
  if (s.startsWith('reconcile:')) return 'reconcile'
  if (s.startsWith('dispatch error') || s.startsWith('dispatch_failed') || s.startsWith('authorize_failed')) return 'dispatch'
  if (s.includes('timed out') || s.startsWith('timeout')) return 'timeout'
  if (s.includes('cancel')) return 'cancelled'
  return 'business'
}

/**
 * @param {{ error_kind?: string, error?: string, error_text?: string } | null} row
 * @returns {string}
 */
export function errorKindOf(row) {
  if (!row) return 'unknown'
  const kind = String(row.error_kind || '').trim().toLowerCase()
  if (kind) return kind
  const raw = String(row.error || row.error_text || '').trim()
  if (!raw) return 'unknown'
  return classifyErrorText(raw)
}

/** 类别中文标签（unknown 返回空串） */
export function errorKindLabel(row) {
  return ERROR_KIND_LABELS[errorKindOf(row)] || ''
}

/** 用户可见错误文本：非用户可见类别返回空串 */
export function displayErrorText(row) {
  if (!row) return ''
  const kind = errorKindOf(row)
  if (NON_USER_FACING.has(kind)) return ''
  return String(row.error || row.error_text || '').trim()
}
