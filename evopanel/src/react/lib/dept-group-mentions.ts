/**
 * 部门群聊 @ 解析：按「@ 后最长前缀」匹配花名册（中文可紧挨正文），
 * 并兼容改名前的旧称呼。
 */

export type DeptMentionMember = {
  agent_code: string
  role_name: string
}

/** 旧称呼 / 简称 → 用花名册里「角色名包含该关键字」的人接住 */
const MENTION_ALIASES: Array<{ alias: string; roleIncludes: string[] }> = [
  { alias: '测试', roleIncludes: ['测试'] },
  { alias: '后端开发', roleIncludes: ['全栈', '后端'] },
  { alias: '前端开发', roleIncludes: ['全栈', '前端'] },
  { alias: '后端', roleIncludes: ['全栈', '后端'] },
  { alias: '前端', roleIncludes: ['全栈', '前端'] },
  { alias: '全站工程师', roleIncludes: ['全栈工程师'] },
  { alias: '全站开发', roleIncludes: ['全栈开发'] },
  { alias: '全站', roleIncludes: ['全栈'] },
]

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

type LabelHit = { label: string; person: DeptMentionMember }

function buildMentionLabels(members: DeptMentionMember[]): LabelHit[] {
  const out: LabelHit[] = []
  const seenLabel = new Set<string>()
  const push = (label: string, person: DeptMentionMember) => {
    const lab = String(label || '').trim()
    if (!lab || !person?.agent_code) return
    const key = `${lab.toLowerCase()}::${person.agent_code}`
    if (seenLabel.has(key)) return
    seenLabel.add(key)
    out.push({ label: lab, person })
  }

  for (const m of members) {
    push(m.role_name, m)
    push(m.agent_code, m)
  }

  for (const { alias, roleIncludes } of MENTION_ALIASES) {
    const hit = members.find((m) => {
      const name = String(m.role_name || '')
      return roleIncludes.some((k) => name.includes(k))
    })
    if (hit) push(alias, hit)
  }

  out.sort((a, b) => b.label.length - a.label.length || a.label.localeCompare(b.label, 'zh-CN'))
  return out
}

/**
 * 扫描正文里所有 @：对每个 @ 取花名册/别名中能匹配的最长前缀。
 * 不要求 @名 后必须有空格（中文常见「@全栈工程师先看下」）。
 */
export function parseMentions<T extends DeptMentionMember>(text: string, members: T[]): T[] {
  const raw = String(text || '')
  if (!raw || !members?.length) return []
  const labels = buildMentionLabels(members)
  const hits: T[] = []
  const seen = new Set<string>()

  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '@') continue
    const rest = raw.slice(i + 1)
    let best: LabelHit | null = null
    for (const row of labels) {
      if (seen.has(row.person.agent_code)) continue
      if (rest.toLowerCase().startsWith(row.label.toLowerCase())) {
        best = row
        break // labels 已按长度降序
      }
    }
    if (!best) continue
    const person = members.find((m) => m.agent_code === best!.person.agent_code)
    if (!person) continue
    hits.push(person)
    seen.add(person.agent_code)
    i += best.label.length // for 循环还会 +1，跳过已匹配名
  }
  return hits
}

/** 正文里是否像有 @点名，但花名册一个都没解析到（改名后常见） */
export function hasUnresolvedAtMentions(text: string, members: DeptMentionMember[]): boolean {
  const raw = String(text || '')
  if (!/@[\u4e00-\u9fffA-Za-z]/.test(raw)) return false
  return parseMentions(raw, members).length === 0
}

export function extractMentionGoal(text: string, person: DeptMentionMember): string {
  const labels = buildMentionLabels([person]).map((x) => x.label)
  // 也试角色名/code 本身
  for (const p of [...labels, person.role_name, person.agent_code].filter(Boolean)) {
    const re = new RegExp(`@${escapeReg(String(p))}\\s*([\\s\\S]*?)(?=@[\\u4e00-\\u9fffA-Za-z]|$)`, 'i')
    const m = String(text || '').match(re)
    const chunk = String(m?.[1] || '').trim()
    if (chunk) return chunk
  }
  return String(text || '').trim()
}

export function stripLeadingMentions(text: string, members: DeptMentionMember[]): string {
  let out = String(text || '')
  const labels = buildMentionLabels(members)
  let guard = 0
  while (guard++ < 12) {
    let hit = false
    for (const { label } of labels) {
      const re = new RegExp(`^\\s*@${escapeReg(label)}\\s*`, 'i')
      if (re.test(out)) {
        out = out.replace(re, '')
        hit = true
        break
      }
    }
    if (!hit) break
  }
  return out.trim() || String(text || '').trim()
}

/** 渲染用：找出 [@token, start, end) */
export function findMentionSpans(
  text: string,
  members: DeptMentionMember[],
): Array<{ start: number; end: number; token: string; person: DeptMentionMember | null }> {
  const raw = String(text || '')
  const labels = buildMentionLabels(members)
  const spans: Array<{ start: number; end: number; token: string; person: DeptMentionMember | null }> =
    []
  const seenAt = new Set<number>()

  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '@') continue
    if (seenAt.has(i)) continue
    const rest = raw.slice(i + 1)
    let best: LabelHit | null = null
    for (const row of labels) {
      if (rest.toLowerCase().startsWith(row.label.toLowerCase())) {
        best = row
        break
      }
    }
    if (!best) continue
    const end = i + 1 + best.label.length
    spans.push({
      start: i,
      end,
      token: raw.slice(i, end),
      person: best.person,
    })
    seenAt.add(i)
    i = end - 1
  }
  return spans
}
