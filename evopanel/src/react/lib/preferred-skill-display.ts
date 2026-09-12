import type { DisplayRow } from '../chat-types.js'

/** 旧版方案 A：技能指令前缀（历史消息兼容） */
export const PREFERRED_SKILL_USER_PREFIX_RE =
  /^\[请优先使用「([^」]+)」技能处理以下请求\]\s*\n+([\s\S]*)$/

export type PreferredSkillBadge = {
  name: string
  label: string
  icon?: string
}

export function parsePreferredSkillUserText(raw: string): {
  text: string
  preferredSkill?: PreferredSkillBadge
} {
  const s = String(raw || '')
  const m = s.match(PREFERRED_SKILL_USER_PREFIX_RE)
  if (!m) return { text: s }
  const label = String(m[1] || '').trim()
  if (!label) return { text: s }
  return {
    text: String(m[2] ?? ''),
    preferredSkill: {
      name: label,
      label,
      icon: '🧩',
    },
  }
}

/**
 * 解析用户消息行关联的技能展示信息。
 * 多选优先读 preferredSkills（数组）；旧版回退到 preferredSkill（单数）/ 文本前缀。
 * 始终回填 preferredSkills（数组）与 preferredSkill（首个，向后兼容）。
 */
export function resolveUserMessageSkillDisplay(row: DisplayRow): {
  text: string
  preferredSkill?: PreferredSkillBadge
  preferredSkills?: PreferredSkillBadge[]
} {
  const fromText = String(row.text || '')
  const fromSegments = String(
    (row.segments || [])
      .filter((seg) => seg?.kind === 'text')
      .map((seg) => (seg.kind === 'text' ? seg.text : ''))
      .join('\n'),
  )
  const raw = fromText || fromSegments

  // 多选优先
  if (Array.isArray(row.preferredSkills) && row.preferredSkills.length > 0) {
    const list = row.preferredSkills
    return {
      text: raw,
      preferredSkills: list,
      preferredSkill: list[0],
    }
  }
  // 旧版单数
  if (row.preferredSkill) {
    return {
      text: raw,
      preferredSkill: row.preferredSkill,
      preferredSkills: [row.preferredSkill],
    }
  }
  // 文本前缀兜底
  const parsed = parsePreferredSkillUserText(raw)
  if (parsed.preferredSkill) {
    return {
      text: parsed.text,
      preferredSkill: parsed.preferredSkill,
      preferredSkills: [parsed.preferredSkill],
    }
  }
  return { text: raw }
}

export function applyPreferredSkillDisplayToUserRow(row: DisplayRow): DisplayRow {
  if (row.role !== 'user') return row
  const { text, preferredSkill, preferredSkills } = resolveUserMessageSkillDisplay(row)
  if (!preferredSkill && !preferredSkills?.length) return row
  const next: DisplayRow = { ...row, text }
  if (preferredSkills?.length) next.preferredSkills = preferredSkills
  if (preferredSkill) next.preferredSkill = preferredSkill
  if (text === row.text && row.preferredSkill && row.preferredSkills) return row
  return next
}
