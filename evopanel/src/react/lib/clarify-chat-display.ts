import {
  CLARIFICATION_STALE_OUTPUT_MARKERS,
  clarificationPreviewJsonFromToolArgs,
  coerceClarifyOptionsList,
  isCommandInterruptOutput,
  isClarificationPreviewRenderable,
  isStaleClarificationPreview,
  readAskClarificationInput,
  resolveClarificationPreview,
  tryParseClarifyPreviewJson,
  clarificationPreviewFromTool,
} from '../../lib/clarify-preview-resolve.js'
import { isAskClarificationAwaitingUser } from '../../lib/ask-clarification-pending.js'

export {
  CLARIFICATION_STALE_OUTPUT_MARKERS,
  clarificationPreviewJsonFromToolArgs,
  clarificationPreviewFromTool,
  coerceClarifyOptionsList,
  isCommandInterruptOutput,
  isClarificationPreviewRenderable,
  isStaleClarificationPreview,
  resolveClarificationPreview,
  tryParseClarifyPreviewJson,
}

const CLARIFY_MARKER = '__EVF_CLARIFY_ANS_V1__'

export function parseStructuredClarification(preview: string | undefined | null) {
  return tryParseClarifyPreviewJson(String(preview || ''))
}

/** 从「协议前缀 + JSON（及可能尾部续写）」中解析出 answers 对象 */
function tryParseClarifyAnswerPayload(raw: string): {
  answers?: Array<{ question_id?: string; selected_option_labels?: string[] }>
  free_text?: string
} | null {
  const s = String(raw || '').replace(/^\uFEFF/, '')
  const idx = s.indexOf(CLARIFY_MARKER)
  if (idx < 0) return null
  let rest = s.slice(idx + CLARIFY_MARKER.length).trimStart()
  if (rest.startsWith(':') || rest.startsWith('：')) rest = rest.slice(1).trimStart()
  const tryParse = (t: string) => {
    const x = t.trim()
    if (!x) return null
    try {
      return JSON.parse(x) as Record<string, unknown>
    } catch {
      const first = x.indexOf('{')
      const last = x.lastIndexOf('}')
      if (first < 0 || last <= first) return null
      try {
        return JSON.parse(x.slice(first, last + 1)) as Record<string, unknown>
      } catch {
        return null
      }
    }
  }
  const o = tryParse(rest)
  if (!o || typeof o !== 'object') return null
  return o as { answers?: Array<{ question_id?: string; selected_option_labels?: string[] }>; free_text?: string }
}

/** 与后端 execution_lifecycle.user_execution_start_intent 对齐：用户确认开始执行 */
export function isUserExecutionStartIntent(text: string | undefined | null): boolean {
  const raw = String(text || '').trim()
  if (!raw) return false
  if (raw.includes(CLARIFY_MARKER)) {
    const payload = tryParseClarifyAnswerPayload(raw)
    if (!payload) return false
    for (const ans of payload.answers || []) {
      for (const lb of ans.selected_option_labels || []) {
        const s = String(lb || '').trim()
        if (s.includes('开始执行') || s.includes('按计划开始执行')) return true
      }
    }
    const ft = String(payload.free_text || '').trim().toLowerCase()
    if (ft && (ft.includes('开始执行') || ft.includes('按计划执行') || ft.includes('start execution'))) {
      return true
    }
    return false
  }
  const compact = raw.replace(/ /g, '').replace(/\u3000/g, '')
  if (
    [
      '开始',
      '开始执行',
      '确认开始',
      '确认开始执行',
      '按计划开始执行',
      '按计划执行',
      '开始吧',
      '执行',
      'start',
      'startexecution',
    ].includes(compact) ||
    compact.toLowerCase() === 'startexecution'
  ) {
    return true
  }
  if (raw.length <= 64) {
    if (raw.includes('开始执行') || raw.includes('按计划执行')) return true
    if (raw.startsWith('开始') && raw.includes('执行')) return true
    const lower = raw.toLowerCase()
    if (lower.includes('start execution') || lower === 'go') return true
  }
  return false
}

/** 将侧栏结构化澄清提交转为主会话区可读文案（仍向后端发送原始前缀+JSON） */
export function formatUserClarificationBubbleText(raw: string): string | null {
  const o = tryParseClarifyAnswerPayload(raw)
  if (!o) return null
  try {
    const lines: string[] = ['已提交选择']
    for (const a of o.answers || []) {
      const labels = (a.selected_option_labels || []).map((x) => String(x || '').trim()).filter(Boolean)
      if (labels.length) lines.push(`· ${labels.join('、')}`)
    }
    const ft = String(o.free_text || '').trim()
    if (ft) lines.push(`补充说明：${ft}`)
    return lines.join('\n')
  } catch {
    return '已提交澄清回复'
  }
}

/** 同行存在待填写的 ask_clarification 时，助手正文不应再重复问卷 JSON / 长段说明 */
export function hasAwaitingAskClarificationTools(tools: unknown[] | null | undefined): boolean {
  if (!Array.isArray(tools)) return false
  return tools.some((t) => isAskClarificationAwaitingUser(t))
}

