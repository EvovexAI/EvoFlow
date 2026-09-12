/**
 * ClarificationConfirmDock — ask_clarification 的独立确认 Dock 组件。
 *
 * 参照 PlanExecConfirmDock 架构：自包含所有解析 + 渲染 + 提交逻辑，
 * 由 ChatApp 顶层挂载，替代原先散落在 ThreadPanel / SessionSidebar / MessageRow 的渲染。
 *
 * 数据流：
 *   ChatApp threadPanelState.clarification → props(preview, toolCallId)
 *   → 内部 parseStructuredClarification 解析 → 渲染选项卡片
 *   → 用户选择 → onSubmit(__EVF_CLARIFY_ANS_V1__ payload)
 */
import { useMemo, useRef, useState } from 'react'
import { coerceClarifyOptionsList, isStaleClarificationPreview } from '../lib/clarify-chat-display.js'

// === Types ===

type ClarifyOption = { id: string; label: string }

type ClarifyQuestion = {
  id: string
  prompt: string
  options: ClarifyOption[]
  allow_multiple?: boolean
}

type ClarifyPayload = { title?: string; description?: string; questions: ClarifyQuestion[] }

// === Constants ===

const CLARIFY_OPTION_BADGE_STYLE: 'numeric' | 'alpha' = 'numeric'

const CLARIFY_GENERIC_TITLES = new Set([
  '补充关键信息',
  '需求待确认',
  '方案选择',
  '风险确认',
  '请确认建议',
  '请确认',
])

/** 单题选项数达到该阈值时，选项区使用更高布局（见 react-chat.css） */
export const CLARIFY_MANY_OPTIONS_THRESHOLD = 5

// === Helper functions (migrated from ThreadPanel.tsx) ===

function normalizeClarifyCardTitle(raw: unknown): string | undefined {
  const t = String(raw || '').trim()
  if (!t || CLARIFY_GENERIC_TITLES.has(t)) return undefined
  return t
}

function formatClarifyOptionBadge(indexZeroBased: number): string {
  if (CLARIFY_OPTION_BADGE_STYLE === 'alpha') {
    const n = indexZeroBased
    if (n >= 0 && n < 26) return `${String.fromCharCode(65 + n)}.`
    return `${n + 1}.`
  }
  return `${indexZeroBased + 1}.`
}

/** 去掉模型擅加的 ① / 1. /（A）等前缀（不含单行首字母项，以免误伤正文） */
function stripNonLetterEnumerations(raw: string): string {
  let t = String(raw || '').trim()
  for (let i = 0; i < 8; i++) {
    const circled = t.match(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*(.+)$/)
    if (circled) {
      t = circled[1].trim()
      continue
    }
    const num = t.match(/^\d{1,2}[.．、:：]\s*(.+)$/)
    if (num) {
      t = num[1].trim()
      continue
    }
    const fw = t.match(/^[０-９]{1,2}[．.]\s*(.+)$/)
    if (fw) {
      t = fw[1].trim()
      continue
    }
    const paren = t.match(/^[（(]\s*[A-Za-z]\s*[）)]\s*(.+)$/)
    if (paren) {
      t = paren[1].trim()
      continue
    }
    break
  }
  return t
}

/** 去掉单行首的「A.」类字母序号，返回字母（若有）与剩余正文 */
function peelLeadingLetterEnum(label: string): { letter: string | null; rest: string } {
  const s = stripNonLetterEnumerations(label)
  const m = s.match(/^([A-Za-z])[.．]\s*(.+)$/)
  if (m && m[2].trim()) return { letter: m[1].toUpperCase(), rest: m[2].trim() }
  return { letter: null, rest: s }
}

