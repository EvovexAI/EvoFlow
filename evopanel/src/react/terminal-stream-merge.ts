import type { TerminalStreamTask } from './chat-types.js'

const OUT_CAP = 500_000
const CHUNK_CAP = 2000

export function isTerminalStreamEvent(ev: Record<string, unknown>): boolean {
  const t = String(ev.type || '').trim()
  return (
    t === 'terminal_start' ||
    t === 'terminal_stdout' ||
    t === 'terminal_stderr' ||
    t === 'terminal_exit'
  )
}

function appendTerminalOutputChunk(
  ts: TerminalStreamTask,
  stream: 'stdout' | 'stderr',
  text: string,
): void {
  if (!text) return
  if (stream === 'stdout') {
    ts.stdout = (String(ts.stdout || '') + text).slice(-OUT_CAP)
  } else {
    ts.stderr = (String(ts.stderr || '') + text).slice(-OUT_CAP)
  }
  if (!ts.chunks) ts.chunks = []
  ts.chunks.push({ stream, text })
  if (ts.chunks.length > CHUNK_CAP) {
    ts.chunks.splice(0, ts.chunks.length - CHUNK_CAP)
  }
}

function emptyTask(toolCallId: string, invocationId?: string): TerminalStreamTask {
  return {
    toolCallId,
    ...(invocationId ? { invocationId } : {}),
    phase: 'running',
    command: '',
    stdout: '',
    stderr: '',
    chunks: [],
    startedAt: Date.now(),
  }
}

/** Deep-clone one terminal stream task so completed panels never pick up live mutations. */
export function cloneTerminalStreamTask(task: TerminalStreamTask): TerminalStreamTask {
  return {
    ...task,
    chunks: task.chunks ? task.chunks.map((c) => ({ ...c })) : [],
  }
}

/**
 * Freeze _terminalStream → _terminalData on every tool in the array.
 * After this, resolved rows read _terminalData (immutable snapshot) instead
 * of _terminalStream (live object that keeps mutating on SSE events).
 * Call this once in the `final` event handler before persisting the row.
 */
export function freezeTerminalDataOnTools(tools: unknown[]): void {
  for (const t of tools) {
    const tool = t as Record<string, unknown>
    const stream = tool._terminalStream as TerminalStreamTask | undefined
    if (stream) {
      tool._terminalData = cloneTerminalStreamTask(stream)
      delete tool._terminalStream
    }
  }
}

/** Deep-clone the per-turn terminal stream map (for persisting assistant rows). */
export function cloneTerminalStreamsMap(
  map: Record<string, TerminalStreamTask> | undefined,
): Record<string, TerminalStreamTask> | undefined {
  if (!map || !Object.keys(map).length) return undefined
  const out: Record<string, TerminalStreamTask> = {}
  for (const [k, v] of Object.entries(map)) {
    out[k] = cloneTerminalStreamTask(v)
  }
  return out
}

/** Merge terminal_* SSE events into tool._terminalStream directly (per-tool isolation). */
export function mergeTerminalIntoTool(
  tool: Record<string, unknown>,
  ev: Record<string, unknown>,
): void {
  const type = String(ev.type || '').trim()
  if (!type || !isTerminalStreamEvent(ev)) return
  const toolCallId = String(tool.tool_call_id || tool.id || '').trim()
  const evTcId = String(ev.tool_call_id || ev.toolCallId || '').trim()
  if (!toolCallId || !evTcId || toolCallId !== evTcId) return

  let ts = tool._terminalStream as TerminalStreamTask | undefined
  if (!ts) {
    const invocationId = String(ev.invocation_id || ev.invocationId || '').trim()
    ts = emptyTask(toolCallId, invocationId || undefined)
    tool._terminalStream = ts
  }

  if (type === 'terminal_start') {
    ts.command = String(ev.command || ts.command || '')
    ts.phase = 'running'
    ts.startedAt = ts.startedAt || Date.now()
    return
  }

  if (type === 'terminal_stdout') {
    appendTerminalOutputChunk(ts, 'stdout', String(ev.text || ''))
    ts.phase = 'running'
    return
  }

  if (type === 'terminal_stderr') {
    appendTerminalOutputChunk(ts, 'stderr', String(ev.text || ''))
    ts.phase = 'running'
    return
  }

  if (type === 'terminal_exit') {
    const exitRaw = ev.exit_code ?? ev.exitCode
    const exitCode = typeof exitRaw === 'number' ? exitRaw : Number(exitRaw)
    ts.exitCode = Number.isFinite(exitCode) ? exitCode : undefined
    ts.success = ev.success === true || ts.exitCode === 0
    ts.phase = ts.success ? 'success' : 'failed'
    ts.endedAt = Date.now()
    tool._terminalStream = cloneTerminalStreamTask(ts)
    tool.status = ts.success ? 'ok' : 'error'
  }
}

