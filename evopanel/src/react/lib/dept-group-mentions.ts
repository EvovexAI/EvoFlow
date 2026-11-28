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
  { alias: '自我进化BOT', roleIncludes: ['自我进化'] },
  { alias: '自我进化', roleIncludes: ['自我进化'] },
  // 旧称「全栈开发工程师」已改码为 self-evolution-bot / 自我进化BOT
  { alias: '全栈开发工程师', roleIncludes: ['自我进化'] },
  { alias: '后端开发', roleIncludes: ['自我进化', '全栈', '后端'] },
  { alias: '前端开发', roleIncludes: ['自我进化', '全栈', '前端'] },
  { alias: '后端', roleIncludes: ['自我进化', '全栈', '后端'] },
  { alias: '前端', roleIncludes: ['自我进化', '全栈', '前端'] },
  { alias: '全站工程师', roleIncludes: ['自我进化', '全栈工程师'] },
  { alias: '全站开发', roleIncludes: ['自我进化', '全栈开发'] },
  { alias: '全站', roleIncludes: ['自我进化', '全栈'] },
  { alias: '分镜师', roleIncludes: ['分镜'] },
  { alias: '编剧', roleIncludes: ['编剧'] },
  { alias: '生成师', roleIncludes: ['生成师'] },
  { alias: '反推师', roleIncludes: ['反推'] },
  { alias: '复刻师', roleIncludes: ['复刻'] },
  { alias: '出图师', roleIncludes: ['出图'] },
  { alias: '导演', roleIncludes: ['导演'] },
]

/** 从全称拆出口语简称：``漫剧分镜师``→``分镜师``，``AIGC 反推师``→``反推师``。 */
export function deriveMentionShortLabels(roleName: string): string[] {
  const name = String(roleName || '').trim()
  if (!name) return []
  const out: string[] = []
  const push = (s: string) => {
    const t = String(s || '').trim()
    if (!t || t === name || t.length < 2) return
    if (!out.includes(t)) out.push(t)
  }
  // 去常见前缀（部门/品类口头省略）
  push(name.replace(/^(?:AIGC|AI|漫剧|电商|直播)\s*/i, ''))
  // 末尾职衔块：…分镜师 / …总监 / …BOT
  const tail = name.match(/([\u4e00-\u9fffA-Za-z0-9]{2,8}(?:师|总监|BOT|助手|专员|经理|导演))$/i)
  if (tail?.[1]) push(tail[1])
  // 去空格后再取尾（``AIGC 导演`` → ``导演``）
  const compact = name.replace(/\s+/g, '')
  if (compact !== name) {
    const cTail = compact.match(/([\u4e00-\u9fffA-Za-z0-9]{2,8}(?:师|总监|BOT|助手|专员|经理|导演))$/i)
    if (cTail?.[1]) push(cTail[1])
  }
  return out
}

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

  // 口语简称：仅当本群花名册里唯一命中该简称时才挂（避免两个「…师」抢同一个短名）
  for (const m of members) {
    for (const short of deriveMentionShortLabels(m.role_name)) {
      const hits = members.filter((other) => {
        const n = String(other.role_name || '')
        if (n === short || n.endsWith(short)) return true
        return deriveMentionShortLabels(n).includes(short)
      })
      if (hits.length === 1 && hits[0].agent_code === m.agent_code) {
        push(short, m)
      }
    }
  }

  for (const { alias, roleIncludes } of MENTION_ALIASES) {
    const matched = members.filter((m) => {
      const name = String(m.role_name || '')
      return roleIncludes.some((k) => name.includes(k))
    })
    // 别名也要求唯一，避免「导演」误绑到氛围部同群里另一个导演
    if (matched.length === 1) push(alias, matched[0])
  }

  out.sort((a, b) => b.label.length - a.label.length || a.label.localeCompare(b.label, 'zh-CN'))
  return out
}

/** @ 与角色名之间允许空格/换行（微信常见「@ 全栈」或 @ 后换行） */
function matchMentionAt(
  raw: string,
  atIndex: number,
  labels: LabelHit[],
  skipCodes?: Set<string>,
): { hit: LabelHit; consumed: number } | null {
  if (raw[atIndex] !== '@') return null
  const afterAt = raw.slice(atIndex + 1)
  const ws = afterAt.match(/^[\s\u00a0]*/)?.[0] || ''
  const rest = afterAt.slice(ws.length)
  if (!rest) return null
  for (const row of labels) {
    if (skipCodes?.has(row.person.agent_code)) continue
    if (rest.toLowerCase().startsWith(row.label.toLowerCase())) {
      // 1(@) + 空白 + 角色名
      return { hit: row, consumed: 1 + ws.length + row.label.length }
    }
  }
  return null
}

/**
 * 扫描正文里所有 @：对每个 @ 取花名册/别名中能匹配的最长前缀。
 * 允许「@名」「@ 名」、@ 后换行；不要求名后必须有空格。
 */
export function parseMentions<T extends DeptMentionMember>(text: string, members: T[]): T[] {
  const raw = String(text || '')
  if (!raw || !members?.length) return []
  const labels = buildMentionLabels(members)
  const hits: T[] = []
  const seen = new Set<string>()

  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '@') continue
    const matched = matchMentionAt(raw, i, labels, seen)
    if (!matched) continue
    const person = members.find((m) => m.agent_code === matched.hit.person.agent_code)
    if (!person) continue
    hits.push(person)
    seen.add(person.agent_code)
    i += matched.consumed - 1 // for 还会 +1
  }
  return hits
}

/** 正文里是否像有 @点名，但花名册一个都没解析到（改名后常见） */
export function hasUnresolvedAtMentions(text: string, members: DeptMentionMember[]): boolean {
  const raw = String(text || '')
  if (!/@\s*[\u4e00-\u9fffA-Za-z]/.test(raw)) return false
  return parseMentions(raw, members).length === 0
}

export function extractMentionGoal(text: string, person: DeptMentionMember): string {
  const labels = buildMentionLabels([person]).map((x) => x.label)
  // 也试角色名/code 本身；@ 后允许空白
  for (const p of [...labels, person.role_name, person.agent_code].filter(Boolean)) {
    const re = new RegExp(
      `@\\s*${escapeReg(String(p))}\\s*([\\s\\S]*?)(?=@\\s*[\\u4e00-\\u9fffA-Za-z]|$)`,
      'i',
    )
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
      const re = new RegExp(`^\\s*@\\s*${escapeReg(label)}\\s*`, 'i')
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
    const matched = matchMentionAt(raw, i, labels)
    if (!matched) continue
    const end = i + matched.consumed
    spans.push({
      start: i,
      end,
      token: raw.slice(i, end),
      person: matched.hit.person,
    })
    seenAt.add(i)
    i = end - 1
  }
  return spans
}
