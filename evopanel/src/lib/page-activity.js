/**
 * 轻量页面行为总线：各模块可上报「用户刚在干什么」，
 * 小V 发消息时一并带进页面快照。
 */
export const PAGE_ACTIVITY_EVENT = 'evoflow:page-activity'

/** @type {Array<{ at: number, type: string, module?: string, label?: string, entityId?: string, detail?: string }>} */
const _recent = []
const MAX = 12

/**
 * @param {{ type: string, module?: string, label?: string, entityId?: string, detail?: string }} detail
 */
export function emitPageActivity(detail = {}) {
  const type = String(detail.type || '').trim()
  if (!type) return
  const row = {
    at: Date.now(),
    type,
    module: detail.module ? String(detail.module) : undefined,
    label: detail.label ? String(detail.label).slice(0, 120) : undefined,
    entityId: detail.entityId ? String(detail.entityId).slice(0, 120) : undefined,
    detail: detail.detail ? String(detail.detail).slice(0, 200) : undefined,
  }
  _recent.push(row)
  while (_recent.length > MAX) _recent.shift()
  try {
    window.dispatchEvent(new CustomEvent(PAGE_ACTIVITY_EVENT, { detail: row }))
  } catch {
    /* ignore */
  }
}

/** @param {number} [limit] */
export function getRecentPageActivities(limit = 8) {
  const n = Math.max(1, Math.min(MAX, Number(limit) || 8))
  return _recent.slice(-n).map((r) => ({ ...r }))
}