/** 去掉「A. A —」、模型自带的字母/数字序号，得到纯方案文案（前端另加统一序号徽标） */
function cleanClarifyOptionLabel(raw: string): string {
  let s = stripNonLetterEnumerations(String(raw || '').trim())
  if (!s) return s
  const dupLetter = s.match(/^([A-Za-z])[.．]\s*\1\s*[—\-–]\s*(.+)$/i)
  if (dupLetter) s = dupLetter[2].trim()
  else {
    const dash = s.match(/^([A-Za-z])[.．]\s*[—\-–]\s*(.+)$/i)
    if (dash) s = dash[2].trim()
    else {
      const dot = s.match(/^([A-Za-z])[.．]\s+(.+)$/i)
      if (dot) s = dot[2].trim()
    }
  }
  s = stripNonLetterEnumerations(s)
  for (let i = 0; i < 3; i++) {
    const peeled = peelLeadingLetterEnum(s)
    if (!peeled.letter) break
    s = peeled.rest
    s = stripNonLetterEnumerations(s)
  }
  return s.trim()
}

/**
 * 将「单题 + A–I 扁平选项」拆成研究方向 / 深度 / 产出（启发式，兼容旧 payload）。
 * 在文案规范化之前调用；分组时会先用 peelLeadingLetterEnum 剥掉 1./A. 等前缀再识别。
 */
function splitFlatLegacyOptionsIntoQuestions(options: ClarifyOption[]): ClarifyQuestion[] | null {
  if (!Array.isArray(options) || options.length < 5) return null

  const direction: ClarifyOption[] = []
  const depth: ClarifyOption[] = []
  const output: ClarifyOption[] = []

  for (const opt of options) {
    const L = opt.label
    const { letter, rest } = peelLeadingLetterEnum(L)
    const body = rest.trim()

    if (letter && letter >= 'A' && letter <= 'D') {
      direction.push(opt)
      continue
    }
    if (letter === 'I' || /其他/.test(body)) {
      direction.push(opt)
      continue
    }
    if (letter === 'E' || letter === 'F' || /^深度/.test(body)) {
      depth.push(opt)
      continue
    }
    if (letter === 'G' || letter === 'H' || /^产出/.test(body)) {
      output.push(opt)
      continue
    }
    if (/深度/.test(body)) depth.push(opt)
    else if (/产出|Markdown|HTML/i.test(body)) output.push(opt)
    else direction.push(opt)
  }

  const qs: ClarifyQuestion[] = []
  if (direction.length >= 2) {
    qs.push({
      id: 'clarify_direction',
      prompt: '研究方向（可多选）',
      options: direction,
      allow_multiple: true,
    })
  }
  if (depth.length >= 2) {
    qs.push({
      id: 'clarify_depth',
      prompt: '研究深度',
      options: depth,
      allow_multiple: false,
    })
  }
  if (output.length >= 2) {
    qs.push({
      id: 'clarify_output',
      prompt: '产出形式',
      options: output,
      allow_multiple: false,
    })
  }

  return qs.length >= 2 ? qs : null
}

function mapCleanLabels(qs: ClarifyQuestion[]): ClarifyQuestion[] {
  return qs.map((q) => ({
    ...q,
    options: q.options.map((o) => ({ ...o, label: cleanClarifyOptionLabel(o.label) })),
  }))
}

/** 单题且选项很多时尝试拆分；否则仅统一清理选项文案 */
function maybeSplitBulkyQuestions(payload: ClarifyPayload): ClarifyPayload {
  if (payload.questions.length === 1) {
    const q = payload.questions[0]
    if (q.options.length >= 6) {
      const split = splitFlatLegacyOptionsIntoQuestions(q.options)
      if (split && split.length >= 2) {
        return {
          ...payload,
          description: payload.description ?? q.prompt,
          questions: mapCleanLabels(split),
        }
      }
    }
  }
  return { ...payload, questions: mapCleanLabels(payload.questions) }
}

