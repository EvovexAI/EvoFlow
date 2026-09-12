/**
 * ask_clarification 预览解析（侧栏 / thread_state / 历史恢复）。
 * 优先 tool call 入参；ToolMessage 被 context compaction 替换为占位符时仍能还原表单。
 */
import { getToolInputObject, isInjectedCheckpointHuman } from './chat-normalize.js'
import {
  CLARIFICATION_STALE_OUTPUT_MARKERS,
  isAskClarificationAwaitingUser,
  isAskClarificationToolPending,
  isCommandInterruptOutput,
  askIsFollowedBySiblingToolsInRow,
  rowHasActiveAskClarificationTool,
} from './ask-clarification-pending.js'

export {
  CLARIFICATION_STALE_OUTPUT_MARKERS,
  isAskClarificationToolPending,
  isCommandInterruptOutput,
  askIsFollowedBySiblingToolsInRow,
  rowHasActiveAskClarificationTool,
}

/** 模型常把 options 传成 JSON 字符串而非数组 */
export function coerceClarifyOptionsList(raw) {
  if (raw == null) return []
  if (Array.isArray(raw)) {
    const out = []
    for (const item of raw) {
      if (typeof item === 'string') {
        const label = item.trim()
        if (label) out.push(label)
      } else if (item && typeof item === 'object') {
        const label = String(item.label || item.text || '').trim()
        if (label) out.push(label)
      }
    }
    return out
  }
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (!s) return []
    if (s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s)
        if (Array.isArray(parsed)) return coerceClarifyOptionsList(parsed)
      } catch {
        /* fall through */
      }
    }
    if (s.includes('|')) {
      return s
        .split('|')
        .map((x) => x.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    }
    if (s.includes(',') || s.includes('，') || s.includes(';') || s.includes('；')) {
      return s
        .split(/[,，;；]+/)
        .map((x) => x.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    }
    return [s.replace(/^["']|["']$/g, '')].filter(Boolean)
  }
  return []
}

export function tryParseClarifyPreviewJson(raw) {
  const text = String(raw || '').trim()
  if (!text) return null
  const candidates = [text]
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1))
  for (const cand of candidates) {
    try {
      const parsed = JSON.parse(cand)
      if (!parsed || typeof parsed !== 'object') continue
      const legacyQ = String(parsed.question || '').trim()
      if (legacyQ) {
        const opts = coerceClarifyOptionsList(parsed.options)
          .map((label) => ({ label: String(label).trim() }))
          .filter((o) => o.label)
        if (opts.length >= 2) {
          return {
            title: String(parsed.title || '').trim() || undefined,
            description: String(parsed.context || '').trim() || undefined,
            questions: [{ prompt: legacyQ, options: opts }],
          }
        }
      }
      const qs = Array.isArray(parsed.questions) ? parsed.questions : []
      const questions = qs
        .map((item, idx) => {
          const row = item && typeof item === 'object' ? item : {}
          const prompt =
            String(row.prompt || '').trim() || String(row.question || '').trim() || `问题 ${idx + 1}`
          const options = coerceClarifyOptionsList(row.options)
            .map((label) => ({ label: String(label).trim() }))
            .filter((o) => o.label)
          if (options.length < 2) return null
          return { prompt, options }
        })
        .filter(Boolean)
      if (questions.length) {
        return {
          title: String(parsed.title || '').trim() || undefined,
          description: String(parsed.description || '').trim() || undefined,
          questions,
        }
      }
    } catch {
      /* try next */
    }
  }
  return null
}

function questionHasBody(q) {
  const row = q && typeof q === 'object' ? q : {}
  const prompt = String(row.prompt || row.question || '').trim()
  const opts = coerceClarifyOptionsList(row.options)
  return !!prompt && opts.length >= 2
}

function fixPromptDoubledQuotes(chunk) {
  return String(chunk || '')
    .replace(/("(?:prompt|context|question)":\s*)""([^"]+?)""/g, '$1"$2"')
    .replace(/("(?:prompt|context|question)":\s*)""([^"]+?)"([^",}\]]+)"'/g, '$1"$2$3"')
}

function wrapBlobObject(part) {
  let p = String(part || '').trim().replace(/^\[+|\]+$/g, '')
  if (p.startsWith(':')) p = `{"id"${p}`
  else if (!p.startsWith('{')) p = `{${p}`
  if (!/\}$/.test(p.trim())) {
    let q = p.trim().replace(/,+$/, '')
    const openBrackets = (q.match(/\[/g) || []).length
    const closeBrackets = (q.match(/\]/g) || []).length
    if (openBrackets > closeBrackets) q += ']'.repeat(openBrackets - closeBrackets)
    if (!q.endsWith('}')) q += '}'
    p = q
  }
  return fixPromptDoubledQuotes(p)
}

function regexExtractQuestion(chunk) {
  const idMatch = chunk.match(/"id"\s*:\s*"([^"]*)"/) || chunk.match(/:\s*"([^"]*)"/)
  const promptMatch =
    chunk.match(/"prompt"\s*:\s*"((?:[^"\\]|\\.)*)"/) ||
    chunk.match(/"question"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  let prompt = promptMatch ? promptMatch[1].trim() : ''
  if (!prompt) {
    const loose = chunk.match(/"prompt"\s*:\s*""([^"]+?)"([^",}\]]+)"/)
    if (loose) prompt = `${loose[1]}${loose[2]}`.trim()
  }
  const contextMatch = chunk.match(/"context"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  const optionsMatch = chunk.match(/"options"\s*:\s*(\[[^\]]*\])/)
  let options = []
  if (optionsMatch) {
    try {
      const parsed = JSON.parse(fixPromptDoubledQuotes(optionsMatch[1]))
      if (Array.isArray(parsed)) options = parsed
    } catch {
      /* ignore */
    }
  }
  if (!prompt || options.length < 2) return null
  const out = { prompt, options }
  if (idMatch?.[1]?.trim()) out.id = idMatch[1].trim()
  if (contextMatch?.[1]?.trim()) out.context = contextMatch[1].trim()
  return out
}

export function parseQuestionsJsonBlob(blob) {
  const raw = String(blob || '').trim()
  if (raw.length < 12) return []
  if (!raw.includes('prompt') && !raw.includes('options')) return []

  const inner = raw.replace(/^\[+|\]+$/g, '')
  const parts = inner.split(/\}\s*,\s*\{/)
  const objs = []
  for (let i = 0; i < parts.length; i++) {
    let chunk = wrapBlobObject(parts[i])
    if (i > 0 && !chunk.trim().startsWith('{')) chunk = `{${chunk.trim()}`
    try {
      const parsed = JSON.parse(chunk)
      if (parsed && typeof parsed === 'object' && questionHasBody(parsed)) {
        objs.push(parsed)
        continue
      }
    } catch {
      /* fall through */
    }
    const extracted = regexExtractQuestion(chunk)
    if (extracted) objs.push(extracted)
  }
  if (objs.length) return objs

  const wrapped = raw.startsWith('[') ? fixPromptDoubledQuotes(raw) : `[${wrapBlobObject(raw)}]`
  try {
    const parsed = JSON.parse(wrapped)
    if (Array.isArray(parsed)) {
      return parsed.filter((x) => x && typeof x === 'object' && questionHasBody(x))
    }
  } catch {
    /* ignore */
  }
  return []
}

export function repairClarifyQuestionsFromArgs(args) {
  if (!args || typeof args !== 'object') return args
  const qs = args.questions
  if (!Array.isArray(qs) || !qs.length) return args

  const repaired = []
  let hoistedTitle = String(args.title || '').trim()
  for (const q of qs) {
    if (!q || typeof q !== 'object') continue
    if (questionHasBody(q)) {
      repaired.push(q)
      continue
    }
    const titleOnRow = String(q.title || '').trim()
    if (titleOnRow && !hoistedTitle) hoistedTitle = titleOnRow
    const blob = String(q.id || '').trim()
    if (blob.length >= 12 && (blob.includes('prompt') || blob.includes('options'))) {
      const expanded = parseQuestionsJsonBlob(blob)
      if (expanded.length) {
        repaired.push(...expanded)
        continue
      }
    }
    const prompt = String(q.prompt || q.question || '').trim()
    if (prompt) repaired.push(q)
  }
  if (qs.length === 1 && !hoistedTitle) {
    const onlyTitle = String(qs[0]?.title || '').trim()
    if (onlyTitle) hoistedTitle = onlyTitle
  }
  return {
    ...args,
    ...(hoistedTitle ? { title: hoistedTitle } : {}),
    questions: repaired.length ? repaired : qs,
  }
}

function clarifyPromptFromRow(row) {
  const prompt = String(row.prompt || row.question || '').trim()
  const ctx = String(row.context || '').trim()
  if (ctx && prompt) return `${ctx}\n${prompt}`.trim()
  return prompt || ctx || ''
}

export function isStaleClarificationPreview(text) {
  const t = String(text || '').trim()
  if (!t) return true
  if (isCommandInterruptOutput(t)) return true
  if (tryParseClarifyPreviewJson(t)) return false
  const lower = t.toLowerCase()
  return CLARIFICATION_STALE_OUTPUT_MARKERS.some((m) => lower.includes(m.toLowerCase()))
}

export function clarificationPreviewJsonFromToolArgs(args) {
  if (!args || typeof args !== 'object') return null
  const repaired = repairClarifyQuestionsFromArgs(args)
  const qs = repaired.questions
  if (Array.isArray(qs) && qs.length) {
    const questions = qs
      .map((item) => {
        const row = item && typeof item === 'object' ? item : {}
        const prompt = clarifyPromptFromRow(row)
        const options = coerceClarifyOptionsList(row.options)
          .map((label) => ({ label: String(label).trim() }))
          .filter((o) => o.label)
        if (!prompt || options.length < 2) return null
        return { prompt, options }
      })
      .filter(Boolean)
    if (!questions.length) return null
    try {
      return JSON.stringify({
        title: repaired.title || '',
        questions,
      })
    } catch {
      return null
    }
  }
  const question = String(args.question || '').trim()
  if (!question) return null
  const options = coerceClarifyOptionsList(args.options)
  if (options.length < 2) return null
  try {
    return JSON.stringify({
      title: args.title || '',
      question,
      context: args.context || '',
      options,
      clarification_type: args.clarification_type,
    })
  } catch {
    return null
  }
}

export function readAskClarificationInput(tool) {
  if (!tool || typeof tool !== 'object') return null
  const fromInput = getToolInputObject(tool.input)
  if (fromInput && Object.keys(fromInput).length > 0) return fromInput
  const fn = tool.function
  if (fn && typeof fn === 'object') {
    const args = fn.arguments
    if (typeof args === 'string' && args.trim()) {
      try {
        const o = JSON.parse(args.trim())
        if (o && typeof o === 'object' && !Array.isArray(o)) return o
      } catch {
        /* ignore */
      }
    }
  }
  const rawArgs = tool.args
  if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) return rawArgs
  if (typeof rawArgs === 'string' && rawArgs.trim()) {
    try {
      const o = JSON.parse(rawArgs.trim())
      if (o && typeof o === 'object' && !Array.isArray(o)) return o
    } catch {
      /* ignore */
    }
  }
  return fromInput
}

export function resolveClarificationPreview({ preview, tools } = {}) {
  const rawPreview = String(preview || '').trim()
  let fromArgsFallback = ''
  if (Array.isArray(tools)) {
    for (const x of tools) {
      const r = x && typeof x === 'object' ? x : null
      if (!r) continue
      const n = String(r.name || r.tool_name || r.toolName || '').toLowerCase()
      if (n !== 'ask_clarification') continue
      const out = r.output ?? r.content
      const outText =
        typeof out === 'string' ? out.trim() : out != null ? JSON.stringify(out) : ''
      if (
        outText &&
        !isStaleClarificationPreview(outText) &&
        !isCommandInterruptOutput(outText) &&
        tryParseClarifyPreviewJson(outText)
      ) {
        return outText
      }
      const input = readAskClarificationInput(r)
      const fromArgs = clarificationPreviewJsonFromToolArgs(input)
      if (fromArgs && tryParseClarifyPreviewJson(fromArgs) && !fromArgsFallback) {
        fromArgsFallback = fromArgs
      }
    }
  }
  if (fromArgsFallback) return fromArgsFallback
  if (rawPreview && !isStaleClarificationPreview(rawPreview) && !isCommandInterruptOutput(rawPreview)) {
    if (tryParseClarifyPreviewJson(rawPreview)) return rawPreview
  }
  return ''
}

/** 侧栏/ThreadPanel 可展示为选项表单（至少一题且每题 ≥2 个选项） */
export function isClarificationPreviewRenderable(preview) {
  const raw = String(preview || '').trim()
  if (!raw) return false
  if (isStaleClarificationPreview(raw) || isCommandInterruptOutput(raw)) return false
  if (tryParseClarifyPreviewJson(raw)) return true
  if (raw.startsWith('{')) {
    try {
      const o = JSON.parse(raw)
      const repaired = clarificationPreviewJsonFromToolArgs(o)
      if (repaired && tryParseClarifyPreviewJson(repaired)) return true
    } catch {
      /* ignore */
    }
  }
  return false
}

export function clarificationPreviewFromTool(tool) {
  const t = tool && typeof tool === 'object' ? tool : null
  if (!t) return null
  const name = String(t.name || t.tool_name || t.toolName || '').toLowerCase()
  if (name !== 'ask_clarification') return null
  const preview = resolveClarificationPreview({ tools: [t] })
  if (!preview || !isClarificationPreviewRenderable(preview)) return null
  const toolCallId = String(t.id || t.tool_call_id || '').trim() || undefined
  return { toolCallId, preview }
}

function parseToolCallArgs(tc) {
  if (!tc || typeof tc !== 'object') return null
  if (tc.args && typeof tc.args === 'object' && !Array.isArray(tc.args)) return tc.args
  if (typeof tc.args === 'string' && tc.args.trim()) {
    try {
      const o = JSON.parse(tc.args.trim())
      if (o && typeof o === 'object' && !Array.isArray(o)) return o
    } catch {
      /* ignore */
    }
  }
  const fn = tc.function
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

function askClarificationFromAssistantMessage(m) {
  if (!m || typeof m !== 'object') return null
  const calls = m.tool_calls || m.toolCalls
  if (!Array.isArray(calls)) return null
  for (const tc of calls) {
    const name = tc?.name || tc?.function?.name
    if (name !== 'ask_clarification') continue
    const args = parseToolCallArgs(tc)
    const preview = clarificationPreviewJsonFromToolArgs(args)
    if (preview) {
      return { toolCallId: tc.id || tc.tool_call_id, preview: preview.slice(0, 2000) }
    }
  }
  return null
}

function askClarificationFromToolMessage(m) {
  if (!m || typeof m !== 'object') return null
  const name = m.name || m.tool_name
  if (name !== 'ask_clarification') return null
  let contentPreview = ''
  if (typeof m.content === 'string') contentPreview = m.content
  else if (m.content != null) {
    try {
      contentPreview = JSON.stringify(m.content)
    } catch {
      contentPreview = String(m.content)
    }
  }
  const preview = resolveClarificationPreview({
    preview: contentPreview,
    tools: [{ name: 'ask_clarification', output: m.content, content: m.content }],
  })
  if (!preview) return null
  return { toolCallId: m.tool_call_id, preview: preview.slice(0, 2000) }
}

function rowHasSubstantiveReplyBeyondClarifyTool(row) {
  if (!row || typeof row !== 'object') return false
  const text = String(row.text || '').trim()
  if (text.length > 48) return true
  const tools = Array.isArray(row.tools) ? row.tools : []
  return tools.some((t) => {
    const n = String(t?.name || t?.tool_name || '').toLowerCase()
    return n && n !== 'ask_clarification'
  })
}

export function displayRowHasVisibleContent(row) {
  if (!row || typeof row !== 'object') return false
  if (String(row.text || '').trim()) return true
  if (Array.isArray(row.tools) && row.tools.length) return true
  if (Array.isArray(row.images) && row.images.length) return true
  if (Array.isArray(row.videos) && row.videos.length) return true
  if (Array.isArray(row.audios) && row.audios.length) return true
  if (Array.isArray(row.files) && row.files.length) return true
  return false
}

export function lastRealUserRowIndex(rows) {
  if (!Array.isArray(rows)) return -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]?.role === 'user' && displayRowHasVisibleContent(rows[i])) return i
  }
  return -1
}

function lastUserClarifyAnswerRowIndex(rows) {
  if (!Array.isArray(rows)) return -1
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row?.role !== 'user') continue
    const t = String(row.text || '').trim()
    if (t.startsWith('__EVF_CLARIFY_ANS')) return i
  }
  return -1
}

function rowHasAwaitingClarificationForm(tools) {
  if (!Array.isArray(tools)) return false
  for (const tool of tools) {
    const nm = String(tool?.name || tool?.tool_name || '').toLowerCase()
    if (nm !== 'ask_clarification') continue
    if (isAskClarificationToolPending(tool)) return true
    if (isAskClarificationAwaitingUser(tool)) return true
    const preview = resolveClarificationPreview({ tools: [tool] })
    if (preview && isClarificationPreviewRenderable(preview)) return true
  }
  return false
}

/** 询问行之后已有用户回复或 assistant 实质回复 → 不再恢复侧栏表单 */
export function isClarificationTurnResolvedInRows(rows, clarifyAssistantRowIdx) {
  if (!Array.isArray(rows) || clarifyAssistantRowIdx < 0) return false
  const lastUserIdx = lastRealUserRowIndex(rows)
  if (lastUserIdx > clarifyAssistantRowIdx) return true
  const clarifyRow = rows[clarifyAssistantRowIdx]
  const clarifyTools = Array.isArray(clarifyRow?.tools) ? clarifyRow.tools : []
  // 同一行内仍有 ask 时，仅当其前面的 recon 工具不算续聊；ask 之后的工具表示问卷已走过
  if (clarifyAssistantRowIdx > lastUserIdx) {
    if (rowHasActiveAskClarificationTool(clarifyRow)) {
      if (askIsFollowedBySiblingToolsInRow(clarifyRow)) return true
      return false
    }
    if (rowHasAwaitingClarificationForm(clarifyTools)) return false
    if (rowHasSubstantiveReplyBeyondClarifyTool(clarifyRow)) return true
  }
  for (let i = clarifyAssistantRowIdx + 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row || typeof row !== 'object') continue
    if (row.role === 'user' && displayRowHasVisibleContent(row)) return true
    if (row.role !== 'assistant') continue
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
  return false
}

/** 从展示行取仍待用户处理的 ask_clarification（已确认/已续聊的会被排除） */
export function findPendingAskClarificationInRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return null
  const lastUserIdx = lastRealUserRowIndex(rows)
  for (let i = rows.length - 1; i >= 0; i--) {
    if (lastUserIdx >= 0 && i <= lastUserIdx) continue
    const row = rows[i]
    if (row?.role !== 'assistant') continue
    const tools = Array.isArray(row.tools) ? row.tools : []
    for (let j = tools.length - 1; j >= 0; j--) {
      const tool = tools[j]
      if (!isAskClarificationToolPending(tool)) continue
      if (isClarificationTurnResolvedInRows(rows, i)) continue
      return { rowIdx: i, toolIdx: j, tool }
    }
  }
  return null
}

/** 侧栏恢复：仍待用户作答的 ask（含已返回问卷 output 的 ok 态，排除已续聊/已提交） */
export function findAskClarificationAwaitingUserInRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return null
  const lastUserIdx = lastRealUserRowIndex(rows)
  for (let i = rows.length - 1; i >= 0; i--) {
    if (lastUserIdx >= 0 && i <= lastUserIdx) continue
    const row = rows[i]
    if (row?.role !== 'assistant') continue
    const tools = Array.isArray(row.tools) ? row.tools : []
    for (let j = tools.length - 1; j >= 0; j--) {
      const tool = tools[j]
      const nm = String(tool?.name || tool?.tool_name || '').toLowerCase()
      if (nm !== 'ask_clarification') continue
      if (isClarificationTurnResolvedInRows(rows, i)) continue
      return { rowIdx: i, toolIdx: j, tool }
    }
  }
  return null
}

function isCheckpointHumanMessage(msg) {
  if (!msg || typeof msg !== 'object') return false
  const role = msg.role
  const t = msg.type
  const tLower = typeof t === 'string' ? t.toLowerCase() : ''
  return role === 'user' || tLower === 'human' || tLower === 'humanmessage' || t === 'user'
}

function isAssistantCheckpointMessage(msg) {
  if (!msg || typeof msg !== 'object') return false
  const role = msg.role
  const t = msg.type
  const tLower = typeof t === 'string' ? t.toLowerCase() : ''
  if (role === 'assistant') return true
  return t === 'ai' || t === 'AIMessage' || t === 'AIMessageChunk' || t === 'assistant'
}

function assistantPlainTextFromCheckpoint(msg) {
  if (!msg || typeof msg !== 'object') return ''
  const c = msg.content
  if (typeof c === 'string') return c.trim()
  if (Array.isArray(c)) {
    return c
      .map((p) => (p && typeof p === 'object' ? String(p.text || p.content || '') : String(p || '')))
      .join('')
      .trim()
  }
  return ''
}

function findLastRealHumanIdx(messages) {
  if (!Array.isArray(messages)) return -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!isCheckpointHumanMessage(m)) continue
    if (isInjectedCheckpointHuman(m)) continue
    return i
  }
  return -1
}

function hasSubstantiveAssistantAfterCheckpoint(messages, afterIdx) {
  if (!Array.isArray(messages) || afterIdx < 0) return false
  for (let i = afterIdx + 1; i < messages.length; i++) {
    const m = messages[i]
    if (!isAssistantCheckpointMessage(m)) continue
    if (assistantPlainTextFromCheckpoint(m)) return true
    const tcs = m.tool_calls || m.toolCalls
    if (Array.isArray(tcs)) {
      for (const tc of tcs) {
        const n = String(tc?.name || tc?.function?.name || '').toLowerCase()
        if (n && n !== 'ask_clarification') return true
      }
    }
    const toolName = String(m.name || m.tool_name || '').toLowerCase()
    if (toolName && toolName !== 'ask_clarification') return true
  }
  return false
}

function isClarificationResolvedInCheckpointMessages(messages, clarifyIdx) {
  if (!Array.isArray(messages) || clarifyIdx < 0) return false
  const lastHuman = findLastRealHumanIdx(messages)
  if (lastHuman > clarifyIdx) return true
  return hasSubstantiveAssistantAfterCheckpoint(messages, clarifyIdx)
}

export function findAskClarification(messages) {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const fromAi = askClarificationFromAssistantMessage(messages[i])
    if (fromAi) return fromAi
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const fromTool = askClarificationFromToolMessage(messages[i])
    if (fromTool) return fromTool
  }
  return null
}

export function findAskClarificationAfterHuman(messages, humanIdx) {
  if (!Array.isArray(messages) || humanIdx < 0) return null
  let hit = null
  let hitIdx = -1
  for (let i = messages.length - 1; i > humanIdx; i--) {
    const fromAi = askClarificationFromAssistantMessage(messages[i])
    if (fromAi) {
      hit = fromAi
      hitIdx = i
      break
    }
  }
  if (!hit) {
    for (let i = messages.length - 1; i > humanIdx; i--) {
      const fromTool = askClarificationFromToolMessage(messages[i])
      if (fromTool) {
        hit = fromTool
        hitIdx = i
        break
      }
    }
  }
  if (!hit || hitIdx < 0) return null
  if (isClarificationResolvedInCheckpointMessages(messages, hitIdx)) return null
  return hit
}
