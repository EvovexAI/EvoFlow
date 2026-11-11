/**
 * 员工名册卡片 · 副标题/部门标识取值
 *
 * 背景：卡片标题行现在挂「已启用」状态 + 部门 chip，副标题只放真正有信息量的一句话。
 * 员工接口在没填描述时会兜底写 `员工：<显示名>`（见 backend admin/employees.py），
 * 卡片再把这句念一遍纯属噪音 —— 这里统一判掉，让部门 chip 承担归属信息。
 */

function cleanLabel(value) {
  const text = String(value ?? '').trim()
  if (!text || /^(none|null|undefined)$/i.test(text)) return ''
  return text
}

function previewLine(text, max = 72) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 员工所属部门（`department` 字段，兼容 config.department） */
export function roleDeptLabel(role) {
  return cleanLabel(role?.department || role?.config?.department)
}

/** 「未编部门」伪选项值，与真实部门名不冲突 */
export const ROLE_DEPT_NONE = '__none__'

const DESK_PREFIX = /^员工[：:]\s*/

/**
 * 描述是否只是「员工：<本名>」这类无信息占位。
 * 只有 `员工：xxx` 形态且 xxx 与显示名一致时才算回声；正常描述原样保留。
 */
export function roleDescIsNameEcho(desc, role) {
  const text = String(desc || '').trim()
  if (!text || !DESK_PREFIX.test(text)) return false
  const bare = text.replace(DESK_PREFIX, '').trim()
  if (!bare) return true
  const names = [role?.role_name, role?.agent_name, role?.agent_code]
    .map((x) => String(x || '').trim())
    .filter(Boolean)
  return names.includes(bare)
}

/**
 * 系统提示词摘要（职责已并进提示词后，名册/详情用这段顶原先职责列表）。
 * @param {unknown} prompt
 * @param {number} [max]
 */
export function roleSystemPromptPreview(prompt, max = 160) {
  const raw = String(prompt || '')
    .replace(/\r\n/g, '\n')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
  if (!raw) return ''
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return previewLine(lines.slice(0, 4).join(' · ') || raw, max)
}

/** 卡片脸上一句简介；回声描述、与部门重复的描述都不再占用这一行 */
export function roleDutyOneLiner(role, max = 88) {
  const desc = cleanLabel(
    role?.config?.extra_context?.agent_description || role?.agent_description,
  )
  const dept = roleDeptLabel(role)
  if (desc && !roleDescIsNameEcho(desc, role) && desc !== dept) {
    return previewLine(desc, max)
  }
  const resp = Array.isArray(role?.config?.responsibilities)
    ? role.config.responsibilities.filter(Boolean)
    : []
  if (resp.length) return previewLine(resp.join(' · '), max)
  const prompt =
    role?.system_prompt ||
    role?.agent_system_prompt ||
    role?.config?.extra_context?.system_prompt ||
    ''
  return roleSystemPromptPreview(prompt, max)
}


/** 单条员工是否命中部门筛选（空值 = 全部；ROLE_DEPT_NONE = 未编部门） */
export function roleMatchesDeptFilter(role, dept) {
  const target = String(dept || '').trim()
  if (!target) return true
  const own = roleDeptLabel(role)
  if (target === ROLE_DEPT_NONE) return !own
  return own === target
}

/**
 * 名册部门分面（用于筛选下拉）：按首次出现顺序返回部门与计数，外加未编员工数。
 * @returns {{ depts: string[], counts: Map<string, number>, total: number, noneCount: number }}
 */
export function roleDeptFacets(roles = []) {
  const counts = new Map()
  let noneCount = 0
  for (const r of roles || []) {
    const d = roleDeptLabel(r)
    if (!d) noneCount += 1
    else counts.set(d, (counts.get(d) || 0) + 1)
  }
  return { depts: [...counts.keys()], counts, total: (roles || []).length, noneCount }
}
