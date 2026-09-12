import { messagesToDisplayRows, normalizeTime, resolveHistoryMessageContent } from './chat-normalize.js'

function looksLikeSupervisorCreateSubtasksPayload(text) {
  const s = String(text || '').trim()
  if (!s) return false
  if (s.includes('create_task_with_subtasks')) return true
  if (s.includes('"action"') && s.includes('create_task_with_subtasks')) return true
  if (s.includes('"taskId"') && s.includes('"subtasks"') && s.includes('Task_') && s.includes('Subtask_')) {
    return true
  }
  return false
}

function toolEntryId(t) {
  return String(t?.id || t?.tool_call_id || '').trim()
}

/** 子任务弹窗是否应走主会话同款 segments 时间线（思考 / 工具 / 交错正文） */
export function rowHasStructuredTimeline(row) {
  if (!row || typeof row !== 'object') return false
  if (Array.isArray(row.tools) && row.tools.length > 0) return true
  if (String(row.reasoningPreview || '').trim()) return true
  if (
    Array.isArray(row.reasoningSegments) &&
    row.reasoningSegments.some((t) => String(t || '').trim())
  ) {
    return true
  }
  const segs = row.segments
  if (!Array.isArray(segs) || !segs.length) return false
  const kinds = new Set(segs.map((s) => s?.kind).filter(Boolean))
  if (kinds.has('reasoning') || kinds.has('tools')) return true
  if (kinds.size > 1 || segs.length > 1) return true
  return false
}

/** 为仅有 tools / reasoning 字段、无 segments 的行补时间线，供 MessageRow 折叠渲染 */
export function ensureSubtaskRowSegments(row) {
  if (!row || typeof row !== 'object') return row
  const segs = Array.isArray(row.segments) ? row.segments : []
  const tools = Array.isArray(row.tools) ? row.tools : []
  const text = String(row.text || '').trim()
  const hasTextSeg = segs.some(
    (s) => String(s?.kind || '').trim() === 'text' && String(s?.text || '').trim(),
  )

  // segments 已有工具/思考，但正文只在 row.text：补一条 text segment，否则工作过程会丢结案正文
  if (segs.length > 0) {
    if (text && !hasTextSeg) {
      return { ...row, segments: [...segs, { kind: 'text', text }] }
    }
    return row
  }

  const nextSegs = []
  const reasoningList = []
  if (Array.isArray(row.reasoningSegments)) {
    for (const t of row.reasoningSegments) {
      const s = String(t || '').trim()
      if (s) reasoningList.push(s)
    }
  }
  const preview = String(row.reasoningPreview || '').trim()
  if (!reasoningList.length && preview) reasoningList.push(preview)
  for (const body of reasoningList) {
    nextSegs.push({ kind: 'reasoning', text: body })
  }
  if (text) nextSegs.push({ kind: 'text', text })
  if (tools.length) {
    const ids = tools.map(toolEntryId).filter(Boolean)
    if (ids.length) nextSegs.push({ kind: 'tools', ids })
  }
  if (!nextSegs.length) return row
  return { ...row, segments: nextSegs }
}

/** checkpoint / execution_conversation 消息 → 子任务弹窗展示行（保留 tools + segments） */
export function messagesToSubtaskModalRows(messages) {
  if (!Array.isArray(messages)) return []
  try {
    const filtered = messages.filter((m) => {
      if (!m || typeof m !== 'object') return true
      const content = resolveHistoryMessageContent(m)
      if (typeof content === 'string' && looksLikeSupervisorCreateSubtasksPayload(content)) return false
      return true
    })
    return messagesToDisplayRows(filtered).map((row) => ensureSubtaskRowSegments(row))
  } catch {
    return []
  }
}

/**
 * Flatten display rows into one trail turn per model/tool call so the left clock
 * is per invocation (not one stamp for an entire assistant bubble).
 *
 * @param {any[]} rows
 * @returns {{ id: string, timestamp?: number | string, row: any }[]}
 */
export function expandRowsToTrailTurns(rows) {
  const out = []
  let seq = 0
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue
    const role = String(row.role || '').trim()
    if (role === 'user') {
      out.push({
        id: `user-${seq++}`,
        timestamp: row.timestamp,
        row,
      })
      continue
    }
    if (role !== 'assistant' && role !== '_stream') continue

    const tools = Array.isArray(row.tools) ? row.tools : []
    const byId = new Map()
    for (const t of tools) {
      const id = toolEntryId(t)
      if (id) byId.set(id, t)
    }
    const segs = Array.isArray(row.segments) ? row.segments : []
    const usedToolIds = new Set()
    let emitted = false

    const pushTextTurn = (text, kind = 'text') => {
      const body = String(text || '').trim()
      if (!body) return
      emitted = true
      // Keep content only in segments (not also in text) — SubtaskModalMessageRow
      // used to join text+segments and show the same paragraph twice.
      out.push({
        id: `${kind}-${seq++}`,
        timestamp: row.timestamp,
        row: {
          role: 'assistant',
          text: '',
          tools: [],
          timestamp: row.timestamp,
          ...(kind === 'reasoning'
            ? { reasoningPreview: body, segments: [{ kind: 'reasoning', text: body }] }
            : { segments: [{ kind: 'text', text: body }] }),
        },
      })
    }

    const pushToolTurn = (tool) => {
      if (!tool) return
      const id = toolEntryId(tool)
      if (id) {
        if (usedToolIds.has(id)) return
        usedToolIds.add(id)
      }
      const ts = normalizeTime(tool.time || tool.messageTimestamp) ?? row.timestamp
      emitted = true
      out.push({
        id: `tool-${id || seq++}`,
        timestamp: ts,
        row: {
          role: 'assistant',
          text: '',
          tools: [tool],
          timestamp: ts,
          segments: id ? [{ kind: 'tools', ids: [id] }] : undefined,
        },
      })
    }

    if (segs.length) {
      for (const seg of segs) {
        const kind = String(seg?.kind || '').trim()
        if (kind === 'text' || kind === 'reasoning') {
          pushTextTurn(seg?.text, kind)
          continue
        }
        if (kind === 'tools') {
          const ids = Array.isArray(seg?.ids) ? seg.ids : []
          for (const rawId of ids) {
            const id = String(rawId || '').trim()
            pushToolTurn(byId.get(id) || tools.find((t) => toolEntryId(t) === id))
          }
        }
      }
      for (const t of tools) pushToolTurn(t)
      // History merge often keeps final body on row.text while segments only have tools.
      const rowText = String(row.text || '').trim()
      if (rowText) {
        const covered = segs.some((seg) => {
          if (String(seg?.kind || '').trim() !== 'text') return false
          const t = String(seg?.text || '').trim()
          if (!t) return false
          return t === rowText || rowText.startsWith(t) || t.startsWith(rowText) || rowText.includes(t.slice(0, 48))
        })
        if (!covered) pushTextTurn(rowText, 'text')
      }
    } else {
      if (String(row.reasoningPreview || '').trim()) {
        pushTextTurn(row.reasoningPreview, 'reasoning')
      }
      pushTextTurn(row.text, 'text')
      for (const t of tools) pushToolTurn(t)
    }

    if (!emitted) {
      out.push({
        id: `row-${seq++}`,
        timestamp: row.timestamp,
        row,
      })
    }
  }
  return out
}
