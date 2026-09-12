/**
 * Flat transcript rows for ``evoflow_chat_messages`` (no nested message JSON).
 */
import {
  isCompactionUiMessage,
  isInjectedCheckpointHuman,
  normalizeUsage,
  pickUsageObject,
  serializeToolCallArgsForPersist,
  serializeToolCallsForPersist,
} from './chat-normalize.js'

function newTranscriptMessageId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  } catch {
    /* ignore */
  }
  return `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function normalizePersistText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
}

function isHumanMessage(m) {
  if (!m || typeof m !== 'object') return false
  if (m.role === 'user') return true
  const t = String(m.type || '').trim()
  return t === 'human' || t === 'HumanMessage' || t === 'HumanMessageChunk'
}

function isAssistantMessage(m) {
  if (!m || typeof m !== 'object') return false
  if (m.role === 'assistant') return true
  const t = String(m.type || '').trim()
  return t === 'ai' || t === 'AIMessage' || t === 'AIMessageChunk'
}

function isToolMessage(m) {
  if (!m || typeof m !== 'object') return false
  if (m.role === 'tool') return true
  const t = String(m.type || '').trim().toLowerCase()
  return t === 'tool' || t === 'toolmessage' || t === 'tool_message'
}

function findLastNonCollabHumanIndex(messages) {
  if (!Array.isArray(messages)) return -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!isHumanMessage(m)) continue
    if (isInjectedCheckpointHuman(m)) continue
    return i
  }
  return -1
}

function extractContentText(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = []
    for (const item of content) {
      if (typeof item === 'string') parts.push(item)
      else if (item && typeof item === 'object') {
        if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
        else if (typeof item.text === 'string') parts.push(item.text)
      }
    }
    return parts.join('\n').trim()
  }
  if (typeof content === 'object' && content.type === 'text' && typeof content.text === 'string') {
    return content.text.trim()
  }
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

/** Merge streaming reasoning snapshots (delta pieces may start with spaces). */
function mergeReasoningPersistText(last, incoming) {
  const r = String(incoming ?? '')
  if (!r) return String(last ?? '')
  const prev = String(last ?? '')
  if (!prev) return r
  if (r.startsWith(prev)) return r
  if (prev.startsWith(r)) return prev
  const maxCheck = Math.min(prev.length, r.length, 800)
  for (let n = maxCheck; n >= 8; n--) {
    if (prev.slice(-n) === r.slice(0, n)) return prev + r.slice(n)
  }
  return prev + r
}

function pickReasoningText(msg) {
  const cj = msg?.contentJson ?? msg?.content_json
  if (cj && typeof cj === 'object' && typeof cj.reasoning === 'string' && cj.reasoning) {
    return cj.reasoning.slice(0, 8000)
  }
  const ak = msg?.additional_kwargs
  if (ak && typeof ak.reasoning_content === 'string' && ak.reasoning_content) {
    return ak.reasoning_content.slice(0, 8000)
  }
  const content = msg?.content
  if (Array.isArray(content)) {
    const think = content.find((p) => p && p.type === 'thinking' && typeof p.thinking === 'string')
    if (think?.thinking) return think.thinking.slice(0, 8000)
  }
  return null
}

function pickModelName(msg) {
  if (typeof msg?.model_name === 'string' && msg.model_name.trim()) return msg.model_name.trim()
  const rm = msg?.response_metadata
  if (rm && typeof rm.model_name === 'string' && rm.model_name.trim()) return rm.model_name.trim()
  if (rm && typeof rm.model === 'string' && rm.model.trim()) return rm.model.trim()
  return null
}

function pickTokenCounts(msg) {
  const nested = pickUsageObject(msg)
  const flat = {}
  for (const [src, dst] of [
    ['input_tokens', 'input_tokens'],
    ['inputTokens', 'input_tokens'],
    ['output_tokens', 'output_tokens'],
    ['outputTokens', 'output_tokens'],
    ['total_tokens', 'total_tokens'],
    ['totalTokens', 'total_tokens'],
    ['cache_read_tokens', 'cache_read_tokens'],
    ['cacheReadTokens', 'cache_read_tokens'],
    ['cache_creation_tokens', 'cache_creation_tokens'],
    ['cacheCreationTokens', 'cache_creation_tokens'],
    ['cache_miss_tokens', 'cache_miss_tokens'],
    ['cacheMissTokens', 'cache_miss_tokens'],
  ]) {
    if (msg?.[src] != null) flat[dst] = msg[src]
  }
  const usage = nested ? { ...nested, ...flat } : flat
  const norm = normalizeUsage(usage)
  if (!norm) {
    return {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      cacheMissTokens: null,
    }
  }
  return {
    inputTokens: norm.input_tokens,
    outputTokens: norm.output_tokens,
    totalTokens: norm.total_tokens,
    cacheReadTokens: norm.cache_read_tokens || null,
    cacheCreationTokens: norm.cache_creation_tokens || null,
    cacheMissTokens: norm.cache_miss_tokens || null,
  }
}

function buildContentJsonFromMessage(msg) {
  if (!msg || typeof msg !== 'object') return { content: '' }
  if (msg.contentJson && typeof msg.contentJson === 'object') return msg.contentJson
  if (msg.content_json && typeof msg.content_json === 'object') return msg.content_json
  const payload = {}
  const content = msg.content
  if (content != null) payload.content = content
  else payload.content = ''
  const toolCalls = msg.tool_calls || msg.toolCalls
  if (Array.isArray(toolCalls) && toolCalls.length) {
    payload.tool_calls = serializeToolCallsForPersist(toolCalls)
  }
  const reasoning = pickReasoningText(msg)
  if (reasoning) payload.reasoning = reasoning
  return payload
}

function contentPlainText(contentJson) {
  if (!contentJson || typeof contentJson !== 'object') return ''
  return extractContentText(contentJson.content)
}

/**
 * LangGraph / stream message → API body for POST /messages or /messages/batch.
 */
export function messageToFlatTranscriptRow(msg) {
  if (!msg || typeof msg !== 'object') return null
  if (isInjectedCheckpointHuman(msg)) return null
  let role = String(msg.role || '').toLowerCase()
  if (!role) {
    const t = String(msg.type || '').trim().toLowerCase()
    if (t === 'human' || t === 'humanmessage') role = 'user'
    else if (t === 'ai' || t === 'aimessage') role = 'assistant'
    else if (t === 'tool' || t === 'toolmessage') role = 'tool'
    else role = 'assistant'
  }
  const contentJson = buildContentJsonFromMessage(msg)
  const {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheMissTokens,
  } = pickTokenCounts(msg)
  const runId =
    msg.run_id || msg.runId || msg.response_metadata?.run_id || msg.response_metadata?.runId || null
  return {
    role,
    messageId: msg.id || msg.message_id || null,
    runId: runId != null && String(runId).trim() ? String(runId).trim() : null,
    contentJson,
    toolCallId: msg.tool_call_id || msg.toolCallId || null,
    toolName: msg.name || msg.tool_name || null,
    modelName: pickModelName(msg),
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheMissTokens,
  }
}

function mergeAssistantPersistRow(last, row) {
  const prev = normalizePersistText(contentPlainText(last.contentJson))
  const next = normalizePersistText(contentPlainText(row.contentJson))
  if (!prev) {
    Object.assign(last, row)
    return
  }
  if (!next) {
    if (row.contentJson?.reasoning) {
      last.contentJson = last.contentJson || { content: '' }
      last.contentJson.reasoning = mergeReasoningPersistText(last.contentJson.reasoning, row.contentJson.reasoning)
    }
    return
  }
  if (next === prev) {
    if (row.messageId && !last.messageId) last.messageId = row.messageId
    if (row.contentJson?.reasoning) {
      last.contentJson = last.contentJson || { content: '' }
      last.contentJson.reasoning = mergeReasoningPersistText(last.contentJson.reasoning, row.contentJson.reasoning)
    }
    return
  }
  if (next.startsWith(prev)) {
    Object.assign(last, row)
    return
  }
  if (prev.startsWith(next)) {
    if (row.messageId && !last.messageId) last.messageId = row.messageId
    return
  }
  // Non-prefix content for same-message snapshots (rare: content rewrite).
  // Take the newer snapshot but preserve accumulated reasoning.
  // Do NOT concatenate — that would duplicate text across different messages.
  const prevReasoning = last.contentJson?.reasoning
  Object.assign(last, row)
  if (prevReasoning && (!last.contentJson || !last.contentJson.reasoning)) {
    last.contentJson = last.contentJson || { content: '' }
    last.contentJson.reasoning = prevReasoning
  }
}

/** Collapse streaming assistant snapshots + dedupe by messageId before batch persist.
 *
 * Only rows with the **same messageId** are merged (they are streaming snapshots
 * of one AIMessage).  Rows with **different** messageIds are independent
 * assistant messages (e.g. plan → tools → body across multiple model calls) and
 * must remain separate rows — merging them would accumulate content into one row.
 *
 * Edge case: rows with **no messageId** (some vendors / middleware-injected
 * messages lack ``id``).  Two consecutive no-id assistant rows are merged only
 * if their content is a prefix relationship (same message, different snapshot).
 * Otherwise they stay separate (different messages that happen to lack id).
 */
export function mergeTurnRowsForPersist(rows) {
  if (!Array.isArray(rows) || !rows.length) return []
  const out = []
  const indexByMessageId = new Map()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const mid = row.messageId ? String(row.messageId) : ''
    if (mid && indexByMessageId.has(mid)) {
      mergeAssistantPersistRow(out[indexByMessageId.get(mid)], row)
      continue
    }
    // No messageId: check if the last output row is a prefix-snapshot of the
    // same message (both assistant, both no messageId, content is prefix-related).
    if (!mid) {
      const last = out[out.length - 1]
      if (
        last &&
        last.role === 'assistant' &&
        row.role === 'assistant' &&
        !last.messageId
      ) {
        const prevText = normalizePersistText(contentPlainText(last.contentJson))
        const nextText = normalizePersistText(contentPlainText(row.contentJson))
        if (prevText && nextText && (nextText.startsWith(prevText) || prevText.startsWith(nextText))) {
          mergeAssistantPersistRow(last, row)
          continue
        }
      }
    }
    out.push({ ...row })
    if (mid) indexByMessageId.set(mid, out.length - 1)
  }
  return out
}

/** Messages after last human in this turn (skip user — already appended at send start). */
export function sliceTurnMessagesForPersist(messages) {
  if (!Array.isArray(messages) || !messages.length) return []
  const humanIdx = findLastNonCollabHumanIndex(messages)
  if (humanIdx < 0) return []
  const raw = []
  for (let i = humanIdx + 1; i < messages.length; i++) {
    const m = messages[i]
    if (!m || typeof m !== 'object') continue
    if (isCompactionUiMessage(m)) continue
    if (m.name === 'collab_phase_hint') continue
    if (isHumanMessage(m)) continue
    if (!isAssistantMessage(m) && !isToolMessage(m)) continue
    const row = messageToFlatTranscriptRow(m)
    if (row) raw.push(row)
  }
  return mergeTurnRowsForPersist(raw)
}

/** Collect reasoning text from assistant messages after the last user turn. */
export function extractReasoningFromTurnMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    return { reasoningSegments: [], reasoningPreview: null }
  }
  const humanIdx = findLastNonCollabHumanIndex(messages)
  const slice = humanIdx >= 0 ? messages.slice(humanIdx + 1) : messages
  const segments = []
  for (const m of slice) {
    const row = messageToFlatTranscriptRow(m)
    const text = row?.contentJson?.reasoning ? String(row.contentJson.reasoning) : ''
    if (text) segments.push(text)
  }
  const deduped = []
  for (const seg of segments) {
    if (!deduped.length || deduped[deduped.length - 1] !== seg) deduped.push(seg)
  }
  return {
    reasoningSegments: deduped,
    reasoningPreview: deduped.length ? deduped.join('\n\n').slice(0, 8000) : null,
  }
}

/**
 * Stamp run / model / usage / reasoning onto flat rows before POST (per-message, not batch-only).
 */
export function stampTurnRowsForPersist(rows, { runId, modelName, usage, reasoningPreview, reasoningSegments } = {}) {
  if (!Array.isArray(rows) || !rows.length) return rows
  const rid = runId != null && String(runId).trim() ? String(runId).trim() : null
  const model = modelName != null && String(modelName).trim() ? String(modelName).trim() : null
  const usageObj = usage && typeof usage === 'object' ? usage : null
  const inputTokens =
    usageObj != null
      ? Number(usageObj.input_tokens ?? usageObj.inputTokens ?? 0) || null
      : null
  const outputTokens =
    usageObj != null
      ? Number(usageObj.output_tokens ?? usageObj.outputTokens ?? 0) || null
      : null
  const totalTokens =
    usageObj != null
      ? Number(usageObj.total_tokens ?? usageObj.totalTokens ?? 0) || null
      : null
  const out = rows.map((row) => {
    const next = { ...row }
    if (rid) next.runId = next.runId || rid
    if (model && !next.modelName) next.modelName = model
    return next
  })
  const lastAssistant = [...out].reverse().find((r) => r && r.role === 'assistant')
  const reasoningSegs =
    Array.isArray(reasoningSegments) && reasoningSegments.length
      ? reasoningSegments.map((t) => String(t || '')).filter(Boolean)
      : []
  // Only stamp the **last** reasoning segment onto the last assistant row.
  // Joining all segments would accumulate reasoning from multiple model calls
  // into one row, duplicating content across turns.
  const reasoningText =
    typeof reasoningPreview === 'string' && reasoningPreview
      ? reasoningPreview.slice(0, 8000)
      : reasoningSegs.length
        ? reasoningSegs[reasoningSegs.length - 1].slice(0, 8000)
        : null
  if (lastAssistant) {
    if (inputTokens != null) lastAssistant.inputTokens = inputTokens
    if (outputTokens != null) lastAssistant.outputTokens = outputTokens
    if (totalTokens != null) lastAssistant.totalTokens = totalTokens
    lastAssistant.contentJson = lastAssistant.contentJson || { content: '' }
    // Only set reasoning if the row doesn't already have one (from its own snapshot).
    if (reasoningText && !lastAssistant.contentJson.reasoning) {
      lastAssistant.contentJson.reasoning = reasoningText
    }
  }
  return out
}

export function userBlocksToFlatTranscriptRow(blocks, messageId = undefined, meta = undefined) {
  const content = Array.isArray(blocks) ? blocks : []
  const mid =
    messageId != null && String(messageId).trim()
      ? String(messageId).trim()
      : newTranscriptMessageId()
  const m = meta && typeof meta === 'object' ? meta : {}
  const rid = m.runId != null && String(m.runId).trim() ? String(m.runId).trim() : null
  const model = m.modelName != null && String(m.modelName).trim() ? String(m.modelName).trim() : null
  const ctxFiles = Array.isArray(m.contextFiles)
    ? m.contextFiles
        .map((f) => ({
          path: String(f?.path || '').trim(),
          name: String(f?.name || f?.path || '').trim(),
        }))
        .filter((f) => f.path)
    : []
  const contentJson = { content: content.length ? content : extractContentText(content) }
  if (ctxFiles.length) contentJson.contextFiles = ctxFiles
  return {
    role: 'user',
    messageId: mid,
    contentJson,
    toolCallId: null,
    toolName: null,
    modelName: model,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    runId: rid,
  }
}
