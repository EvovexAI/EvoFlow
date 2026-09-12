/**
 * Model invocation_kind labels (aligned with evoflow.observability.invocation_kinds).
 */

/** @type {Record<string, { zh: string, en: string, hintZh?: string }>} */
export const INVOCATION_KIND_LABELS = {
  main: { zh: '主对话', en: 'Main chat' },
  title: { zh: '会话标题', en: 'Title' },
  mission_state: { zh: '意图 / 任务态分析', en: 'Intent / mission state' },
  memory: { zh: '长期记忆', en: 'Memory' },
  compress: { zh: '上下文压缩 / 摘要', en: 'Compress / summarize' },
  subagent: { zh: '子代理', en: 'Subagent' },
  hosted: { zh: '目标（服务端自动跟进）', en: 'Hosted (server)' },
  hosted_panel: { zh: '目标（面板调度）', en: 'Hosted (panel)' },
  hosted_closure: { zh: '目标（飞书小结）', en: 'Hosted (closure)' },
  auxiliary: { zh: '辅助（未细分）', en: 'Auxiliary (legacy)' },
  unknown: { zh: '未知', en: 'Unknown' },
}

/** @param {string | null | undefined} k */
export function formatInvocationKindLabel(k) {
  const key = String(k || '').trim().toLowerCase()
  if (!key) return '—'
  const hit = INVOCATION_KIND_LABELS[key]
  if (!hit) return key
  const isZh =
    typeof navigator !== 'undefined' &&
    navigator.language &&
    String(navigator.language).toLowerCase().startsWith('zh')
  return isZh ? hit.zh : hit.en
}

/** @param {unknown} rec model_request_payload or vendor row */
export function resolveInvocationKindFromRecord(rec) {
  if (!rec || typeof rec !== 'object') return 'unknown'
  const row = /** @type {Record<string, unknown>} */ (rec)
  const ik = String(row.invocation_kind || '').trim().toLowerCase()
  if (ik && ik !== 'auxiliary') return ik
  const pl = row.payload
  if (pl && typeof pl === 'object') {
    const msgs = /** @type {Record<string, unknown>} */ (pl).messages
    if (Array.isArray(msgs) && msgs.length > 0) return ik || 'main'
    const text = JSON.stringify(pl).toLowerCase()
    if (text.includes('generate a concise title')) return 'title'
    if (text.includes('primary_objective') && text.includes('intent_hint')) return 'mission_state'
  }
  if (ik) return ik
  return 'unknown'
}

/** Filter `<select>` options for observability models tab */
export function invocationKindFilterOptions() {
  return [
    '',
    'main',
    'title',
    'mission_state',
    'memory',
    'compress',
    'subagent',
    'hosted',
    'hosted_panel',
    'hosted_closure',
    'auxiliary',
  ]
}
