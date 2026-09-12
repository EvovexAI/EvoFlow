/**
 * ask_clarification 是否仍「待用户填表」（与 chat-normalize / clarify-preview-resolve 共用，避免循环依赖）。
 */

export const CLARIFICATION_STALE_OUTPUT_MARKERS = [
  '[Old tool output cleared to save context space]',
  'Clarification request processed by middleware',
  '[Result from earlier conversation',
]

/** LangGraph Command(goto=END) 序列化占位，非给用户看的澄清表单 */
export function isCommandInterruptOutput(text) {
  const t = String(text || '').trim()
  if (!t.startsWith('{')) return false
  try {
    const o = JSON.parse(t)
    return !!(o && typeof o === 'object' && o.kind === 'command')
  } catch {
    return false
  }
}

function toolOutputString(out) {
  if (out == null) return ''
  if (typeof out === 'string') return out.trim()
  try {
    return JSON.stringify(out).trim()
  } catch {
    return String(out).trim()
  }
}

function isStaleAskOutputForPending(text) {
  const t = String(text || '').trim()
  if (!t) return true
  if (isCommandInterruptOutput(t)) return true
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t)
      if (o && typeof o === 'object' && (Array.isArray(o.questions) || o.question != null)) {
        return false
      }
    } catch {
      /* ignore */
    }
  }
  const lower = t.toLowerCase()
  return CLARIFICATION_STALE_OUTPUT_MARKERS.some((m) => lower.includes(m.toLowerCase()))
}

export function isAskClarificationToolPending(tool) {
  const t = tool && typeof tool === 'object' ? tool : null
  if (!t) return false
  if (String(t.name || t.tool_name || '').toLowerCase() !== 'ask_clarification') return false
  const status = String(t.status || '').toLowerCase()
  if (status === 'error' || status === 'failed' || status === 'cancelled') return false
  const outStr = toolOutputString(t.output)
  if (outStr && isCommandInterruptOutput(outStr)) return true
  if (outStr && isStaleAskOutputForPending(outStr)) return false
  if (status === 'ok' || status === 'completed' || status === 'success') return false
  if (outStr && outStr.startsWith('{')) {
    try {
      const o = JSON.parse(outStr)
      if (o && typeof o === 'object' && (Array.isArray(o.questions) || o.question != null)) {
        return false
      }
    } catch {
      /* ignore */
    }
  }
  const hasOut = outStr !== ''
  if (status === 'running' || status === 'in_progress' || status === 'pending') return true
  return !hasOut
}

function parseAskClarificationInputLoose(tool) {
  const t = tool && typeof tool === 'object' ? tool : null
  if (!t) return null
  const raw = t.input ?? t.args ?? t.arguments ?? t.kwargs
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try {
      const o = JSON.parse(raw.trim())
      if (o && typeof o === 'object' && !Array.isArray(o)) return o
    } catch {
      /* ignore */
    }
  }
  const fn = t.function
  if (fn && typeof fn === 'object' && typeof fn.arguments === 'string' && fn.arguments.trim()) {
    try {
      const o = JSON.parse(fn.arguments.trim())
      if (o && typeof o === 'object' && !Array.isArray(o)) return o
    } catch {
      /* ignore */
    }
  }
  return null
}

function askClarificationInputHasQuestionnaire(tool) {
  const input = parseAskClarificationInputLoose(tool)
  if (!input || typeof input !== 'object') return false
  const qs = input.questions
  if (Array.isArray(qs) && qs.length) return true
  const q = String(input.question || '').trim()
  const opts = input.options
  return !!(q && Array.isArray(opts) && opts.length >= 2)
}

/** ask_clarification 是否处于「等用户填表」语义（pending，或 output 已是合法问卷 JSON 等用户作答） */
export function isAskClarificationAwaitingUser(tool) {
  if (isAskClarificationToolPending(tool)) return true
  const t = tool && typeof tool === 'object' ? tool : null
  if (!t) return false
  if (String(t.name || t.tool_name || '').toLowerCase() !== 'ask_clarification') return false
  const outStr = toolOutputString(t.output)
  if (outStr && outStr.startsWith('{')) {
    try {
      const o = JSON.parse(outStr)
      if (o && typeof o === 'object' && (Array.isArray(o.questions) || o.question != null)) {
        return true
      }
    } catch {
      /* ignore */
    }
  }
  if (askClarificationInputHasQuestionnaire(t)) return true
  return false
}

/** 历史/展示行：末轮 ask 尚未结束则保留（即使本地 preview 缺失，侧栏可 API 补全） */
export function shouldKeepAskClarificationInHistory(tool, rows, rowIdx) {
  if (String(tool?.name || tool?.tool_name || '').toLowerCase() !== 'ask_clarification') return false
  if (askTurnResolvedAt(rows, rowIdx)) return false
  return true
}

