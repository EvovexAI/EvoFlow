/**
 * 小V 流式过程：把 AG-UI / classic chat 事件收敛成与主对话同款 tool 行，
 * 供 buildSemanticRunSteps → 对勾步骤列表复用。
 */

/**
 * @typedef {{
 *   id: string,
 *   toolCallId: string,
 *   name: string,
 *   status: string,
 *   input?: unknown,
 *   output?: unknown,
 *   argsText?: string,
 * }} XiaomiLiveTool
 */

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
function tryParseArgs(raw) {
  if (raw == null) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return /** @type {Record<string, unknown>} */ (raw)
  const s = String(raw || '').trim()
  if (!s) return {}
  try {
    const p = JSON.parse(s)
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {}
  } catch {
    return {}
  }
}

/**
 * @param {XiaomiLiveTool[]} tools
 * @param {Partial<XiaomiLiveTool> & { toolCallId?: string, id?: string }} patch
 * @returns {XiaomiLiveTool[]}
 */
export function upsertXiaomiLiveTool(tools, patch) {
  const list = Array.isArray(tools) ? tools.map((t) => ({ ...t })) : []
  const id = String(patch.toolCallId || patch.id || '').trim()
  if (!id) return list
  const idx = list.findIndex((t) => String(t.toolCallId || t.id) === id)
  const prev = idx >= 0 ? list[idx] : null
  const argsText =
    patch.argsText != null
      ? String(patch.argsText)
      : prev?.argsText != null
        ? String(prev.argsText)
        : ''
  const input =
    patch.input !== undefined
      ? patch.input
      : argsText
        ? tryParseArgs(argsText)
        : prev?.input
  /** @type {XiaomiLiveTool} */
  const next = {
    id,
    toolCallId: id,
    name: String(patch.name || prev?.name || 'tool').trim() || 'tool',
    status: String(patch.status || prev?.status || 'running').trim() || 'running',
    ...(input !== undefined ? { input } : {}),
    ...(patch.output !== undefined ? { output: patch.output } : prev?.output !== undefined ? { output: prev.output } : {}),
    ...(argsText ? { argsText } : {}),
  }
  if (idx >= 0) list[idx] = next
  else list.push(next)
  return list
}

/**
 * @param {Record<string, unknown>} ev AG-UI event
 * @param {XiaomiLiveTool[]} tools
 * @returns {{ tools: XiaomiLiveTool[], changed: boolean, reasoningDelta?: string }}
 */
export function applyXiaomiAgUiProcessEvent(ev, tools) {
  const t = String(ev?.type || '').trim()
  const list = Array.isArray(tools) ? tools : []

  if (t === 'TOOL_CALL_START') {
    const toolCallId = String(ev.toolCallId || '').trim()
    const toolCallName = String(ev.toolCallName || ev.name || 'tool').trim() || 'tool'
    if (!toolCallId) return { tools: list, changed: false }
    return {
      tools: upsertXiaomiLiveTool(list, {
        toolCallId,
        name: toolCallName,
        status: 'running',
      }),
      changed: true,
    }
  }

  if (t === 'TOOL_CALL_ARGS') {
    const toolCallId = String(ev.toolCallId || '').trim()
    if (!toolCallId) return { tools: list, changed: false }
    const prev = list.find((x) => String(x.toolCallId || x.id) === toolCallId)
    const delta = typeof ev.delta === 'string' ? ev.delta : ''
    const argsText = `${prev?.argsText || ''}${delta}`
    return {
      tools: upsertXiaomiLiveTool(list, {
        toolCallId,
        name: prev?.name,
        status: 'running',
        argsText,
        input: tryParseArgs(argsText),
      }),
      changed: true,
    }
  }

  if (t === 'TOOL_CALL_END') {
    const toolCallId = String(ev.toolCallId || '').trim()
    if (!toolCallId) return { tools: list, changed: false }
    const prev = list.find((x) => String(x.toolCallId || x.id) === toolCallId)
    return {
      tools: upsertXiaomiLiveTool(list, {
        toolCallId,
        name: prev?.name,
        status: 'running',
        argsText: prev?.argsText,
        input: prev?.input,
      }),
      changed: true,
    }
  }

  if (t === 'TOOL_CALL_RESULT') {
    const toolCallId = String(ev.toolCallId || '').trim()
    if (!toolCallId) return { tools: list, changed: false }
    const prev = list.find((x) => String(x.toolCallId || x.id) === toolCallId)
    const wireStatus = String(ev.status || '').trim().toLowerCase()
    let status = 'ok'
    if (wireStatus === 'error' || wireStatus === 'failed') status = 'error'
    else if (wireStatus === 'pending_approval' || wireStatus === 'blocked') status = 'running'
    const content = ev.content != null ? ev.content : ev.result
    return {
      tools: upsertXiaomiLiveTool(list, {
        toolCallId,
        name: prev?.name || String(ev.toolCallName || '').trim() || 'tool',
        status,
        argsText: prev?.argsText,
        input: prev?.input,
        output: content,
      }),
      changed: true,
    }
  }

  if (t === 'REASONING_MESSAGE_CONTENT' || t === 'THINKING_TEXT_MESSAGE_CONTENT') {
    const delta = typeof ev.delta === 'string' ? ev.delta : typeof ev.content === 'string' ? ev.content : ''
    if (!delta) return { tools: list, changed: false }
    return { tools: list, changed: false, reasoningDelta: delta }
  }

  return { tools: list, changed: false }
}

/**
 * Classic chat.state=tool / tool_result payloads.
 * @param {string} state
 * @param {Record<string, unknown>} payload
 * @param {XiaomiLiveTool[]} tools
 */
export function applyXiaomiClassicToolEvent(state, payload, tools) {
  const st = String(state || '').trim()
  const list = Array.isArray(tools) ? tools : []
  const p = payload && typeof payload === 'object' ? payload : {}
  const toolCallId = String(p.toolCallId || p.tool_call_id || p.id || '').trim()
  const name = String(p.name || p.toolName || p.tool_name || 'tool').trim() || 'tool'

  if (st === 'tool' || st === 'tool_call') {
    if (!toolCallId) return { tools: list, changed: false }
    const input = p.input ?? p.args ?? p.arguments
    return {
      tools: upsertXiaomiLiveTool(list, {
        toolCallId,
        name,
        status: 'running',
        input: typeof input === 'string' ? tryParseArgs(input) : input,
        argsText: typeof input === 'string' ? input : undefined,
      }),
      changed: true,
    }
  }

  if (st === 'tool_result') {
    if (!toolCallId) return { tools: list, changed: false }
    const wireStatus = String(p.status || '').trim().toLowerCase()
    let status = 'ok'
    if (wireStatus === 'error' || wireStatus === 'failed' || p.error) status = 'error'
    return {
      tools: upsertXiaomiLiveTool(list, {
        toolCallId,
        name,
        status,
        output: p.output ?? p.result ?? p.content ?? p.error,
      }),
      changed: true,
    }
  }

  if (st === 'reasoning') {
    const delta =
      typeof p.delta === 'string'
        ? p.delta
        : typeof p.text === 'string'
          ? p.text
          : typeof p.content === 'string'
            ? p.content
            : ''
    if (!delta) return { tools: list, changed: false }
    return { tools: list, changed: false, reasoningDelta: delta }
  }

  return { tools: list, changed: false }
}
