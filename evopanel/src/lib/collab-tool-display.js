/** 协作子任务专用工具：展示标题与 JSON 出参 → 用户可读正文 */

export const SUBTASK_CHECKLIST_ACTION_ZH = {
  list: '查看步骤',
  set: '写入步骤',
  update: '更新步骤',
}

export const SUBTASK_OUTCOME_ZH = {
  completed: '已完成',
  done: '已完成',
  success: '已完成',
  failed: '失败',
  fail: '失败',
  error: '失败',
  blocked: '阻塞',
  cancelled: '已取消',
  canceled: '已取消',
  cancel: '已取消',
}

const CHECKLIST_STATUS_ZH = {
  pending: '待处理',
  in_progress: '执行中',
  running: '执行中',
  executing: '执行中',
  completed: '已完成',
  done: '已完成',
  cancelled: '已取消',
  canceled: '已取消',
}

function trunc(s, max = 48) {
  const t = String(s || '').trim()
  if (!t) return ''
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** @param {unknown} value */
export function parseCollabSubtaskToolJson(value) {
  if (value == null) return null
  if (typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value === 'string') {
    const t = value.trim()
    if (!t || t[0] !== '{') return null
    try {
      const j = JSON.parse(t)
      return typeof j === 'object' && j != null && !Array.isArray(j) ? j : null
    } catch {
      return null
    }
  }
  return null
}

function checklistStatusZh(raw) {
  const k = String(raw || '').trim().toLowerCase()
  return CHECKLIST_STATUS_ZH[k] || (k ? k : '—')
}

/**
 * @param {Record<string, unknown> | null | undefined} args
 */
export function formatSubtaskWorkChecklistTitle(args) {
  const act = String(args?.action || '').trim().toLowerCase() || 'list'
  if (act === 'update') {
    const itemId = String(args?.item_id || args?.itemId || '').trim()
    const st = String(args?.status || '').trim().toLowerCase()
    if (itemId && st) return `subtask_work_checklist · ${act} #${itemId} → ${st}`
    if (itemId) return `subtask_work_checklist · ${act} #${itemId}`
    return `subtask_work_checklist · ${act}`
  }
  if (act === 'set') {
    const items = args?.items
    const n = Array.isArray(items) ? items.length : 0
    return n > 0 ? `subtask_work_checklist · ${act} (${n})` : `subtask_work_checklist · ${act}`
  }
  return `subtask_work_checklist · ${act}`
}

/**
 * @param {Record<string, unknown> | null | undefined} args
 */
export function formatSubtaskOutcomeReportTitle(args) {
  const out = String(args?.outcome || '').trim().toLowerCase() || 'report'
  const summ = trunc(args?.summary, 56)
  if (summ) return `subtask_outcome_report · ${out} · ${summ}`
  if (args?.error) return `subtask_outcome_report · ${out} · ${trunc(args.error, 40)}`
  return `subtask_outcome_report · ${out}`
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function formatSubtaskWorkChecklistOutput(value) {
  const blob = parseCollabSubtaskToolJson(value)
  if (!blob) return ''
  if (blob.ok === false) {
    return String(blob.error || '执行步骤更新失败').trim()
  }
  const table = String(blob.tableMarkdown || blob.table_markdown || '').trim()
  if (table) return table
  const items = blob.items
  if (Array.isArray(items) && items.length) {
    const lines = items.map((row, i) => {
      if (!row || typeof row !== 'object') return ''
      const content = String(row.content || row.title || row.name || '').trim()
      const st = checklistStatusZh(row.status)
      const res = String(row.result || '').trim()
      const id = String(row.id || row.item_id || i + 1).trim()
      const parts = [`${id}. ${content || '—'}`, `[${st}]`]
      if (res) parts.push(res.length > 80 ? `${res.slice(0, 80)}…` : res)
      return parts.join(' ')
    })
    return lines.filter(Boolean).join('\n')
  }
  const act = String(blob.action || '').trim().toLowerCase()
  const actZh = SUBTASK_CHECKLIST_ACTION_ZH[act] || act
  const cnt = blob.count
  if (typeof cnt === 'number') return `${actZh || '已更新'}：共 ${cnt} 项步骤`
  const msg = String(blob.message || '').trim()
  if (msg) return msg
  return actZh ? `${actZh}成功` : '执行步骤已更新'
}

/**
 * @param {unknown} value
 * @param {Record<string, unknown> | null | undefined} [inputArgs]
 * @returns {string}
 */
export function formatSubtaskOutcomeReportOutput(value, inputArgs) {
  const blob = parseCollabSubtaskToolJson(value)
  const inputSumm = String(inputArgs?.summary || '').trim()
  if (!blob) {
    return inputSumm || ''
  }
  if (blob.ok === false) {
    const err = String(blob.error || blob.message || '汇报失败').trim()
    return inputSumm ? `${err}\n\n汇报摘要：\n${inputSumm}` : err
  }
  const st = String(blob.status || '').trim().toLowerCase()
  const stZh = SUBTASK_OUTCOME_ZH[st] || st || '已记录'
  const lines = [`终态：${stZh}`]
  const msg = String(blob.message || '').trim()
  if (msg) lines.push(msg)
  if (typeof blob.progress === 'number') lines.push(`进度：${blob.progress}%`)
  if (inputSumm) {
    lines.push('', '汇报摘要：', inputSumm)
  }
  return lines.join('\n')
}

/** 出参是否含可渲染的 Markdown 表格（执行步骤） */
export function subtaskWorkChecklistOutputHasMarkdownTable(value) {
  const blob = parseCollabSubtaskToolJson(value)
  if (!blob?.ok) return false
  const table = String(blob.tableMarkdown || blob.table_markdown || '').trim()
  return table.includes('|')
}