function normalizeOptions(raw: unknown): ClarifyOption[] {
  const labels = coerceClarifyOptionsList(raw)
  const optionsRaw =
    labels.length > 0
      ? labels
      : Array.isArray(raw)
        ? raw
        : []
  const options: ClarifyOption[] = optionsRaw
    .map((o: unknown, idx: number) => {
      if (typeof o === 'string') {
        const label = String(o || '').trim()
        if (!label) return null
        return { id: `opt_${idx + 1}`, label }
      }
      const oid = String(o?.id || '').trim() || `opt_${idx + 1}`
      const label = String(o?.label || '').trim()
      if (!label) return null
      return { id: oid, label }
    })
    .filter(Boolean) as ClarifyOption[]
  return options
}

function tryParseClarifyPayload(raw: string): ClarifyPayload | null {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    // Legacy clarification format compatibility:
    // {"question":"...","options":[...],"clarification_type":"...","context":"..."}
    const p = parsed as Record<string, unknown>
    const legacyQuestion = String(p.question || '').trim()
    if (legacyQuestion) {
      const legacyContext = String(p.context || '').trim()
      const prompt = legacyContext ? `${legacyContext}\n${legacyQuestion}` : legacyQuestion
      const rawOpts = normalizeOptions(p.options)
      const split = rawOpts.length >= 6 ? splitFlatLegacyOptionsIntoQuestions(rawOpts) : null
      if (split && split.length >= 2) {
        return {
          title: normalizeClarifyCardTitle(p.title),
          description: prompt,
          questions: mapCleanLabels(split),
        }
      }
      return {
        title: normalizeClarifyCardTitle(p.title),
        questions: [
          {
            id: String(p.id || 'q1').trim() || 'q1',
            prompt,
            options: rawOpts.map((o) => ({ ...o, label: cleanClarifyOptionLabel(o.label) })),
            allow_multiple: !!p.allow_multiple,
          },
        ],
      }
    }
    // {"prompt":"...","options":[...]}（无 question 字段）
    const legacyPrompt = String(p.prompt || '').trim()
    if (legacyPrompt && Array.isArray(p.options)) {
      const rawOpts = normalizeOptions(p.options)
      const split = rawOpts.length >= 6 ? splitFlatLegacyOptionsIntoQuestions(rawOpts) : null
      if (split && split.length >= 2) {
        return {
          title: normalizeClarifyCardTitle(p.title),
          description: legacyPrompt,
          questions: mapCleanLabels(split),
        }
      }
      return {
        title: normalizeClarifyCardTitle(p.title),
        questions: [
          {
            id: String(p.id || 'q1').trim() || 'q1',
            prompt: legacyPrompt,
            options: rawOpts.map((o) => ({ ...o, label: cleanClarifyOptionLabel(o.label) })),
            allow_multiple: !!p.allow_multiple,
          },
        ],
      }
    }
    const questions = Array.isArray(p.questions) ? p.questions : []
    const normalized: ClarifyQuestion[] = questions
      .map((q: Record<string, unknown>, idx: number) => {
        const id = String(q?.id || '').trim() || `q${idx + 1}`
        const prompt =
          String(q?.prompt || '')
            .trim() ||
          String(q?.question || '')
            .trim()
        const options = normalizeOptions(q?.options)
        if (!prompt || options.length < 2) return null
        return {
          id,
          prompt,
          options,
          allow_multiple: !!q?.allow_multiple,
        }
      })
      .filter(Boolean) as ClarifyQuestion[]
    if (!normalized.length) return null
    return maybeSplitBulkyQuestions({
      title: normalizeClarifyCardTitle(p.title),
      questions: normalized,
    })
  } catch {
    return null
  }
}

export function maxClarifyOptionsPerQuestion(payload: ClarifyPayload | null | undefined): number {
  if (!payload?.questions?.length) return 0
  let max = 0
  for (const q of payload.questions) {
    const n = Array.isArray(q.options) ? q.options.length : 0
    if (n > max) max = n
  }
  return max
}

