/**
 * DB-first stream resume: anchor persisted turn text + tool_call ids so mirror/attach
 * only append content not yet in evoflow_chat_messages.
 */
import { extractContent } from './chat-normalize.js'

function isHumanMessage(m) {
  if (!m || typeof m !== 'object') return false
  const role = String(m.role || m.type || '').toLowerCase()
  return role === 'user' || role === 'human' || role === 'humanmessage'
}

function isAssistantMessage(m) {
  if (!m || typeof m !== 'object') return false
  const role = String(m.role || m.type || '').toLowerCase()
  return role === 'assistant' || role === 'ai' || role === 'aimessage' || role === 'aimessagechunk'
}

function isToolMessage(m) {
  if (!m || typeof m !== 'object') return false
  const role = String(m.role || m.type || '').toLowerCase()
  return role === 'tool'
}

function findLastUserIndex(messages) {
  if (!Array.isArray(messages)) return -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return i
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isHumanMessage(messages[i])) return i
  }
  return -1
}

function mergeTurnAssistantTexts(texts) {
  if (!Array.isArray(texts) || !texts.length) return ''
  let acc = String(texts[0] || '').trim()
  for (let i = 1; i < texts.length; i++) {
    const next = String(texts[i] || '').trim()
    if (!next) continue
    if (!acc) {
      acc = next
      continue
    }
    if (next.startsWith(acc)) acc = next
    else if (acc.startsWith(next)) continue
    else if (acc.replace(/\s+/g, ' ').includes(next.replace(/\s+/g, ' '))) continue
    else if (next.replace(/\s+/g, ' ').includes(acc.replace(/\s+/g, ' '))) acc = next
    else acc = [acc, next].filter(Boolean).join('\n\n')
  }
  return acc.trim()
}

function collectToolCallIdsFromRawMessage(m) {
  const ids = []
  const tc = m?.tool_calls || m?.toolCalls
  if (Array.isArray(tc)) {
    for (const c of tc) {
      const id = c?.id || c?.tool_call_id
      if (id != null && String(id).trim()) ids.push(String(id).trim())
    }
  }
  const direct = m?.tool_call_id || m?.toolCallId
  if (direct != null && String(direct).trim()) ids.push(String(direct).trim())
  return ids
}

function collectToolCallIdsFromDisplayRow(row) {
  const ids = []
  const tools = Array.isArray(row?.tools) ? row.tools : []
  for (const t of tools) {
    const id = t?.id || t?.tool_call_id || t?.toolCallId
    if (id != null && String(id).trim()) ids.push(String(id).trim())
  }
  return ids
}

function messageRunId(m) {
  return String(m?.run_id || m?.runId || '').trim()
}

function rowRunId(row) {
  return String(row?.runId || row?.run_id || '').trim()
}

/**
 * @param {unknown[]} messages Raw DB / LangGraph messages
 * @param {{ runId?: string | null }} [opts]
 */
export function buildTranscriptResumeAnchorFromRawMessages(messages, opts = {}) {
  const msgs = Array.isArray(messages) ? messages : []
  const wantedRunId = String(opts.runId || '').trim()
  const userIdx = findLastUserIndex(msgs)
  if (userIdx < 0) {
    return { persistedTurnText: '', persistedToolCallIds: [] }
  }

  const toolIds = new Set()
  const assistantTexts = []
  for (let i = userIdx + 1; i < msgs.length; i++) {
    const m = msgs[i]
    const rid = messageRunId(m)
    if (wantedRunId && rid && rid !== wantedRunId) continue
    if (isAssistantMessage(m)) {
      const c = extractContent(m)
      const text = String(c?.text || '').trim()
      if (text) assistantTexts.push(text)
      for (const id of collectToolCallIdsFromRawMessage(m)) toolIds.add(id)
    } else if (isToolMessage(m)) {
      for (const id of collectToolCallIdsFromRawMessage(m)) toolIds.add(id)
    }
  }

  return {
    persistedTurnText: mergeTurnAssistantTexts(assistantTexts),
    persistedToolCallIds: [...toolIds],
  }
}

/**
 * @param {import('../react/chat-types.ts').DisplayRow[]} rows
 * @param {{ runId?: string | null }} [opts]
 */
export function buildTranscriptResumeAnchorFromDisplayRows(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : []
  const wantedRunId = String(opts.runId || '').trim()
  const userIdx = findLastUserIndex(list)
  if (userIdx < 0) {
    return { persistedTurnText: '', persistedToolCallIds: [] }
  }

  const toolIds = new Set()
  const assistantTexts = []
  for (let i = userIdx + 1; i < list.length; i++) {
    const row = list[i]
    if (row?.role === '_stream') continue
    const rid = rowRunId(row)
    if (wantedRunId && rid && rid !== wantedRunId) continue
    if (row?.role === 'assistant') {
      const text = String(row?.text || '').trim()
      if (text) assistantTexts.push(text)
      for (const id of collectToolCallIdsFromDisplayRow(row)) toolIds.add(id)
    }
  }

  return {
    persistedTurnText: mergeTurnAssistantTexts(assistantTexts),
    persistedToolCallIds: [...toolIds],
  }
}

/** @param {Record<string, unknown> | null | undefined} lane */
export function applyTranscriptResumeAnchorToLane(lane, anchor) {
  if (!lane || !anchor || typeof anchor !== 'object') return
  const baseline = String(anchor.persistedTurnText || '')
  // 单调性保护：已 lock 的基线不允许被更短文本覆盖。
  // 仅用于 mirror/values 增量剥离；不写入 finalText，避免续流 UI 重放整段已落库正文。
  const prevBaseline = String(lane.valuesBaselineText || '')
  const prevLocked = lane.valuesBaselineLocked === true
  if (baseline) {
    const accept = !prevLocked || baseline.length >= prevBaseline.length
    if (accept) {
      lane.transcriptAnchorText = baseline
      lane.valuesBaselineText = baseline
      lane.valuesBaselineLocked = true
    }
  }
  const ids = Array.isArray(anchor.persistedToolCallIds) ? anchor.persistedToolCallIds : []
  if (ids.length) {
    // 合并而非替换：服务端 anchor 与客户端 anchor 都可能携带不同子集的 tool ids，
    // 保留已知的全部 id 才能避免续流时把已落库工具行重复 render。
    const prevSet = lane.persistedToolCallIds instanceof Set ? lane.persistedToolCallIds : null
    const next = new Set(prevSet ? prevSet : [])
    for (const id of ids) {
      const s = String(id || '').trim()
      if (s) next.add(s)
    }
    lane.persistedToolCallIds = next
  } else if (!(lane.persistedToolCallIds instanceof Set)) {
    lane.persistedToolCallIds = new Set()
  }
}

/** @param {Record<string, unknown> | null | undefined} lane */
export function laneShouldSkipPersistedTool(lane, toolCallId) {
  const id = String(toolCallId || '').trim()
  if (!id || !lane?.persistedToolCallIds?.size) return false
  return lane.persistedToolCallIds.has(id)
}