/** 同行工具列表里 ask 之后是否还有其它工具（合并泡里问卷回声 + 真实续作） */
export function askIsFollowedBySiblingToolsInRow(row) {
  if (!row || typeof row !== 'object') return false
  const tools = Array.isArray(row.tools) ? row.tools : []
  let sawAsk = false
  for (const t of tools) {
    const n = String(t?.name || t?.tool_name || '').toLowerCase()
    if (n === 'ask_clarification') {
      sawAsk = true
      continue
    }
    if (sawAsk && n) return true
  }
  return false
}

/** 行内是否仍有未失败的 ask_clarification（与同排其它工具共存时仍算待作答） */
export function rowHasActiveAskClarificationTool(row) {
  if (!row || typeof row !== 'object') return false
  const tools = Array.isArray(row.tools) ? row.tools : []
  return tools.some((t) => {
    const n = String(t?.name || t?.tool_name || '').toLowerCase()
    if (n !== 'ask_clarification') return false
    const status = String(t?.status || '').toLowerCase()
    return status !== 'error' && status !== 'failed' && status !== 'cancelled'
  })
}

/** 行内是否有 ask_clarification 之外的实质内容（长文本或其他工具）— 用于判断这一轮是否已走完 */
function rowHasContentBeyondAskClarification(row) {
  if (!row || typeof row !== 'object') return false
  const text = String(row.text || '').trim()
  if (text.length > 48) return true
  const tools = Array.isArray(row.tools) ? row.tools : []
  return tools.some((t) => {
    const n = String(t?.name || t?.tool_name || '').toLowerCase()
    return n && n !== 'ask_clarification'
  })
}

function rowHasVisibleUserContent(row) {
  if (!row || row.role !== 'user') return false
  const text = String(row.text || '').trim()
  if (text) return true
  const files = Array.isArray(row.files) ? row.files : []
  if (files.length) return true
  return false
}

/** ask 行之后/同行是否已有实质后续：用户答题、真实用户回复、或 assistant 有文本/其他工具 */
function askTurnResolvedAt(rows, idx) {
  if (!Array.isArray(rows) || idx < 0) return false
  const cur = rows[idx]
  if (rowHasActiveAskClarificationTool(cur)) {
    if (askIsFollowedBySiblingToolsInRow(cur)) return true
  } else if (rowHasContentBeyondAskClarification(cur)) {
    return true
  }
  for (let i = idx + 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row || typeof row !== 'object') continue
    if (row.role === 'user' && rowHasVisibleUserContent(row)) return true
    if (row.role === 'assistant') {
      if (String(row.text || '').trim()) return true
      const tools = Array.isArray(row.tools) ? row.tools : []
      if (
        tools.some((t) => {
          const n = String(t?.name || t?.tool_name || '').toLowerCase()
          return n && n !== 'ask_clarification'
        })
      ) {
        return true
      }
    }
  }
  return false
}

/** rows 中是否存在用户答题占位（`__EVF_CLARIFY_ANS_V1__`）—— 出现即表示历史里这一问已被回答 */
function rowsHaveClarifyAnswer(rows) {
  if (!Array.isArray(rows)) return false
  for (const row of rows) {
    if (!row || row.role !== 'user') continue
    const t = String(row.text || '').trim()
    if (t.startsWith('__EVF_CLARIFY_ANS')) return true
  }
  return false
}

/** 历史/展示行：去掉已结束的 ask_clarification，避免合并行残留问卷回显 */
export function stripResolvedAskClarificationFromRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return rows
  return rows.map((row, idx) => {
    if (!row || row.role !== 'assistant' || !Array.isArray(row.tools) || !row.tools.length) {
      return row
    }
    // 同行 / 后续行已有实质内容（用户答题、真实回复、其他工具/文本）→ 这一轮已走完，剥掉 ask；
    // 否则保留仍处于「等用户填表」语义的 ask（含 output 合法问卷 JSON 的 ok 态），让侧栏面板能恢复表单。
    // 注意：不能用「历史中出现过 __EVF_CLARIFY_ANS 就全局标记所有 ask 已解决」的逻辑，
    // 否则同一会话中第二次 ask_clarification 会被误剥除，导致侧栏不显示。
    const turnResolved = askTurnResolvedAt(rows, idx)
    const kept = row.tools.filter((tool) => {
      const nm = String(tool?.name || tool?.tool_name || '').toLowerCase()
      if (nm !== 'ask_clarification') return true
      if (turnResolved) return false
      // 未结束的 ask 一律保留，侧栏可凭 toolCallId 走 API 补全问卷
      return true
    })
    if (kept.length === row.tools.length) return row
    const next = { ...row, tools: kept }
    if (Array.isArray(row.segments)) {
      const keptIds = new Set(
        kept.map((t) => String(t?.id || t?.tool_call_id || '').trim()).filter(Boolean),
      )
      next.segments = row.segments.filter((seg) => {
        if (!seg || seg.kind !== 'tools' || !Array.isArray(seg.ids)) return true
        const ids = seg.ids.filter((id) => keptIds.has(String(id || '').trim()))
        return ids.length > 0
      })
    }
    return next
  })
}