/** 去掉正文里误粘贴的澄清 JSON 块（侧栏 / 询问条已承载表单） */
export function stripAskClarificationLeakFromDisplayText(
  raw: string,
  tools?: unknown[] | null,
): string {
  let text = String(raw || '')
  if (!text.trim()) return ''

  for (let guard = 0; guard < 8; guard++) {
    const first = text.indexOf('{')
    if (first < 0) break
    const last = text.lastIndexOf('}')
    if (last <= first) break
    const blob = text.slice(first, last + 1)
    const parsed = tryParseClarifyPreviewJson(blob)
    if (!parsed?.questions?.length) break
    text = `${text.slice(0, first)}${text.slice(last + 1)}`.replace(/\n{3,}/g, '\n\n').trim()
  }

  if (hasAwaitingAskClarificationTools(tools) && extractAskClarificationBubbleHint(tools || [])) {
    return ''
  }
  return text.trim()
}

/** 主气泡内展示「询问」摘要（ask_clarification 在 ToolCallList 中隐藏，避免整段空白） */
export function extractAskClarificationBubbleHint(tools: unknown[]): string | null {
  if (!Array.isArray(tools)) return null
  for (const x of tools) {
    const r = x as Record<string, unknown>
    const n = String(r.name || r.tool_name || r.toolName || '').toLowerCase()
    if (n !== 'ask_clarification') continue
    const input = readAskClarificationInput(r)
    const q = typeof input?.question === 'string' ? input.question.trim() : ''
    if (q) return q
    const qs = input?.questions
    if (Array.isArray(qs) && qs.length) {
      const first = qs[0] as Record<string, unknown> | undefined
      const prompt = typeof first?.prompt === 'string' ? first.prompt.trim() : ''
      if (prompt) return prompt
    }
    const title = typeof input?.title === 'string' ? input.title.trim() : ''
    if (title) return title
    const desc = typeof input?.description === 'string' ? input.description.trim() : ''
    if (desc) return desc
    return '请在侧栏查看并选择选项'
  }
  return null
}

function formatClarifyPayloadForHosted(payload: {
  title?: string
  description?: string
  questions: Array<{
    prompt: string
    options: Array<{ label: string }>
  }>
}): string {
  const lines: string[] = []
  const title = String(payload.title || '').trim()
  if (title) lines.push(`标题：${title}`)
  const desc = String(payload.description || '').trim()
  if (desc) lines.push(desc)
  for (const q of payload.questions || []) {
    const prompt = String(q.prompt || '').trim()
    if (!prompt) continue
    lines.push('')
    lines.push(`问：${prompt}`)
    for (let i = 0; i < (q.options || []).length; i++) {
      const label = String(q.options[i]?.label || '').trim()
      if (label) lines.push(`  ${i + 1}. ${label}`)
    }
  }
  return lines.join('\n').trim()
}

function formatAskClarificationInputForHosted(input: Record<string, unknown> | null): string {
  if (!input || typeof input !== 'object') return ''
  const asJson = (() => {
    try {
      return JSON.stringify(input)
    } catch {
      return ''
    }
  })()
  const structured =
    tryParseClarifyPreviewJson(asJson) || tryParseClarifyPreviewJson(String(input.question || ''))
  if (structured?.questions?.length) return formatClarifyPayloadForHosted(structured)

  const q = typeof input.question === 'string' ? input.question.trim() : ''
  if (q) return q
  const qs = input.questions
  if (Array.isArray(qs) && qs.length) {
    const questions = qs
      .map((item, idx) => {
        const row = item as Record<string, unknown>
        const prompt =
          String(row.prompt || '').trim() || String(row.question || '').trim() || `问题 ${idx + 1}`
        const opts = coerceClarifyOptionsList(row.options)
          .map((label) => ({ label: String(label).trim() }))
          .filter((o) => o.label)
        if (opts.length < 2) return null
        return { prompt, options: opts }
      })
      .filter(Boolean) as Array<{ prompt: string; options: Array<{ label: string }> }>
    if (questions.length) return formatClarifyPayloadForHosted({ questions })
  }
  return ''
}

/**
 * 将 ask_clarification（工具调用，无扁平 assistant 正文）格式化为目标调度器可读的 EvoFlow 回复摘要。
 */
export function formatAskClarificationForHosted(
  tools: unknown[] | undefined,
  clarificationPreview?: string | null,
): string | null {
  const chunks: string[] = []

  const preview = resolveClarificationPreview({
    preview: clarificationPreview,
    tools,
  })
  if (preview) {
    const structured = tryParseClarifyPreviewJson(preview)
    if (structured?.questions?.length) {
      chunks.push(formatClarifyPayloadForHosted(structured))
    } else if (!isStaleClarificationPreview(preview)) {
      chunks.push(preview.length > 4000 ? `${preview.slice(0, 3600)}…` : preview)
    }
  }

  if (Array.isArray(tools)) {
    for (const x of tools) {
      const r = x as Record<string, unknown>
      const n = String(r.name || r.tool_name || r.toolName || '').toLowerCase()
      if (n !== 'ask_clarification') continue
      const fromInput = formatAskClarificationInputForHosted(readAskClarificationInput(r))
      if (fromInput) chunks.push(fromInput)
    }
  }

  const hint = extractAskClarificationBubbleHint(Array.isArray(tools) ? tools : [])
  if (hint && !chunks.some((c) => c.includes(hint))) chunks.unshift(hint)

  const body = [...new Set(chunks.map((c) => c.trim()).filter(Boolean))].join('\n\n')
  if (!body) return null
  return `[EvoFlow 询问 — 等待用户在对话区提交选择]\n${body}`
}