export function parseStructuredClarification(preview: string | undefined): ClarifyPayload | null {
  const raw = String(preview || '').trim()
  if (!raw) return null
  const direct = tryParseClarifyPayload(raw)
  if (direct) return direct

  // Some tool outputs are wrapped like: "参数...结果 { ...json... }"
  const firstBrace = raw.indexOf('{')
  const lastBrace = raw.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const maybeJson = raw.slice(firstBrace, lastBrace + 1).trim()
    const wrapped = tryParseClarifyPayload(maybeJson)
    if (wrapped) return wrapped
  }
  return null
}

// === Component ===

export type ClarificationConfirmProps = {
  /** ask_clarification 预览 JSON 字符串（来自 threadPanelState.clarification.preview） */
  preview?: string
  /** 工具调用 ID（用于 form key 重置） */
  toolCallId?: string
  /** 提交中禁用 */
  busy?: boolean
  /** 用户提交选择回调，接收 __EVF_CLARIFY_ANS_V1__ 协议文本 */
  onSubmit: (answerText: string) => void
}

/**
 * ask_clarification 独立确认 Dock。
 *
 * 由 ChatApp 顶层挂载（与 PlanExecConfirm / GoalProposalDock 并列），
 * 自管选项选择状态与提交逻辑，替代原先散落在 ThreadPanel + SessionSidebar 的渲染。
 */
