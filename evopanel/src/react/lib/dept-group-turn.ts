/**
 * 部门群聊 · 本轮用户消息（进员工 sticky chatSend）的结构化标签。
 *
 * 分层（与系统提示 ``<dept_group_im>`` 互补）：
 * - ``<dept_group_hint>``     行为约束 / 来源说明 —— 给模型，前端不展示
 * - ``<dept_group_recent>``   群近期时间线摘要 —— 给模型，前端不展示
 * - ``<dept_group_instruction>`` 用户本条指令/原文 —— 给模型，前端只展示这段正文
 *
 * 外层 ``<dept_group_turn>`` 包住整段。落库保留全文（续聊要给模型看）；
 * 时间线气泡经 ``extractDeptGroupVisibleUserText`` 只露出 instruction。
 */

export const DEPT_GROUP_TURN_VERSION = '1'

export type DeptGroupTurnHint = {
  kind: 'from_agent' | 'behavior' | 'steward'
  text: string
}

export type BuildDeptGroupTurnOpts = {
  instruction: string
  stewardMode?: boolean
  recent?: string
  /** trivial 寒暄轮：recent 截更短，并标 trim=summary */
  recentSummary?: boolean
  hints?: DeptGroupTurnHint[]
}

function escAttr(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
}

function wrapTag(name: string, attrs: Record<string, string | undefined>, body: string): string {
  const attrStr = Object.entries(attrs)
    .filter(([, v]) => v != null && String(v).length > 0)
    .map(([k, v]) => ` ${k}="${escAttr(String(v))}"`)
    .join('')
  return `<${name}${attrStr}>\n${body.trim()}\n</${name}>`
}

/** 组装发给模型的本轮 user 文本（含全部标签）。 */
export function buildDeptGroupTurnUserText(opts: BuildDeptGroupTurnOpts): string {
  const instruction = String(opts.instruction || '').trim()
  const parts: string[] = []
  for (const h of opts.hints || []) {
    const text = String(h?.text || '').trim()
    if (!text) continue
    parts.push(wrapTag('dept_group_hint', { kind: h.kind }, text))
  }
  const recent = String(opts.recent || '').trim()
  if (recent) {
    parts.push(
      wrapTag(
        'dept_group_recent',
        { trim: opts.recentSummary ? 'summary' : 'full' },
        recent,
      ),
    )
  }
  parts.push(
    wrapTag(
      'dept_group_instruction',
      { steward: opts.stewardMode ? '1' : '0' },
      instruction || '（空）',
    ),
  )
  return wrapTag('dept_group_turn', { version: DEPT_GROUP_TURN_VERSION }, parts.join('\n\n'))
}

const RE_TURN = /<dept_group_turn\b[^>]*>([\s\S]*?)<\/dept_group_turn>/i
const RE_INSTRUCTION =
  /<dept_group_instruction\b[^>]*>([\s\S]*?)<\/dept_group_instruction>/i
const RE_HINT = /<dept_group_hint\b[^>]*>[\s\S]*?<\/dept_group_hint>\s*/gi
const RE_RECENT = /<dept_group_recent\b[^>]*>[\s\S]*?<\/dept_group_recent>\s*/gi
const RE_TURN_OPEN = /<\/?dept_group_turn\b[^>]*>\s*/gi

/** 旧版无标签分隔符（兼容历史 sticky 会话）。 */
const RE_LEGACY_RECENT = /【群近期(?:·摘要)?】\s*[\s\S]*?(?=(?:\n\n【|$))/g
const RE_LEGACY_HINT_PAREN = /（群聊提示：[^）]*）\s*/g
const RE_LEGACY_FROM_AT = /（「[^」]+」在群里 @ 了你，请直接回群）\s*/g
const RE_LEGACY_INSTRUCTION_HEADERS =
  /^(?:【本条消息】|【用户对群说（未点名，请你接住）】)\s*/m

/**
 * 前端可见正文：只留用户指令。
 * - 有 ``<dept_group_instruction>`` → 取其内容
 * - 否则剥掉 hint/recent/turn 与旧版【群近期】/群聊提示
 * - 剥完后若空，回落原文（避免误伤普通用户消息）
 */
export function extractDeptGroupVisibleUserText(raw: string): string {
  const text = String(raw || '')
  if (!text.trim()) return ''

  const hasTurnMarkup =
    /<dept_group_(?:turn|hint|recent|instruction)\b/i.test(text) ||
    /【群近期/.test(text) ||
    /（群聊提示：/.test(text) ||
    /【本条消息】/.test(text) ||
    /【用户对群说/.test(text)

  if (!hasTurnMarkup) return text

  const instr = text.match(RE_INSTRUCTION)
  if (instr) {
    return String(instr[1] || '').trim()
  }

  // 旧版：去掉脚手架后，去掉标题头，余下即指令
  let out = text
  const turnBody = text.match(RE_TURN)
  if (turnBody) out = String(turnBody[1] || '')
  out = out
    .replace(RE_HINT, '')
    .replace(RE_RECENT, '')
    .replace(RE_TURN_OPEN, '')
    .replace(RE_LEGACY_RECENT, '')
    .replace(RE_LEGACY_HINT_PAREN, '')
    .replace(RE_LEGACY_FROM_AT, '')
    .replace(RE_LEGACY_INSTRUCTION_HEADERS, '')
    .trim()

  // 旧版可能仍带「【本条消息】\nxxx」整段；再剥一次头
  out = out.replace(RE_LEGACY_INSTRUCTION_HEADERS, '').trim()
  return out || text.trim()
}

/**
 * 从可能含脚手架的气泡正文抽出「可进群近期」的纯文本。
 * 用户消息 → 只要 instruction；其它 → 原样（agent 回复本来就干净）。
 */
export function sanitizeDeptGroupTextForRecentContext(
  kind: string,
  text: string,
): string {
  const raw = String(text || '').trim()
  if (!raw) return ''
  if (kind === 'user') return extractDeptGroupVisibleUserText(raw)
  // agent 偶发把标签抄进回复时也剥掉系统块
  if (/<dept_group_(?:hint|recent)\b/i.test(raw)) {
    return raw.replace(RE_HINT, '').replace(RE_RECENT, '').trim() || raw
  }
  return raw
}

/** 是否像部门群聊本轮注入包（用于诊断 / 测试）。 */
export function looksLikeDeptGroupTurnUserText(raw: string): boolean {
  const t = String(raw || '')
  return (
    /<dept_group_turn\b/i.test(t) ||
    /<dept_group_instruction\b/i.test(t) ||
    /【群近期/.test(t) ||
    /【本条消息】/.test(t) ||
    /【用户对群说/.test(t)
  )
}