/** Resolve stream task for a tool row — prefer frozen _terminalData, then live _terminalStream, then map. */
export function resolveTerminalStreamTask(
  terminalStreams: Record<string, TerminalStreamTask> | undefined,
  tool: Record<string, unknown>,
): TerminalStreamTask | undefined {
  // 1) 优先使用 final 时冻结的快照（完全隔离，不随 S.turn.tools 变化）
  const frozen = tool._terminalData as TerminalStreamTask | undefined
  if (frozen) return frozen

  // 2) 其次使用实时流数据（仅流式 _stream 行有，持久化行 final 时已清除）
  const inline = tool._terminalStream as TerminalStreamTask | undefined
  if (inline) return inline

  if (!terminalStreams) return undefined

  const rtc =
    tool.tool_call_id != null && String(tool.tool_call_id).trim() !== ''
      ? String(tool.tool_call_id).trim()
      : ''

  // When tool_call_id is present, never fall back to tool.id — LangGraph message ids
  // often differ from call ids and would cross-wire a completed panel to a new stream.
  if (rtc) {
    // Direct key lookup (map may be keyed by invocation_id or tool_call_id)
    if (terminalStreams[rtc]) return terminalStreams[rtc]
    // Scan by toolCallId field for entries keyed by invocation_id
    for (const task of Object.values(terminalStreams)) {
      if (task.toolCallId === rtc) return task
    }
    return undefined
  }

  const rid = tool.id != null && String(tool.id).trim() !== '' ? String(tool.id).trim() : ''
  if (rid && terminalStreams[rid]) return terminalStreams[rid]
  return undefined
}

/** UI 展示用：去掉网关注入的 Console 编码前缀，保留真实用户命令。 */
export function stripTerminalHarnessCommand(command: string): string {
  let cmd = String(command || '').trim()
  if (!cmd) return ''
  cmd = cmd.replace(
    /^\[Console\]::OutputEncoding\s*=\s*\[System\.Text\.UTF8Encoding\]::new\(\$false\);\s*\$OutputEncoding\s*=\s*\[Console\]::OutputEncoding;\s*/i,
    '',
  )
  return cmd.trim()
}

/** 终端折叠摘要：优先 terminal_start 的权威命令，再回退 tool args。 */
export function pickTerminalDisplayCommand(
  terminalStream: TerminalStreamTask | undefined | null,
  rawInput: unknown,
  inputObj: Record<string, unknown> | null | undefined,
  extractShell: (raw: unknown, parsed: Record<string, unknown> | null | undefined) => string | null,
): string | null {
  const fromStream =
    typeof terminalStream?.command === 'string' && terminalStream.command.trim()
      ? stripTerminalHarnessCommand(terminalStream.command.trim())
      : null
  if (fromStream) return fromStream
  return (
    extractShell(rawInput, inputObj) ||
    (typeof inputObj?.command === 'string' && inputObj.command.trim() ? inputObj.command.trim() : null) ||
    (typeof rawInput === 'string' && !String(rawInput).trim().startsWith('{') ? String(rawInput).trim() : null)
  )
}

/** Merge terminal_* custom SSE events into a map keyed by invocation_id (fallback tool_call_id). */
export function mergeTerminalStreamEvent(
  map: Record<string, TerminalStreamTask>,
  ev: Record<string, unknown>,
): void {
  const type = String(ev.type || '').trim()
  const toolCallId = String(ev.tool_call_id || ev.toolCallId || '').trim()
  const invocationId = String(ev.invocation_id || ev.invocationId || '').trim()
  if (!toolCallId || !isTerminalStreamEvent(ev)) return

  // Primary key: invocation_id if available, otherwise tool_call_id
  const key = invocationId || toolCallId

  let cur = map[key]
  if (!cur) {
    cur = emptyTask(toolCallId, invocationId || undefined)
    map[key] = cur
  }

  if (type === 'terminal_start') {
    cur.command = String(ev.command || cur.command || '')
    cur.phase = 'running'
    cur.startedAt = cur.startedAt || Date.now()
    return
  }

  if (type === 'terminal_stdout') {
    appendTerminalOutputChunk(cur, 'stdout', String(ev.text || ''))
    cur.phase = 'running'
    return
  }

  if (type === 'terminal_stderr') {
    appendTerminalOutputChunk(cur, 'stderr', String(ev.text || ''))
    cur.phase = 'running'
    return
  }

  if (type === 'terminal_exit') {
    const exitRaw = ev.exit_code ?? ev.exitCode
    const exitCode = typeof exitRaw === 'number' ? exitRaw : Number(exitRaw)
    cur.exitCode = Number.isFinite(exitCode) ? exitCode : undefined
    cur.success = ev.success === true || cur.exitCode === 0
    cur.phase = cur.success ? 'success' : 'failed'
    cur.endedAt = Date.now()
    map[key] = cloneTerminalStreamTask(cur)
  }
}