export function ClarificationConfirmDock({
  preview,
  toolCallId,
  busy = false,
  onSubmit,
}: ClarificationConfirmProps) {
  const structured = useMemo(
    () => parseStructuredClarification(preview),
    [preview],
  )
  const staleClarifyPreview = useMemo(
    () => isStaleClarificationPreview(preview),
    [preview],
  )
  const showClarify = !!(structured || staleClarifyPreview)
  const maxOptionsPerQuestion = useMemo(
    () => maxClarifyOptionsPerQuestion(structured),
    [structured],
  )
  const manyOptionsLayout = maxOptionsPerQuestion >= CLARIFY_MANY_OPTIONS_THRESHOLD

  const [selectedByQuestion, setSelectedByQuestion] = useState<Record<string, string[]>>({})
  const [extraText, setExtraText] = useState('')

  const clarificationKey = useMemo(
    () => JSON.stringify({ id: toolCallId || '', preview: preview || '' }),
    [preview, toolCallId],
  )

  // Reset form state when a new clarification prompt arrives (render-time reset, avoids set-state-in-effect)
  const prevKeyRef = useRef(clarificationKey)
  // eslint-disable-next-line react-hooks/refs
  if (prevKeyRef.current !== clarificationKey) {
    // eslint-disable-next-line react-hooks/refs
    prevKeyRef.current = clarificationKey
    setSelectedByQuestion({})
    setExtraText('')
  }

  const canSubmitStructured = useMemo(() => {
    if (!structured || busy) return false
    return structured.questions.every((q) => {
      const picks = selectedByQuestion[q.id] || []
      return picks.length > 0
    })
  }, [busy, selectedByQuestion, structured])

  if (!showClarify) return null

  function updateSelection(question: ClarifyQuestion, optionId: string, checked: boolean) {
    setSelectedByQuestion((prev) => {
      const cur = Array.isArray(prev[question.id]) ? prev[question.id] : []
      if (question.allow_multiple) {
        const next = checked ? Array.from(new Set([...cur, optionId])) : cur.filter((x) => x !== optionId)
        return { ...prev, [question.id]: next }
      }
      return { ...prev, [question.id]: checked ? [optionId] : [] }
    })
  }

  function submitStructuredClarification() {
    if (!structured || busy) return
    const answers = structured.questions.map((q) => {
      const selectedOptionIds = selectedByQuestion[q.id] || []
      const selectedLabels = q.options
        .filter((opt) => new Set(selectedOptionIds).has(opt.id))
        .map((opt) => opt.label)
      return {
        question_id: q.id,
        selected_option_ids: selectedOptionIds,
        selected_option_labels: selectedLabels,
      }
    })
    const payload = {
      answers,
      free_text: String(extraText || '').trim() || undefined,
    }
    onSubmit(`__EVF_CLARIFY_ANS_V1__: ${JSON.stringify(payload)}`)
    setExtraText('')
    setSelectedByQuestion({})
  }

  return (
    <div className="react-chat-clarify-confirm-dock" role="region" aria-label="询问确认">
      <div className="react-chat-clarify-confirm-dock-accent" aria-hidden="true" />
      <div className="react-chat-clarify-confirm-dock-inner">
        {structured ? (
          <div
            className={`react-chat-subtask-card react-chat-clarify-card${
              structured.questions.length >= 2 ? ' react-chat-clarify-card--matrix' : ''
            }${manyOptionsLayout ? ' react-chat-clarify-card--many-options' : ''}`}
          >
            <div className="react-chat-clarify-card-body">
              {structured.title ? (
                <div className="react-chat-clarify-card-header">
                  <div className="react-chat-clarify-card-title">{structured.title}</div>
                </div>
              ) : null}
              {structured.description ? (
                <div className="react-chat-clarify-card-description">{structured.description}</div>
              ) : null}
              <div
                className={
                  structured.questions.length >= 2 ? 'react-chat-thread-clarify-questions-grid' : undefined
                }
              >
                {structured.questions.map((q) => (
                  <div
                    key={q.id}
                    className={`react-chat-thread-clarify-question${
                      structured.questions.length >= 2 ? ' react-chat-thread-clarify-question--tile' : ''
                    }`}
                  >
                    <div className="react-chat-thread-clarify-question-prompt">{q.prompt}</div>
                    <div
                      className={`react-chat-thread-clarify-options${
                        manyOptionsLayout && q.options.length >= CLARIFY_MANY_OPTIONS_THRESHOLD
                          ? ' react-chat-thread-clarify-options--scroll'
                          : ''
                      }`}
                    >
                      {q.options.map((opt, optIdx) => {
                        const picked = (selectedByQuestion[q.id] || []).includes(opt.id)
                        const badge = formatClarifyOptionBadge(optIdx)
                        return (
                          <label
                            key={opt.id}
                            className={`react-chat-thread-clarify-option${picked ? ' is-selected' : ''}`}
                            title={opt.label}
                          >
                            <input
                              type={q.allow_multiple ? 'checkbox' : 'radio'}
                              name={`clarify-${q.id}`}
                              checked={picked}
                              onChange={(e) => updateSelection(q, opt.id, e.target.checked)}
                            />
                            <span className="react-chat-thread-clarify-option-indicator" aria-hidden />
                            <span className="react-chat-thread-clarify-option-prefix">{badge}</span>
                            <span className="react-chat-thread-clarify-option-label">{opt.label}</span>
                          </label>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
              <div className="react-chat-clarify-input-row">
                <textarea
                  className="react-chat-thread-clarify-extra"
                  rows={1}
                  placeholder="补充说明（可选）"
                  value={extraText}
                  onChange={(e) => setExtraText(e.target.value)}
                />
                <button
                  type="button"
                  className="react-chat-thread-clarify-submit"
                  onClick={submitStructuredClarification}
                  disabled={!canSubmitStructured}
                  title={!canSubmitStructured ? (busy ? '提交中…' : '请先完成所有问题选择') : '提交'}
                >
                  {busy ? '提交中…' : '提交'}
                </button>
              </div>
            </div>
          </div>
        ) : staleClarifyPreview ? (
          <div className="react-chat-subtask-card react-chat-clarify-card">
            <div className="react-chat-clarify-card-body">
              <p className="react-chat-clarify-fallback-hint">
                模型正在等待你的回复。请查看主对话里的「询问」说明，在底部输入框作答；若气泡里已有选项，以气泡为准。
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
