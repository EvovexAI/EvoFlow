/**
 * 任务 / 唤醒来源展示：人 = 用户；员工 = 岗位名（不是「你」/裸 agent_code）。
 */

const HUMAN_RAISERS = new Set(['user', 'human', 'manual', 'me', 'owner', 'operator'])

/**
 * @param {Array<{ agent_code?: string, role_name?: string }> | Map<string, string> | Record<string, string> | null | undefined} roles
 * @returns {Map<string, string>} lower(code|role_name) → role_name
 */
export function buildRaisedByRoleLookup(roles) {
  /** @type {Map<string, string>} */
  const map = new Map()
  if (!roles) return map
  if (roles instanceof Map) {
    for (const [k, v] of roles.entries()) {
      const key = String(k || '').trim().toLowerCase()
      const name = String(v || '').trim()
      if (key && name) map.set(key, name)
    }
    return map
  }
  if (Array.isArray(roles)) {
    for (const r of roles) {
      const code = String(r?.agent_code || '').trim()
      const name = String(r?.role_name || '').trim()
      if (!name) continue
      if (code) map.set(code.toLowerCase(), name)
      map.set(name.toLowerCase(), name)
    }
    return map
  }
  if (typeof roles === 'object') {
    for (const [k, v] of Object.entries(roles)) {
      const key = String(k || '').trim().toLowerCase()
      const name = String(v || '').trim()
      if (key && name) map.set(key, name)
    }
  }
  return map
}

export function isHumanRaisedBy(raisedBy) {
  const v = String(raisedBy || '').trim().toLowerCase()
  return !v ? false : HUMAN_RAISERS.has(v)
}

/**
 * @param {unknown} raisedBy raw raised_by / from_agent
 * @param {Array | Map | Record | null} [roles]
 * @returns {string} ``用户`` | 岗位名 | 原值（未知 code）
 */
export function formatRaisedByLabel(raisedBy, roles) {
  const v = String(raisedBy || '').trim()
  if (!v) return ''
  if (isHumanRaisedBy(v)) return '用户'
  const lookup = roles instanceof Map ? roles : buildRaisedByRoleLookup(roles)
  const hit = lookup.get(v.toLowerCase())
  return hit || v
}

/** 芯片文案：来源 · 用户 / 来源 · 前端工程师 */
export function formatRaisedByChip(raisedBy, roles) {
  const label = formatRaisedByLabel(raisedBy, roles)
  return label ? `来源 · ${label}` : ''
}
